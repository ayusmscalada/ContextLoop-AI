/**
 * Entity / relationship / claim extraction. A deterministic extractor
 * (gazetteer + patterns) always runs; when Claude is configured its structured
 * extraction is merged on top. Every fact keeps a pointer to its evidence chunk.
 */
import { z } from "zod";
import { all, get, json, run, type Row } from "../db.ts";
import { structured } from "../llm.ts";
import { addClaim, addMention, addRelation, normKey, reconcile, upsertEntity, type EntityType } from "./ontology.ts";

const TECH = [
  "PostgreSQL", "Postgres", "Redis", "Kafka", "RabbitMQ", "Celery", "Python", "TypeScript", "Node.js", "React", "Next.js", "FastAPI",
  "Docker", "Kubernetes", "Terraform", "AWS", "S3", "SQS", "Lambda", "GraphQL", "gRPC", "REST", "Webhooks", "OAuth", "JWT",
  "PayFlow API", "LedgerDB", "Stripe-compatible API", "OpenTelemetry", "Grafana", "Sentry", "pgvector", "MCP", "Go", "Rust",
];
const NON_PEOPLE = new Set(["user", "developer", "claude code", "codex", "chatgpt", "tool", "assistant", "system", "note", "action item", "decision", "summary", "agenda", "next steps", "todo"]);

