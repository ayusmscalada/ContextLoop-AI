/**
 * Format detection + parsing for heterogeneous AI/work sources.
 * Every parser keeps the raw structure in the lake and emits a lossless-ish
 * normalized view (segments with speakers/tools) used for indexing.
 */
import path from "node:path";

export type SourceKind = "chatgpt" | "claude_code" | "codex" | "meeting" | "document" | "agent_trace";

export interface Segment {
  speaker?: string;
  role?: string;
  text: string;
  at?: string;
  tool?: string;
}

export interface TraceInput {
  agent: string;
  harness?: string;
  skill?: string;
  skill_version?: number;
  task: string;
  status: "success" | "failure";
  error_type?: string | null;
  error_message?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  cost_usd?: number;
  started_at?: string;
  project?: string;
  steps?: { type: string; name?: string; input?: any; output?: any; status?: string; latency_ms?: number; at?: string }[];
}

export interface ParsedDoc {
  sourceKind: SourceKind;
  title: string;
  segments: Segment[];
  occurredAt?: string;
  metadata: Record<string, any>;
  traces?: TraceInput[];
}

const iso = (v: any): string | undefined => {
  if (v == null || v === "") return undefined;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
};

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + " …[truncated in index; full text in raw lake]" : s);

function contentToText(content: any): { text: string; tools: string[] } {
  if (content == null) return { text: "", tools: [] };
  if (typeof content === "string") return { text: content, tools: [] };
  if (Array.isArray(content)) {
    const out: string[] = [];
    const tools: string[] = [];
    for (const b of content) {
      if (typeof b === "string") out.push(b);
      else if (b?.type === "text" || b?.type === "input_text" || b?.type === "output_text") out.push(b.text ?? "");
      else if (b?.type === "tool_use") {
        tools.push(b.name);
        out.push(`[tool_use ${b.name}] ${clip(JSON.stringify(b.input ?? {}), 600)}`);
      } else if (b?.type === "tool_result") {
        const t = contentToText(b.content).text;
        out.push(`[tool_result${b.is_error ? " ERROR" : ""}] ${clip(t, 1200)}`);
      } else if (b?.type === "thinking") continue;
      else if (b?.text) out.push(b.text);
    }
    return { text: out.join("\n"), tools };
  }
  if (typeof content === "object" && content.parts) return { text: content.parts.filter((p: any) => typeof p === "string").join("\n"), tools: [] };
  if (typeof content === "object" && content.text) return { text: String(content.text), tools: [] };
  return { text: "", tools: [] };
}

// ---------- ChatGPT export (conversations.json) ----------
function parseChatGPT(data: any[]): ParsedDoc[] {
  return data
    .filter((c) => c && c.mapping)
    .map((conv) => {
      const nodes = conv.mapping as Record<string, any>;
      // Walk the main thread from current_node back to root (handles branches/regenerations).
      let cur = conv.current_node ?? Object.keys(nodes).find((k) => !nodes[k].children?.length);
      const chain: any[] = [];
      const seen = new Set<string>();
      while (cur && nodes[cur] && !seen.has(cur)) {
        seen.add(cur);
        chain.push(nodes[cur]);
        cur = nodes[cur].parent;
      }
      chain.reverse();
      const segments: Segment[] = [];
      const models = new Set<string>();
      for (const n of chain) {
        const m = n.message;
        if (!m || !m.content) continue;
        const role = m.author?.role;
        if (role === "system") continue;
        const { text } = contentToText(m.content);
        if (!text.trim()) continue;
        if (m.metadata?.model_slug) models.add(m.metadata.model_slug);
        segments.push({ role, speaker: role === "user" ? "User" : role === "assistant" ? "ChatGPT" : role, text, at: iso(m.create_time) });
      }
      return {
        sourceKind: "chatgpt" as const,
        title: conv.title || "Untitled ChatGPT conversation",
        segments,
        occurredAt: iso(conv.create_time) ?? segments[0]?.at,
        metadata: {
          format: "chatgpt-export",
          conversation_id: conv.conversation_id ?? conv.id,
          models: [...models],
          message_count: segments.length,
          branches_discarded: Object.keys(nodes).length - chain.length,
          updated_at: iso(conv.update_time),
        },
      };
    });
}

