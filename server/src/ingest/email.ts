/**
 * Email ingestion: RFC 822 / MIME messages (.eml — Gmail "Download message", Outlook
 * "Save as") and mbox archives (Gmail Google Takeout). Messages are grouped into threads
 * (normalized subject + References/In-Reply-To), one document per thread, one segment per
 * message with the sender as speaker. Quoted reply history is stripped so each message
 * contributes only what it actually said; attachments are listed in metadata.
 */
import type { ParsedDoc, Segment } from "./parsers.js";

export interface EmailMessage {
  headers: Record<string, string>;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  subject: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  text: string;
  attachments: string[];
  client?: string;
}

// ---------- low-level MIME helpers ----------
function splitHeadBody(raw: string): [string, string] {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return [raw, ""];
  return [raw.slice(0, m.index), raw.slice(m.index + m[0].length)];
}

function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    out[k] = out[k] ? `${out[k]}, ${v}` : v; // repeated headers (Received, etc.) are concatenated
  }
  return out;
}

function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^"|"$/g, ""), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const binaryString = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);

function decodeQP(s: string): Uint8Array {
  const clean = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "=" && /^[0-9A-F]{2}$/i.test(clean.slice(i + 1, i + 3))) {
      out.push(parseInt(clean.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(clean.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

/** RFC 2047 encoded words: =?utf-8?B?...?= / =?iso-8859-1?Q?...?= */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, cs, enc, data) => {
    const bytes = enc.toUpperCase() === "B" ? Uint8Array.from(Buffer.from(data, "base64")) : decodeQP(data.replace(/_/g, " "));
    return decodeBytes(bytes, cs);
  });
}

function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const m = header.match(new RegExp(`${name}\\*?=("([^"]*)"|[^;\\s]+)`, "i"));
  return m ? (m[2] ?? m[1]).replace(/^"|"$/g, "") : undefined;
}

function decodePart(body: string, headers: Record<string, string>): string {
  const enc = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  const charset = param(headers["content-type"], "charset") ?? "utf-8";
  if (enc === "base64") return decodeBytes(Uint8Array.from(Buffer.from(body.replace(/\s+/g, ""), "base64")), charset);
  if (enc === "quoted-printable") return decodeBytes(decodeQP(body), charset);
  return decodeBytes(binaryString(body), charset);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "") // quoted history (Gmail/Apple Mail)
    .replace(/<div[^>]*class="?[^">]*(gmail_quote|OutlookMessageHeader)[\s\S]*$/i, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Walk a MIME tree; prefer text/plain, fall back to text/html; collect attachment names. */
