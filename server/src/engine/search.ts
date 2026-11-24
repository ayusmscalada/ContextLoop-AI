/**
 * Retrieval: in-memory hybrid index over all chunks.
 *  - keyword: BM25 over normalized tokens
 *  - semantic: 512-d signed feature-hashing embeddings (unigrams, bigrams, char n-grams,
 *    concept normalization). Local & dependency-free; swap in a hosted embedding model
 *    by replacing `embed()`.
 *  - fused with Reciprocal Rank Fusion, then filtered by the caller's permissions.
 */
import { all, get, json, now, run, uid, type Row } from "../db.ts";
import { visibleDocIds, type Principal } from "../auth.ts";
import { complete } from "../llm.ts";

const STOP = new Set("a an the and or but if of to in on at for with by from as is are was were be been being it its this that these those we our you your they their he she i me my do did does done have has had not no so than then there here what why how when where which who whom can could should would will just about into over after before also any some".split(" "));

const CONCEPTS: Record<string, string> = {
  fail: "fail", failed: "fail", failure: "fail", failing: "fail", fails: "fail", broke: "fail", broken: "fail", error: "fail", errors: "fail", crash: "fail", outage: "fail", incident: "fail",
  timeout: "timeout", timeouts: "timeout", timed: "timeout", latency: "timeout", slow: "timeout", hang: "timeout", hung: "timeout",
  fix: "fix", fixed: "fix", resolve: "fix", resolved: "fix", resolution: "fix", solution: "fix", solved: "fix", mitigate: "fix", mitigated: "fix", patch: "fix", patched: "fix",
  payment: "payment", payments: "payment", charge: "payment", charges: "payment", billing: "payment", checkout: "payment", transaction: "payment",
  deadline: "deadline", launch: "deadline", due: "deadline", ship: "deadline", release: "deadline", golive: "deadline",
  retry: "retry", retries: "retry", retrying: "retry", backoff: "retry", reattempt: "retry",
  integrate: "integration", integration: "integration", integrations: "integration", integrating: "integration",
  decide: "decision", decided: "decision", decision: "decision", agreed: "decision", chose: "decision",
  customer: "customer", client: "customer", clients: "customer", customers: "customer",
  async: "async", asynchronous: "async", queue: "async", queued: "async", worker: "async",
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/go-live/g, "golive")
    .split(/[^a-z0-9#]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => CONCEPTS[t] ?? (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, "") : t));
}

const DIM = 512;
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function embed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const toks = tokenize(text);
  const add = (f: string, w: number) => {
    const h = hash(f);
    v[h % DIM] += (h & 0x80000000 ? -1 : 1) * w;
  };
  for (let i = 0; i < toks.length; i++) {
    add("u:" + toks[i], 1);
    if (i + 1 < toks.length) add("b:" + toks[i] + "_" + toks[i + 1], 0.6);
    const t = `^${toks[i]}$`;
    if (t.length > 5) for (let j = 0; j + 4 <= t.length; j++) add("c:" + t.slice(j, j + 4), 0.25);
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const cosine = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
};

interface IndexedChunk { id: string; docId: string; text: string; speaker: string | null; len: number; tf: Map<string, number>; vec: Float32Array }
interface DocInfo { id: string; title: string; source_kind: string; project_id: string | null; occurred_at: string | null }

const chunksById = new Map<string, IndexedChunk>();
const postings = new Map<string, Map<string, number>>();
const docs = new Map<string, DocInfo>();
let totalLen = 0;
export const indexStats = { chunks: 0, docs: 0, terms: 0, builtAt: "", buildMs: 0, queries: 0, totalQueryMs: 0, lastQueryMs: 0 };

function addChunk(c: Row) {
  const toks = tokenize(c.text);
  const tf = new Map<string, number>();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  const ic: IndexedChunk = { id: c.id, docId: c.doc_id, text: c.text, speaker: c.speaker, len: toks.length, tf, vec: embed(c.text) };
  chunksById.set(c.id, ic);
  totalLen += ic.len;
  for (const [t, n] of tf) {
    let p = postings.get(t);
    if (!p) postings.set(t, (p = new Map()));
    p.set(c.id, n);
  }
}

export function buildIndex() {
  const t0 = performance.now();
  chunksById.clear(); postings.clear(); docs.clear(); totalLen = 0;
  for (const d of all("SELECT id, title, source_kind, project_id, occurred_at FROM documents WHERE duplicate_of IS NULL")) docs.set(d.id, d as DocInfo);
  for (const c of all("SELECT c.* FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE d.duplicate_of IS NULL")) addChunk(c);
  refreshStats();
  indexStats.buildMs = Math.round(performance.now() - t0);
}

export function indexDocument(docId: string) {
  const d = get("SELECT id, title, source_kind, project_id, occurred_at FROM documents WHERE id = ?", docId);
  if (!d) return;
  docs.set(d.id, d as DocInfo);
  for (const c of all("SELECT * FROM chunks WHERE doc_id = ?", docId)) addChunk(c);
  refreshStats();
}

function refreshStats() {
  indexStats.chunks = chunksById.size;
  indexStats.docs = docs.size;
  indexStats.terms = postings.size;
  indexStats.builtAt = now();
}

export interface SearchFilters { projectId?: string; sources?: string[]; from?: string; to?: string; mode?: "hybrid" | "keyword" | "semantic"; limit?: number }
export interface SearchHit { chunkId: string; docId: string; title: string; sourceKind: string; projectId: string | null; occurredAt: string | null; text: string; speaker: string | null; score: number; bm25: number; semantic: number; matched: string[] }

export function search(query: string, p: Principal, f: SearchFilters = {}): { hits: SearchHit[]; ms: number; candidates: number } {
  const t0 = performance.now();
  const visible = visibleDocIds(p);
  const allow = (docId: string) => {
    if (!visible.has(docId)) return false;
    const d = docs.get(docId);
    if (!d) return false;
    if (f.projectId && d.project_id !== f.projectId) return false;
    if (f.sources?.length && !f.sources.includes(d.source_kind)) return false;
    if (f.from && (d.occurred_at ?? "") < f.from) return false;
    if (f.to && (d.occurred_at ?? "9999") > f.to + "T23:59:59") return false;
    return true;
  };
  const qt = [...new Set(tokenize(query))];
  const mode = f.mode ?? "hybrid";
  const N = chunksById.size || 1;
  const avg = totalLen / N || 1;

  const bm = new Map<string, number>();
  if (mode !== "semantic") {
    for (const t of qt) {
      const p2 = postings.get(t);
      if (!p2) continue;
      const idf = Math.log(1 + (N - p2.size + 0.5) / (p2.size + 0.5));
      for (const [cid, tf] of p2) {
        const c = chunksById.get(cid)!;
        if (!allow(c.docId)) continue;
        const s = idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (c.len / avg))));
        bm.set(cid, (bm.get(cid) ?? 0) + s);
      }
    }
  }
  const sem = new Map<string, number>();
  if (mode !== "keyword") {
    const qv = embed(query);
    for (const c of chunksById.values()) {
      if (!allow(c.docId)) continue;
      const s = cosine(qv, c.vec);
      if (s > 0.05) sem.set(c.id, s);
    }
  }
  const rank = (m: Map<string, number>) => new Map([...m.entries()].sort((a, b) => b[1] - a[1]).map(([k], i) => [k, i + 1]));
  const rb = rank(bm), rs = rank(sem);
  const ids = new Set([...bm.keys(), ...[...rs.entries()].filter(([, r]) => r <= 200).map(([k]) => k)]);
  const fused: SearchHit[] = [];
  for (const id of ids) {
    const c = chunksById.get(id)!;
    const d = docs.get(c.docId)!;
    const score = mode === "keyword" ? bm.get(id) ?? 0 : mode === "semantic" ? sem.get(id) ?? 0 : (rb.has(id) ? 1 / (60 + rb.get(id)!) : 0) + (rs.has(id) ? 1 / (60 + rs.get(id)!) : 0);
    fused.push({ chunkId: id, docId: c.docId, title: d.title, sourceKind: d.source_kind, projectId: d.project_id, occurredAt: d.occurred_at, text: c.text, speaker: c.speaker, score, bm25: +(bm.get(id) ?? 0).toFixed(3), semantic: +(sem.get(id) ?? 0).toFixed(3), matched: qt.filter((t) => c.tf.has(t)) });
  }
  fused.sort((a, b) => b.score - a.score);
  const ms = +(performance.now() - t0).toFixed(2);
  indexStats.queries++;
  indexStats.totalQueryMs += ms;
  indexStats.lastQueryMs = ms;
  return { hits: fused.slice(0, f.limit ?? 10), ms, candidates: ids.size };
}