// ---------- Claude Code session (.jsonl) ----------
function parseClaudeCode(lines: any[], filename: string): ParsedDoc {
  const segments: Segment[] = [];
  const tools = new Map<string, number>();
  let cwd: string | undefined, branch: string | undefined, sessionId: string | undefined, summary: string | undefined, version: string | undefined;
  let tokensIn = 0, tokensOut = 0;
  const models = new Set<string>();
  let errors = 0;
  for (const l of lines) {
    cwd ??= l.cwd;
    branch ??= l.gitBranch;
    sessionId ??= l.sessionId;
    version ??= l.version;
    if (l.type === "summary") {
      summary ??= l.summary;
      continue;
    }
    const msg = l.message;
    if (!msg || (l.type !== "user" && l.type !== "assistant")) continue;
    if (msg.model) models.add(msg.model);
    tokensIn += msg.usage?.input_tokens ?? 0;
    tokensOut += msg.usage?.output_tokens ?? 0;
    const { text, tools: used } = contentToText(msg.content);
    for (const t of used) tools.set(t, (tools.get(t) ?? 0) + 1);
    if (/\[tool_result ERROR\]/.test(text)) errors++;
    if (!text.trim()) continue;
    const isToolResult = Array.isArray(msg.content) && msg.content.every((b: any) => b.type === "tool_result");
    segments.push({
      role: msg.role,
      speaker: isToolResult ? "Tool" : msg.role === "user" ? "Developer" : "Claude Code",
      text,
      at: iso(l.timestamp),
      tool: used[0],
    });
  }
  const firstUser = segments.find((s) => s.speaker === "Developer")?.text ?? "";
  return {
    sourceKind: "claude_code",
    title: summary ?? (firstUser ? firstUser.split("\n")[0].slice(0, 90) : path.basename(filename)),
    segments,
    occurredAt: segments[0]?.at,
    metadata: {
      format: "claude-code-jsonl",
      session_id: sessionId,
      cwd,
      git_branch: branch,
      cli_version: version,
      models: [...models],
      tool_calls: Object.fromEntries(tools),
      tool_errors: errors,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      message_count: segments.length,
      ended_at: segments.at(-1)?.at,
    },
  };
}

// ---------- Codex CLI session rollout (.jsonl) ----------
function parseCodex(lines: any[], filename: string): ParsedDoc {
  const segments: Segment[] = [];
  const tools = new Map<string, number>();
  let meta: any = {};
  let failures = 0;
  for (const raw of lines) {
    const l = raw.payload ? { ...raw.payload, timestamp: raw.timestamp, _outer: raw.type } : raw;
    if (raw.type === "session_meta" || l._outer === "session_meta" || l.type === "session_meta") {
      meta = { ...meta, ...(raw.payload ?? l) };
      continue;
    }
    if (l.type === "message") {
      const { text } = contentToText(l.content);
      if (!text.trim() || /^<(environment_context|user_instructions)>/.test(text.trim())) continue;
      segments.push({ role: l.role, speaker: l.role === "user" ? "Developer" : "Codex", text, at: iso(l.timestamp) });
    } else if (l.type === "function_call" || l.type === "local_shell_call" || l.type === "custom_tool_call") {
      const name = l.name ?? (l.type === "local_shell_call" ? "shell" : "tool");
      tools.set(name, (tools.get(name) ?? 0) + 1);
      let args = l.arguments ?? l.action ?? l.input ?? "";
      if (typeof args !== "string") args = JSON.stringify(args);
      segments.push({ role: "tool", speaker: "Codex", text: `[tool_call ${name}] ${clip(args, 600)}`, at: iso(l.timestamp), tool: name });
    } else if (l.type === "function_call_output" || l.type === "custom_tool_call_output") {
      let out = l.output;
      if (typeof out !== "string") out = JSON.stringify(out);
      try {
        const o = JSON.parse(out);
        if (o?.metadata?.exit_code && o.metadata.exit_code !== 0) failures++;
        out = o.output ?? out;
      } catch {}
      segments.push({ role: "tool", speaker: "Tool", text: `[tool_output] ${clip(String(out), 1200)}`, at: iso(l.timestamp) });
    } else if (l.type === "agent_message" || l.type === "user_message") {
      if (l.message) segments.push({ role: l.type === "user_message" ? "user" : "assistant", speaker: l.type === "user_message" ? "Developer" : "Codex", text: l.message, at: iso(l.timestamp) });
    }
  }
  const firstUser = segments.find((s) => s.speaker === "Developer")?.text ?? "";
  return {
    sourceKind: "codex",
    title: firstUser ? firstUser.split("\n")[0].slice(0, 90) : path.basename(filename),
    segments,
    occurredAt: iso(meta.timestamp) ?? segments[0]?.at,
    metadata: {
      format: "codex-rollout-jsonl",
      session_id: meta.id,
      cwd: meta.cwd,
      cli_version: meta.cli_version,
      model: meta.model,
      git: meta.git,
      tool_calls: Object.fromEntries(tools),
      failed_commands: failures,
      message_count: segments.length,
    },
  };
}