function extractBody(head: Record<string, string>, body: string, acc: { plain: string[]; html: string[]; attachments: string[] }) {
  const ctype = (head["content-type"] ?? "text/plain").toLowerCase();
  const disposition = head["content-disposition"] ?? "";
  const filename = param(disposition, "filename") ?? param(head["content-type"], "name");
  if (ctype.startsWith("multipart/")) {
    const boundary = param(head["content-type"], "boundary");
    if (!boundary) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\s*\\r?\\n?`));
    for (const p of parts) {
      if (!p.trim()) continue;
      const [h, b] = splitHeadBody(p);
      extractBody(parseHeaders(h), b, acc);
    }
    return;
  }
  if (/attachment/i.test(disposition) || (filename && !ctype.startsWith("text/"))) {
    if (filename) acc.attachments.push(decodeWords(filename));
    return;
  }
  if (ctype.startsWith("text/plain")) acc.plain.push(decodePart(body, head));
  else if (ctype.startsWith("text/html")) acc.html.push(htmlToText(decodePart(body, head)));
  else if (ctype.startsWith("message/rfc822")) acc.plain.push(body);
}

function parseAddressList(v?: string): { name: string; address: string }[] {
  if (!v) return [];
  const out: { name: string; address: string }[] = [];
  // split on commas that are not inside quotes or angle brackets
  for (const part of v.match(/(?:"[^"]*"|<[^>]*>|[^,])+/g) ?? []) {
    const s = decodeWords(part.trim());
    if (!s) continue;
    const m = s.match(/^(.*?)\s*<([^>]+)>$/);
    const address = (m ? m[2] : s).trim().toLowerCase();
    let name = (m ? m[1] : "").replace(/^"|"$/g, "").trim();
    if (/,/.test(name)) name = name.split(",").map((x) => x.trim()).reverse().join(" "); // "Okafor, Ben" (Outlook) → "Ben Okafor"
    if (!name) name = address.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({ name, address });
  }
  return out;
}

/** Remove quoted history ("> …", "On … wrote:", Outlook "From: … Sent: …" blocks) and signatures. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .+wrote:\s*$/.test(l) || /^On .+, at .+$/.test(l) && /wrote:\s*$/.test(lines[i + 1] ?? "")) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l)) break;
    if (/^From: .+/.test(l) && lines.slice(i + 1, i + 5).some((x) => /^(Sent|Date): /.test(x))) break; // Outlook reply header
    if (/^_{8,}$/.test(l.trim())) break; // Outlook separator line
    if (/^-- ?$/.test(l)) break; // signature delimiter
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseEmailMessage(raw: string): EmailMessage {
  const [head, body] = splitHeadBody(raw.replace(/^﻿/, ""));
  const headers = parseHeaders(head);
  const acc = { plain: [] as string[], html: [] as string[], attachments: [] as string[] };
  extractBody(headers, body, acc);
  const text = (acc.plain.length ? acc.plain.join("\n\n") : acc.html.join("\n\n")).trim();
  const date = headers.date ? new Date(headers.date) : null;
  const client = headers["x-gmail-labels"] || /google|gmail/i.test(headers["message-id"] ?? "") || /mx\.google\.com/i.test(headers.received ?? "")
    ? "Gmail"
    : Object.keys(headers).some((k) => k.startsWith("x-ms-exchange") || k === "thread-index" || k === "x-mailer" && /outlook/i.test(headers[k]))
      ? "Outlook"
      : headers["x-mailer"] || undefined;
  return {
    headers,
    from: parseAddressList(headers.from)[0] ?? { name: "Unknown sender", address: "" },
    to: parseAddressList(headers.to),
    cc: parseAddressList(headers.cc),
    subject: decodeWords(headers.subject ?? headers["thread-topic"] ?? "(no subject)"),
    date: date && !isNaN(date.getTime()) ? date.toISOString() : undefined,
    messageId: headers["message-id"]?.replace(/[<>]/g, ""),
    inReplyTo: headers["in-reply-to"]?.replace(/[<>]/g, ""),
    references: (headers.references ?? "").match(/<[^>]+>/g)?.map((r) => r.replace(/[<>]/g, "")) ?? [],
    text,
    attachments: acc.attachments,
    client,
  };
}

/** mbox: messages start with a "From " line at column 0; mboxrd escapes body lines as ">From ". */
export function splitMbox(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split(/^From [^\n]*\n/m)
    .map((m) => m.replace(/^>(>*From )/gm, "$1"))
    .filter((m) => m.trim() && /^[\w-]+:/m.test(m));
}

export const looksLikeMbox = (text: string) => /^From \S+.*\n[\w-]+: /.test(text.slice(0, 2000));
export const looksLikeEml = (text: string) => {
  const head = text.slice(0, 4000);
  return /^(From|Received|Return-Path|Delivered-To|MIME-Version|Message-ID|Date|Subject|To|X-[\w-]+):/im.test(head) && /^From: /im.test(head) && /^(Subject|Date|Message-ID): /im.test(head);
};

const normSubject = (s: string) => s.replace(/^(\s*(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?:\s*|\s*\[[^\]]+\]\s*)+/gi, "").trim().toLowerCase();

/** Group messages into threads and emit one ParsedDoc per thread. */
export function emailsToDocs(messages: EmailMessage[], format: "email-eml" | "email-mbox"): ParsedDoc[] {
  const threads = new Map<string, EmailMessage[]>();
  const idToThread = new Map<string, string>();
  for (const m of [...messages].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
    const parent = [m.inReplyTo, ...m.references].find((r) => r && idToThread.has(r));
    const key = parent ? idToThread.get(parent)! : `subj:${normSubject(m.subject)}`;
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key)!.push(m);
    if (m.messageId) idToThread.set(m.messageId, key);
  }
  return [...threads.values()].map((msgs) => {
    const participants = new Map<string, string>();
    for (const m of msgs) for (const p of [m.from, ...m.to, ...m.cc]) if (p.address) participants.set(p.address, p.name);
    const segments: Segment[] = msgs.map((m) => ({
      speaker: m.from.name,
      role: "email",
      at: m.date,
      text: `${stripQuoted(m.text) || "(no new text)"}${m.attachments.length ? `\n[attachments: ${m.attachments.join(", ")}]` : ""}`,
    }));
    const domains = [...new Set([...participants.keys()].map((a) => a.split("@")[1]).filter(Boolean))];
    return {
      sourceKind: "email" as const,
      title: msgs[0].subject.replace(/^(re|fw|fwd):\s*/i, "") || "(no subject)",
      segments,
      occurredAt: msgs[0].date,
      metadata: {
        format,
        client: msgs.find((m) => m.client)?.client,
        subject: msgs[0].subject,
        message_count: msgs.length,
        speakers: [...new Set(msgs.map((m) => m.from.name))],
        attendees: [...new Set(participants.values())],
        participants: [...participants.entries()].map(([address, name]) => ({ name, address })),
        domains,
        first_at: msgs[0].date,
        last_at: msgs.at(-1)?.date,
        message_ids: msgs.map((m) => m.messageId).filter(Boolean),
        attachments: msgs.flatMap((m) => m.attachments),
        external_id: msgs[0].messageId ? `email:thread:${msgs[0].messageId}` : undefined,
      },
    };
  });
}