// ---------------- RAG answers ----------------

export interface Citation { n: number; docId: string; chunkId: string; title: string; sourceKind: string; occurredAt: string | null; snippet: string }

function diversify(hits: SearchHit[], max = 6, perDoc = 2): SearchHit[] {
  const out: SearchHit[] = [];
  const per = new Map<string, number>();
  for (const h of hits) {
    if ((per.get(h.docId) ?? 0) >= perDoc) continue;
    per.set(h.docId, (per.get(h.docId) ?? 0) + 1);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

const CAUSE = /\b(because|caused|cause|due to|root cause|failed|failing|exceeded|timed out|timeout|ran out|didn't|did not|no retry|without)\b/i;
const FIX = /\b(fixed|resolved|resolution|implemented|introduced|added|switched|moved to|decided|agreed|now (?:uses|retries)|backoff|retry|retries|idempoten|async|queue|passed|succeeded)\b/i;

const GENERIC = new Set(["project", "team", "work", "thing", "use", "make", "need", "want", "know", "tell", "please"]);
function idf(t: string) {
  const df = postings.get(t)?.size ?? 0;
  const N = chunksById.size || 1;
  return GENERIC.has(t) ? 0.2 : Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

function extractiveAnswer(question: string, picked: SearchHit[]): string {
  const qt = new Set(tokenize(question));
  const qWeight = [...qt].reduce((a, t) => a + idf(t), 0) || 1;
  const coverage = (toks: Set<string>) => [...qt].filter((t) => toks.has(t)).reduce((a, t) => a + idf(t), 0) / qWeight;
  const wantsWhy = /\bwhy|cause|what happened|fail/i.test(question);
  const wantsHow = /\bhow|resolve|fix|solution|what did we do/i.test(question);
  // Anchor terms: proper nouns in the question ("Falcon", "PayFlow"). If the question names
  // something specific, evidence must actually mention it — no loosely related filler.
  const anchors = [...new Set((question.match(/(?<=\s)[A-Z][a-zA-Z0-9]+\b/g) ?? []).map((w) => tokenize(w)[0]).filter((t) => t && !GENERIC.has(t)))];
  const hasAnchor = (toks: Set<string>) => !anchors.length || anchors.some((a) => toks.has(a));
  const docText = new Map<string, string>();
  for (const h of picked) docText.set(h.docId, (docText.get(h.docId) ?? h.title) + " " + h.text);
  const cands: { s: string; n: number; score: number; kind: "cause" | "fix" | "fact" }[] = [];
  picked.forEach((h, i) => {
    // A chunk (or its document) that covers the question well makes its causal/fix sentences
    // relevant even when they don't repeat the question's words ("Decision: we adopt exponential backoff…").
    const docToks = new Set(tokenize(docText.get(h.docId)!));
    if (!hasAnchor(docToks)) return;
    const chunkCov = Math.max(coverage(new Set(tokenize(h.text))), coverage(docToks) * 0.9);
    for (const raw of h.text.split(/(?<=[.!?])\s+|\n+/)) {
      const s = raw.replace(/^\[(tool_use|tool_result|tool_call|tool_output)[^\]]*\]\s*/, "").trim();
      if (s.length < 25 || s.length > 420 || /^[{[#]/.test(s) || /^(title|author|date|version|name|description):/i.test(s)) continue;
      const sToks = new Set(tokenize(s));
      const overlap = coverage(sToks);
      const kind = CAUSE.test(s) ? "cause" : FIX.test(s) ? "fix" : "fact";
      const onTopicChunk = chunkCov >= 0.45 && kind !== "fact" && (wantsWhy || wantsHow);
      if (overlap < 0.22 && !onTopicChunk) continue;
      if (kind === "fact" && !hasAnchor(sToks)) continue;
      const isPrompt = /^(Developer|User):/.test(s) || /\?$/.test(s) || /\b(I will|I'll|will implement|action item)\b/i.test(s);
      if (isPrompt) continue; // questions, prompts and promises are not answers
      const isDecision = /\b(decision|decided|agreed|fixed:|summary:|root cause)\b/i.test(s);
      const bonus = (wantsWhy && kind === "cause" ? 0.35 : 0) + (wantsHow && kind === "fix" ? 0.35 : 0) + (isDecision ? 0.4 : 0) - (isPrompt ? 0.6 : 0) + chunkCov * 0.3 + (1 / (i + 2)) * 0.2;
      cands.push({ s: s.replace(/^([A-Z][A-Za-z.' -]{1,40}):\s*/, "$1: "), n: i + 1, score: overlap + bonus, kind });
    }
  });
  const used = new Set<string>();
  const take = (kind: string, k: number) =>
    cands.filter((c) => c.kind === kind && c.score > 0.2 && !used.has(c.s.slice(0, 60))).sort((a, b) => b.score - a.score).slice(0, k).map((c) => { used.add(c.s.slice(0, 60)); return `${c.s} [${c.n}]`; });
  const causes = wantsWhy ? take("cause", 2) : [];
  const fixes = wantsHow || wantsWhy ? take("fix", 3) : [];
  const facts = causes.length + fixes.length < 2 ? take("fact", 3) : [];
  const parts: string[] = [];
  const list = (xs: string[]) => xs.map((c) => `- ${c}`).join("\n");
  if (causes.length) parts.push(`**What happened**\n${list(causes)}`);
  if (fixes.length) parts.push(`**How it was resolved**\n${list(fixes)}`);
  if (facts.length) parts.push(`**Relevant knowledge**\n${list(facts)}`);
  return parts.join("\n\n");
}

const PREDICATE_CUES: [RegExp, string][] = [
  [/\b(when|launch|deadline|due|ship|release|go[- ]live|date)\b/i, "deadline"],
  [/\b(who owns|owner|who is responsible|who leads|lead)\b/i, "owner"],
  [/\b(status|on track|at risk|blocked|health)\b/i, "status"],
];
const fmtDate = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : v);

/** Ontology-first answers: typed facts (with conflict state and provenance) for entities named in the question. */
export function graphFacts(question: string, p: Principal): { text: string; entities: string[] } | null {
  const preds = PREDICATE_CUES.filter(([re]) => re.test(question)).map(([, k]) => k);
  if (!preds.length) return null;
  const visible = visibleDocIds(p);
  const q = question.toLowerCase();
  const ents = all("SELECT id, name, aliases, attributes FROM entities WHERE type IN ('project','customer')").filter((e) =>
    [e.name, ...json<string[]>(e.aliases, [])].some((n: string) => n.length > 3 && q.includes(n.toLowerCase())));
  const lines: string[] = [];
  const used: string[] = [];
  for (const e of ents) {
    const claims = all("SELECT c.*, d.title doc_title FROM claims c JOIN documents d ON d.id = c.doc_id WHERE c.entity_id = ? AND c.status != 'rejected' ORDER BY c.observed_at", e.id).filter((c) => visible.has(c.doc_id));
    if (!claims.length) continue; // nothing this principal may see
    const attrs = json<Record<string, any>>(e.attributes, {});
    for (const pred of preds) {
      const a = attrs[pred];
      const pc = claims.filter((c) => c.predicate === pred);
      if (!a || !pc.length) continue;
      const cur = pc.find((c) => c.id === a.claim_id) ?? pc[pc.length - 1];
      const others = [...new Set(pc.filter((c) => c.value !== cur.value).map((c) => c.value))];
      const state = a.status === "conflict" ? "⚠️ conflicting sources, pending review" : a.reviewed_by ? `✓ confirmed by ${a.reviewed_by}` : "✓ current";
      lines.push(`- **${e.name} → ${pred}: ${fmtDate(cur.value)}** (${state}) — from “${cur.doc_title}”${cur.speaker ? `, stated by ${cur.speaker}` : ""}${others.length ? `; superseded/alternative: ${others.map(fmtDate).join(", ")}` : ""}`);
      used.push(e.id);
    }
  }
  return lines.length ? { text: `**From the knowledge graph**\n${lines.join("\n")}`, entities: used } : null;
}

export async function answer(question: string, p: Principal, opts: { threadId?: string; filters?: SearchFilters } = {}) {
  const t0 = performance.now();
  let threadId = opts.threadId;
  const history = threadId ? all("SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY at", threadId) : [];
  // Conversation memory: resolve follow-ups ("how did we fix it?") against the previous question.
  let retrievalQuery = question;
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (lastUser && (question.split(/\s+/).length < 9 || /\b(it|that|this|they|those|them)\b/i.test(question))) retrievalQuery = `${question} ${lastUser.content}`;

  const { hits, ms } = search(retrievalQuery, p, { ...opts.filters, limit: 30 });
  const picked = diversify(hits);
  // Context expansion: decisions and fixes often sit in the chunk right after the one that
  // matched the question, so pull in neighbours of the top hits for why/how questions.
  if (/\b(why|how|resolve|fix|decid)/i.test(question)) {
    for (const h of picked.slice(0, 3)) {
      const m = h.chunkId.match(/^(.*)_c(\d+)$/);
      if (!m) continue;
      for (const nid of [`${m[1]}_c${+m[2] + 1}`, `${m[1]}_c${+m[2] + 2}`]) {
        const c = chunksById.get(nid);
        if (!c || picked.some((x) => x.chunkId === nid) || picked.length >= 9) continue;
        picked.push({ ...h, chunkId: nid, text: c.text, speaker: c.speaker, score: h.score * 0.9, bm25: 0, semantic: 0, matched: [] });
      }
    }
  }
  const citations: Citation[] = picked.map((h, i) => ({ n: i + 1, docId: h.docId, chunkId: h.chunkId, title: h.title, sourceKind: h.sourceKind, occurredAt: h.occurredAt, snippet: h.text.slice(0, 600) }));

  let text: string | null = null;
  let mode: "claude" | "extractive" = "extractive";
  const facts = graphFacts(retrievalQuery, p);
  if (picked.length) {
    const sources = picked.map((h, i) => `[${i + 1}] (${h.sourceKind}, ${h.occurredAt?.slice(0, 10) ?? "undated"}) ${h.title}\n${h.text}`).join("\n\n");
    text = await complete({
      system: "You are the organizational memory assistant for a company. Answer only from the numbered sources and the knowledge-graph facts. Cite every claim with [n]. Knowledge-graph facts are reconciled across sources and take precedence; mention when a fact is pending review. If the sources don't contain the answer, say that. Be concise: a short direct answer, then bullet points.",
      messages: [...history.slice(-6).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), { role: "user", content: `${facts ? `<knowledge_graph>\n${facts.text}\n</knowledge_graph>\n\n` : ""}<sources>\n${sources}\n</sources>\n\nQuestion: ${question}` }],
      effort: "low",
      maxTokens: 4000,
    });
    if (text) mode = "claude";
  }
  if (!text) {
    const body = extractiveAnswer(retrievalQuery, picked);
    text = [facts?.text, body].filter(Boolean).join("\n\n") || "I couldn't find anything in the organizational memory you have access to that answers this.";
  }

  // Related knowledge: entities mentioned in the cited chunks.
  const related = picked.length
    ? all(`SELECT e.id, e.type, e.name, COUNT(*) n FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE m.chunk_id IN (${picked.map(() => "?").join(",")}) AND e.type IN ('project','person','issue','decision','technology','customer') GROUP BY e.id ORDER BY n DESC LIMIT 8`, ...picked.map((h) => h.chunkId))
    : [];

  const totalMs = Math.round(performance.now() - t0);
  if (!threadId) {
    threadId = uid("thr");
    run("INSERT INTO chat_threads(id, user_id, title, created_at) VALUES (?,?,?,?)", threadId, p.user.id, question.slice(0, 80), now());
  }
  run("INSERT INTO chat_messages(id, thread_id, role, content, meta, at) VALUES (?,?,?,?,?,?)", uid("msg"), threadId, "user", question, null, now());
  const meta = { citations, related, retrievalMs: ms, totalMs, mode, retrievalQuery: retrievalQuery !== question ? retrievalQuery : undefined };
  run("INSERT INTO chat_messages(id, thread_id, role, content, meta, at) VALUES (?,?,?,?,?,?)", uid("msg"), threadId, "assistant", text, JSON.stringify(meta), new Date(Date.now() + 1).toISOString());
  return { threadId, answer: text, ...meta };
}

export const threadMessages = (threadId: string) => all("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY at", threadId).map((m) => ({ ...m, meta: json(m.meta, null) }));