// ---------- Agent execution trace (ContextLoop trace JSON / Codex exec logs) ----------
function parseTraces(items: TraceInput[], filename: string): ParsedDoc {
  const segments: Segment[] = items.map((t) => ({
    speaker: t.agent,
    text: `Task: ${t.task}\nSkill: ${t.skill ?? "-"} v${t.skill_version ?? "?"}\nStatus: ${t.status}${t.error_message ? `\nError (${t.error_type}): ${t.error_message}` : ""}\nSteps: ${(t.steps ?? []).map((s) => `${s.type}:${s.name ?? ""}${s.status ? `(${s.status})` : ""}`).join(" → ")}`,
    at: iso(t.started_at),
  }));
  const failures = items.filter((t) => t.status === "failure").length;
  return {
    sourceKind: "agent_trace",
    title: items.length === 1 ? `Execution: ${items[0].task}` : `${items.length} agent executions (${path.basename(filename)})`,
    segments,
    occurredAt: iso(items[0]?.started_at),
    metadata: { format: "agent-trace-json", executions: items.length, failures, agents: [...new Set(items.map((t) => t.agent))] },
    traces: items,
  };
}

// ---------- Meeting transcripts ----------
const SPEAKER_RE = /^(?:\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?\s*)?([A-Z][A-Za-z.'\- ]{1,40}?)\s*:\s+(.+)$/;
const HEADER_KEYS = ["meeting", "title", "date", "attendees", "participants", "project", "type", "location", "facilitator", "duration"];

function looksLikeTranscript(text: string): boolean {
  if (/^WEBVTT/.test(text)) return true;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const speakerLines = lines.filter((l) => {
    const m = l.match(SPEAKER_RE);
    return m && !HEADER_KEYS.includes(m[1].toLowerCase().trim());
  });
  return speakerLines.length >= 4 && speakerLines.length / Math.max(lines.length, 1) > 0.35;
}

function parseTranscript(text: string, filename: string): ParsedDoc {
  const header: Record<string, string> = {};
  const segments: Segment[] = [];
  let vttSpeaker: string | undefined;
  const lines = text.replace(/^WEBVTT.*$/m, "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^\d+$/.test(line) || /-->/.test(line)) continue;
    const hm = line.match(/^#*\s*([A-Za-z ]{3,20}):\s*(.+)$/);
    if (hm && HEADER_KEYS.includes(hm[1].toLowerCase().trim()) && segments.length === 0) {
      header[hm[1].toLowerCase().trim()] = hm[2].trim();
      continue;
    }
    const vtt = line.match(/^<v\s+([^>]+)>(.*)$/);
    if (vtt) {
      vttSpeaker = vtt[1].trim();
      segments.push({ speaker: vttSpeaker, text: vtt[2].replace(/<\/v>/, "").trim() });
      continue;
    }
    const m = line.match(SPEAKER_RE);
    if (m) segments.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (line.startsWith("#")) header.title ??= line.replace(/^#+\s*/, "");
    else if (segments.length) segments[segments.length - 1].text += " " + line;
    else segments.push({ text: line });
  }
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))] as string[];
  const attendees = header.attendees ?? header.participants;
  return {
    sourceKind: "meeting",
    title: header.meeting ?? header.title ?? path.basename(filename).replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
    segments,
    occurredAt: iso(header.date) ?? findDate(text),
    metadata: {
      format: /^WEBVTT/.test(text) ? "webvtt" : "speaker-transcript",
      attendees: attendees ? attendees.split(/,\s*/) : speakers,
      speakers,
      meeting_type: header.type,
      facilitator: header.facilitator,
      project_hint: header.project,
      turns: segments.length,
    },
  };
}

// ---------- Generic documents ----------
function parseDocument(text: string, filename: string, mime: string): ParsedDoc {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); // frontmatter is metadata, not content
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const heading = text.match(/^#\s+(.+)$/m)?.[1];
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const front: Record<string, string> = {};
  if (fm) for (const l of fm[1].split("\n")) { const [k, ...v] = l.split(":"); if (k && v.length) front[k.trim()] = v.join(":").trim(); }
  return {
    sourceKind: "document",
    title: front.title ?? heading ?? path.basename(filename),
    segments: paragraphs.map((p) => ({ text: p })),
    occurredAt: iso(front.date) ?? findDate(text),
    metadata: { format: mime, frontmatter: Object.keys(front).length ? front : undefined, headings: [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1]).slice(0, 20), author: front.author },
  };
}