const ISSUE_PATTERNS: [RegExp, string][] = [
  [/\btime(?:d)?[ -]?outs?\b|exceeded (?:its |the )?timeout|deadline exceeded/i, "External API timeouts"],
  [/\b429\b|rate[- ]limit/i, "Rate limiting (429)"],
  [/duplicate (?:charge|payment)s?|double[- ]charg/i, "Duplicate charges"],
  [/webhook signature|signature (?:mismatch|verification)/i, "Webhook signature failures"],
  [/lock (?:contention|timeout)|deadlock/i, "Migration lock contention"],
  [/flaky tests?/i, "Flaky tests"],
  [/memory leak|OOM|out of memory/i, "Memory pressure"],
  [/schema (?:drift|mismatch)/i, "Schema drift"],
];

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATE_RE = /\b(?:(20\d{2})-(\d{2})-(\d{2})|(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?)\b/i;

function parseDate(text: string, refIso?: string): string | null {
  const m = text.match(DATE_RE);
  if (!m) return null;
  if (m[1]) return `${m[1]}-${m[2]}-${m[3]}`;
  const month = MONTHS[m[4].slice(0, 3).toLowerCase()] ?? MONTHS[m[4].slice(0, 4).toLowerCase()];
  const day = +m[5];
  const ref = refIso ? new Date(refIso) : new Date();
  let year = m[6] ? +m[6] : ref.getUTCFullYear();
  if (!m[6] && month < ref.getUTCMonth() + 1 - 3) year++; // "Jan 10" said in November → next year
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);

/** Sentences with per-line speaker attribution ("Priya Patel: … The launch moved to …"). */
function speakerSentences(t: string): { s: string; speaker?: string }[] {
  const out: { s: string; speaker?: string }[] = [];
  for (const line of t.split(/\n+/)) {
    const m = line.match(/^([A-Z][A-Za-z.' -]{1,40}):\s+(.*)$/);
    const isPerson = !!m && !NON_PEOPLE.has(m[1].toLowerCase().trim());
    for (const s of sentences(isPerson ? m![2] : line)) out.push({ s, speaker: isPerson ? m![1].trim() : undefined });
  }
  return out;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Gaz { id: string; type: EntityType; name: string; re: RegExp }
function gazetteer(): Gaz[] {
  return all("SELECT id, type, name, aliases FROM entities WHERE type IN ('person','project','customer','technology')").flatMap((e) =>
    [e.name, ...json<string[]>(e.aliases, [])].filter((n: string) => n.length >= 3).map((n: string) => ({ id: e.id, type: e.type as EntityType, name: e.name, re: new RegExp(`\\b${esc(n)}\\b`, e.type === "person" ? "" : "i") })),
  );
}

export interface ExtractionStats { entities: number; relations: number; claims: number; conflicts: string[]; llm: boolean }

const LlmExtraction = z.object({
  entities: z.array(z.object({ type: z.enum(["person", "project", "customer", "technology", "issue", "decision", "task"]), name: z.string(), description: z.string() })),
  relations: z.array(z.object({ source: z.string(), target: z.string(), type: z.string() })),
  claims: z.array(z.object({ subject: z.string(), predicate: z.enum(["deadline", "owner", "status", "budget"]), value: z.string(), quote: z.string() })),
});

export async function extractDocument(docId: string, opts: { useLlm?: boolean } = {}): Promise<ExtractionStats> {
  const doc = get("SELECT * FROM documents WHERE id = ?", docId)!;
  const meta = json<Row>(doc.metadata, {});
  const chunks = all("SELECT * FROM chunks WHERE doc_id = ? ORDER BY idx", docId);
  const found = new Set<string>();
  let relCount = 0, claimCount = 0;
  const touchedClaims = new Set<string>();
  const rel = (a: string, b: string, t: string, snip: string, conf = 0.7) => { addRelation(a, b, t, docId, conf, snip); relCount++; };

  // --- People from transcript speakers / attendees
  const peopleNames = new Set<string>([...(meta.speakers ?? []), ...(meta.attendees ?? [])].map((s: string) => s.replace(/\(.*?\)/, "").trim()).filter((s: string) => s && !NON_PEOPLE.has(s.toLowerCase())));
  for (const n of peopleNames) {
    if (!/^[A-Z][a-z]+(?: [A-Z][a-z'-]+)*$/.test(n)) continue;
    const id = upsertEntity("person", n, { aliases: n.includes(" ") ? [n.split(" ")[0]] : [] });
    found.add(id);
  }
  // --- Project from doc assignment
  let docProjectEntity: string | null = null;
  if (doc.project_id) {
    const p = get("SELECT entity_id, name FROM projects WHERE id = ?", doc.project_id);
    if (p?.entity_id) docProjectEntity = p.entity_id;
  }

  const gaz = gazetteer();
  const people = all("SELECT id, name, aliases FROM entities WHERE type='person'");
  for (const ch of chunks) {
    const text: string = ch.text;
    // Projects by pattern
    for (const m of text.matchAll(/\bProject\s+([A-Z][a-z]+)\b/g)) {
      const id = upsertEntity("project", `Project ${m[1]}`);
      addMention(id, docId, ch.id, text);
      found.add(id);
    }
    // Customers by pattern
    for (const m of text.matchAll(/\b(?:customer|client|account)\s+([A-Z][A-Za-z&]+(?:\s(?:Retail|Bank|Corp|Inc|Labs|Health|Group|Logistics|Foods))?)/g)) {
      if (m[1].length < 3) continue;
      const id = upsertEntity("customer", m[1]);
      addMention(id, docId, ch.id, text);
      found.add(id);
    }
    // Technologies
    for (const t of TECH) {
      if (new RegExp(`\\b${esc(t)}\\b`, "i").test(text)) {
        const id = upsertEntity("technology", t === "Postgres" ? "PostgreSQL" : t);
        addMention(id, docId, ch.id, text);
        found.add(id);
      }
    }
    // Known entities (gazetteer; includes first-name aliases)
    for (const g of gaz) {
      if (g.re.test(text)) {
        addMention(g.id, docId, ch.id, text);
        found.add(g.id);
      }
    }
    // Issues
    const chunkIssues: string[] = [];
    for (const [re, name] of ISSUE_PATTERNS) {
      if (re.test(text)) {
        const id = upsertEntity("issue", name);
        addMention(id, docId, ch.id, text);
        found.add(id);
        chunkIssues.push(id);
      }
    }
    const chunkProjects = all("SELECT entity_id FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE m.chunk_id = ? AND e.type = 'project'", ch.id).map((r) => r.entity_id);
    const projectIds = chunkProjects.length ? chunkProjects : docProjectEntity ? [docProjectEntity] : [];

    for (const { s, speaker: lineSpeaker } of speakerSentences(text)) {
      // Decisions
      const dm = s.match(/\b(?:we decided|decision:|decided to|agreed (?:to|that|on)|we'll go with|going with|approved)(?:\b|(?<=:))\s*(.*)/i);
      if (dm && s.length < 400) {
        const body = s.replace(/^[A-Z][A-Za-z.' -]{1,40}:\s*/, "").replace(/^(decision:\s*)/i, "");
        const name = body.length > 90 ? body.slice(0, 87).replace(/\s+\S*$/, "") + "…" : body;
        const id = upsertEntity("decision", name, { description: body });
        addMention(id, docId, ch.id, s);
        found.add(id);
        for (const p of projectIds) rel(id, p, "decision_for", s, 0.8);
        for (const i of chunkIssues) rel(id, i, "resolves", s, 0.65);
      }
      // Tasks / action items
      const tm = s.match(/^(?:[-*]\s*\[ \]\s*|action item:?\s*|todo:?\s*|AI:\s*)(.+)/i) ?? s.match(/^(?:[A-Z][a-z]+(?: [A-Z][a-z]+)?:\s*)?(?:Action item|Action)\s*[-:]\s*(.+)/i);
      if (tm) {
        const body = tm[1].trim();
        const id = upsertEntity("task", body.length > 90 ? body.slice(0, 87) + "…" : body, { description: body });
        addMention(id, docId, ch.id, s);
        found.add(id);
        for (const p of projectIds) rel(id, p, "part_of", s);
        const owner = body.match(/^([A-Z][a-z]+)(?:\s[A-Z][a-z]+)?\s+(?:will|to)\b/) ?? body.match(/\((?:owner:\s*)?([A-Z][a-z]+)\)/);
        if (owner) {
          const person = people.find((p) => p.name.startsWith(owner[1]) || json<string[]>(p.aliases, []).includes(owner[1]));
          if (person) rel(id, person.id, "assigned_to", s);
        }
      }
      // Deadline claims
      if (/\b(launch|go[- ]live|deadline|ship|release|due|GA|cut ?over|code freeze)\b/i.test(s) && DATE_RE.test(s)) {
        const named = [...s.matchAll(/\bProject\s+([A-Z][a-z]+)\b/g)].map((m) => normKey(`Project ${m[1]}`));
        const subjects = named.length ? all(`SELECT id FROM entities WHERE type='project' AND key IN (${named.map(() => "?").join(",")})`, ...named).map((r) => r.id) : projectIds;
        const value = parseDate(s, doc.occurred_at);
        if (value && subjects.length === 1 && !/\b(code freeze|demo|review)\b/i.test(s)) {
          const hedged = /\b(maybe|might|hopefully|tentative|rough|probably|aiming)\b/i.test(s);
          const explicit = /\b(moved|pushed|slipp\w*|changed|revised|confirmed|official|final|new date)\b/i.test(s);
          const speaker = lineSpeaker;
          addClaim({ entityId: subjects[0], predicate: "deadline", value, docId, snippet: s, speaker, observedAt: doc.occurred_at, confidence: explicit ? 0.95 : hedged ? 0.45 : 0.75, sourceKind: doc.source_kind, meetingType: meta.meeting_type });
          touchedClaims.add(`${subjects[0]}|deadline`);
          claimCount++;
        }
      }
      // Owner claims
      const om = s.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) (?:owns|is (?:the )?owner of|will own|is leading|leads)\s+(Project [A-Z][a-z]+)/) ?? s.match(/(Project [A-Z][a-z]+)\s+owner(?: is|:)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/);
      if (om) {
        const [personName, projName] = om[0].includes("owner") && om[1].startsWith("Project") ? [om[2], om[1]] : [om[1], om[2]];
        const pid = upsertEntity("project", projName);
        const person = upsertEntity("person", personName, { aliases: personName.includes(" ") ? [personName.split(" ")[0]] : [] });
        const pname = get("SELECT name FROM entities WHERE id = ?", person)!.name;
        addClaim({ entityId: pid, predicate: "owner", value: pname, docId, snippet: s, observedAt: doc.occurred_at, confidence: 0.85, sourceKind: doc.source_kind });
        rel(person, pid, "owns", s, 0.9);
        touchedClaims.add(`${pid}|owner`);
        claimCount++;
      }
      // Status claims
      const sm = s.match(/(Project [A-Z][a-z]+)\s+is\s+(?:now\s+)?(on track|at risk|blocked|delayed|green|yellow|red)\b/i);
      if (sm) {
        const pid = upsertEntity("project", sm[1]);
        addClaim({ entityId: pid, predicate: "status", value: sm[2].toLowerCase(), docId, snippet: s, observedAt: doc.occurred_at, confidence: 0.7, sourceKind: doc.source_kind });
        touchedClaims.add(`${pid}|status`);
        claimCount++;
      }
    }
    // Co-occurrence relations within the chunk
    const chunkEnts = all("SELECT e.id, e.type FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE m.chunk_id = ?", ch.id);
    const speakerEnt = ch.speaker ? people.find((p) => p.name === ch.speaker || json<string[]>(p.aliases, []).includes(ch.speaker)) : undefined;
    for (const p of projectIds) {
      for (const e of chunkEnts) {
        if (e.type === "technology") rel(p, e.id, "uses", text, 0.6);
        if (e.type === "customer") rel(p, e.id, "for_customer", text, 0.7);
        if (e.type === "issue") rel(e.id, p, "affects", text, 0.7);
        if (e.type === "person") rel(e.id, p, "works_on", text, 0.6);
      }
      if (speakerEnt) rel(speakerEnt.id, p, "works_on", text, 0.75);
    }
  }

  // --- Optional Claude pass
  let usedLlm = false;
  if (opts.useLlm !== false) {
    const known = all("SELECT type, name FROM entities WHERE type IN ('person','project','customer') LIMIT 80").map((e) => `${e.type}: ${e.name}`).join("\n");
    const result = await structured({
      system: "You extract organizational knowledge from workplace records into a typed ontology. Use canonical names already known when they refer to the same thing. Only extract facts stated in the text. Dates as YYYY-MM-DD.",
      prompt: `Known entities:\n${known}\n\nRecord type: ${doc.source_kind}\nRecord date: ${doc.occurred_at ?? "unknown"}\nTitle: ${doc.title}\n\n<record>\n${doc.text.slice(0, 14000)}\n</record>\n\nExtract people, projects, customers, technologies, issues (problems), decisions and tasks; relations between them (types like works_on, owns, uses, for_customer, affects, resolves, decision_for, assigned_to, part_of); and claims for project deadline/owner/status/budget with the exact supporting quote.`,
      schema: LlmExtraction,
      effort: "low",
    });
    if (result) {
      usedLlm = true;
      const idByName = new Map<string, string>();
      for (const e of result.entities) {
        const id = upsertEntity(e.type, e.name, { description: e.description });
        idByName.set(normKey(e.name), id);
        found.add(id);
        const ch = chunks.find((c) => c.text.toLowerCase().includes(e.name.toLowerCase().split(" ")[0])) ?? chunks[0];
        if (ch) addMention(id, docId, ch.id, ch.text);
      }
      for (const r of result.relations) {
        const a = idByName.get(normKey(r.source)), b = idByName.get(normKey(r.target));
        if (a && b) rel(a, b, r.type, `${r.source} ${r.type} ${r.target}`, 0.8);
      }
      for (const c of result.claims) {
        const sid = idByName.get(normKey(c.subject)) ?? get("SELECT id FROM entities WHERE key = ?", normKey(c.subject))?.id;
        if (!sid) continue;
        const value = c.predicate === "deadline" ? parseDate(c.value, doc.occurred_at) ?? c.value : c.value;
        const exists = get("SELECT id FROM claims WHERE entity_id = ? AND predicate = ? AND doc_id = ?", sid, c.predicate, docId);
        if (exists) continue;
        addClaim({ entityId: sid, predicate: c.predicate, value, docId, snippet: c.quote, observedAt: doc.occurred_at, confidence: 0.8, sourceKind: doc.source_kind });
        touchedClaims.add(`${sid}|${c.predicate}`);
        claimCount++;
      }
    }
  }

  // Infer document project if unassigned
  if (!doc.project_id) {
    const top = get("SELECT p.id, COUNT(*) n FROM mentions m JOIN projects p ON p.entity_id = m.entity_id WHERE m.doc_id = ? GROUP BY p.id ORDER BY n DESC LIMIT 1", docId);
    if (top) run("UPDATE documents SET project_id = ? WHERE id = ?", top.id, docId);
  }

  const conflicts: string[] = [];
  for (const k of touchedClaims) {
    const [eid, pred] = k.split("|");
    const r = reconcile(eid, pred);
    if (r.conflictId) conflicts.push(r.conflictId);
  }
  return { entities: found.size, relations: relCount, claims: claimCount, conflicts, llm: usedLlm };
}