function findDate(text: string): string | undefined {
  const m = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/) ?? text.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? 20\d{2})\b/);
  return m ? iso(m[1]) : undefined;
}

function parseJsonl(text: string): any[] | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 1) return null;
  const out: any[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      return null;
    }
  }
  return out;
}

async function pdfToText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).join("\n\n");
}

/** Detect the source format and parse. `hint` lets the user force a source kind. */
export async function parseFile(buf: Buffer, filename: string, hint?: SourceKind): Promise<{ docs: ParsedDoc[]; detected: string }> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf" || buf.subarray(0, 5).toString() === "%PDF-") {
    const text = await pdfToText(buf);
    return { docs: [looksLikeTranscript(text) ? parseTranscript(text, filename) : parseDocument(text, filename, "application/pdf")], detected: "pdf" };
  }
  const text = buf.toString("utf8").replace(/^﻿/, "");

  if (ext === ".jsonl" || ext === ".ndjson" || (!text.trim().startsWith("[") && text.trim().startsWith("{") && text.includes("\n{"))) {
    const lines = parseJsonl(text);
    if (lines) {
      const isCodex = hint === "codex" || lines.some((l) => l.type === "session_meta" || l.type === "response_item" || l.payload?.type === "function_call" || l.type === "function_call");
      const isClaude = hint === "claude_code" || lines.some((l) => (l.type === "user" || l.type === "assistant") && l.message);
      if (isCodex && hint !== "claude_code") return { docs: [parseCodex(lines, filename)], detected: "codex-jsonl" };
      if (isClaude) return { docs: [parseClaudeCode(lines, filename)], detected: "claude-code-jsonl" };
      if (lines.every((l) => l.task && l.status)) return { docs: [parseTraces(lines, filename)], detected: "trace-jsonl" };
    }
  }
  if (ext === ".json" || /^\s*[[{]/.test(text)) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data) && data.some((c) => c?.mapping)) return { docs: parseChatGPT(data), detected: "chatgpt-export" };
      if (data?.mapping) return { docs: parseChatGPT([data]), detected: "chatgpt-export" };
      const traces = Array.isArray(data) ? data : data?.executions ?? (data?.task && data?.status ? [data] : null);
      if (Array.isArray(traces) && traces.length && traces.every((t: any) => t?.task && t?.status)) return { docs: [parseTraces(traces, filename)], detected: "agent-trace-json" };
      return { docs: [parseDocument(JSON.stringify(data, null, 2), filename, "application/json")], detected: "json-document" };
    } catch {}
  }
  if (hint === "meeting" || ext === ".vtt" || looksLikeTranscript(text)) return { docs: [parseTranscript(text, filename)], detected: ext === ".vtt" ? "webvtt" : "transcript" };
  return { docs: [parseDocument(text, filename, ext === ".md" ? "text/markdown" : "text/plain")], detected: ext === ".md" ? "markdown" : "text" };
}

/** Group segments into retrieval chunks (~180 words), keeping speaker attribution. */
export function chunkSegments(segments: Segment[], target = 110): { text: string; speaker?: string }[] {
  const chunks: { text: string; speaker?: string }[] = [];
  let buf: string[] = [];
  let words = 0;
  let speaker: string | undefined;
  const flush = () => {
    if (buf.length) chunks.push({ text: buf.join("\n"), speaker });
    buf = [];
    words = 0;
    speaker = undefined;
  };
  for (const s of segments) {
    const line = s.speaker ? `${s.speaker}: ${s.text}` : s.text;
    const w = line.split(/\s+/).length;
    if (words + w > target && buf.length) flush();
    if (w > target * 2) {
      // split very long segments on sentence boundaries
      const sentences = line.match(/[^.!?\n]+[.!?\n]*/g) ?? [line];
      for (const sen of sentences) {
        const sw = sen.split(/\s+/).length;
        if (words + sw > target && buf.length) flush();
        speaker ??= s.speaker;
        buf.push(sen.trim());
        words += sw;
      }
      continue;
    }
    speaker ??= s.speaker;
    buf.push(line);
    words += w;
  }
  flush();
  return chunks;
}

export const segmentsToText = (segments: Segment[]) => segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join("\n");
