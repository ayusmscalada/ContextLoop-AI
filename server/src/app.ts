import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { all, DATA_DIR, get, getRaw, getSetting, json, now, resetDatabase, ROOT, run, setSetting, type Row } from "./db.js";
import { persistenceInfo } from "./persist.js";
import { audit, can, canReadDoc, Forbidden, invalidateVisibility, requirePermission, resolvePrincipal, visibleDocIds, type Principal } from "./auth.js";
import crypto from "node:crypto";
import { ingestBuffer, listImports } from "./ingest/pipeline.js";
import { fetchGitHubRepo } from "./ingest/github.js";
import type { SourceKind } from "./ingest/parsers.js";
import { answer, buildIndex, indexStats, search, threadMessages } from "./engine/search.js";
import { ensureDefaultAuthority, resolveConflict } from "./engine/ontology.js";
import { getTrace, listTraces, recordTrace, recurringFailures, repeatedWorkflows, traceOverview } from "./engine/traces.js";
import { decideProposal, getProposal, getSkill, listProposals, listSkills, proposeImprovement, proposeNewSkills, refineProposal, rollbackSkill, runLiveExecutions, syncSkills, syncTargets } from "./engine/skills.js";
import { getEvalRun, runEvaluation } from "./eval/harness.js";
import { lastLlmError, llmEnabled, llmStats, MODEL } from "./llm.js";

type Env = { Variables: { p: Principal } };
const app = new Hono<Env>();

app.onError((err, c) => {
  if (err instanceof Forbidden) return c.json({ error: err.message }, 403);
  console.error(err);
  return c.json({ error: err.message ?? "Internal error" }, 500);
});

app.use("/api/*", async (c, next) => {
  // Health and inbound webhooks authenticate themselves (HMAC signature / shared token), not as a user.
  if (c.req.path === "/api/health" || c.req.path.startsWith("/api/webhooks/")) return next();
  const p = resolvePrincipal({ authorization: c.req.header("authorization"), userId: c.req.header("x-user-id") });
  if (!p) return c.json({ error: "Invalid or revoked credentials" }, 401);
  c.set("p", p);
  await next();
});

const P = (c: Context<Env>) => c.get("p");
const visibleEntityIds = (p: Principal): Set<string> => {
  const docs = visibleDocIds(p);
  const out = new Set<string>();
  const withMentions = new Set<string>();
  for (const m of all("SELECT entity_id, doc_id FROM mentions")) {
    withMentions.add(m.entity_id);
    if (docs.has(m.doc_id)) out.add(m.entity_id);
  }
  for (const e of all("SELECT id FROM entities")) if (!withMentions.has(e.id)) out.add(e.id);
  // project entities follow project permissions
  for (const pr of all("SELECT p.id, p.entity_id FROM projects p WHERE restricted = 1")) {
    if (!docs.size || !all("SELECT id FROM documents WHERE project_id = ?", pr.id).some((d) => docs.has(d.id))) out.delete(pr.entity_id);
  }
  return out;
};

app.get("/api/health", (c) => c.json({ ok: true, at: now() }));

// ---------------- identity ----------------
app.get("/api/me", (c) => {
  const p = P(c);
  const users = all("SELECT u.*, (SELECT group_concat(t.name, ', ') FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = u.id) teams FROM users u ORDER BY u.role, u.name");
  return c.json({ principal: p, users, llm: { enabled: llmEnabled(), model: MODEL }, persistence: persistenceInfo() });
});

// ---------------- overview ----------------
app.get("/api/overview", (c) => {
  const p = P(c);
  const docs = visibleDocIds(p);
  const docRows = all("SELECT id, source_kind, ingested_at, occurred_at, size_bytes FROM documents WHERE duplicate_of IS NULL").filter((d) => docs.has(d.id));
  const bySource: Record<string, number> = {};
  for (const d of docRows) bySource[d.source_kind] = (bySource[d.source_kind] ?? 0) + 1;
  const ents = visibleEntityIds(p);
  const entityTypes: Record<string, number> = {};
  for (const e of all("SELECT id, type FROM entities")) if (ents.has(e.id)) entityTypes[e.type] = (entityTypes[e.type] ?? 0) + 1;
  const t = traceOverview();
  const ingestDaily: Record<string, Record<string, number>> = {};
  for (const d of docRows) {
    const day = (d.ingested_at ?? "").slice(0, 10);
    (ingestDaily[day] ??= {})[d.source_kind] = (ingestDaily[day][d.source_kind] ?? 0) + 1;
  }
  const lakeBytes = (get("SELECT SUM(size_bytes) n FROM documents")?.n ?? 0) as number;
  return c.json({
    sessions: (bySource.chatgpt ?? 0) + (bySource.claude_code ?? 0) + (bySource.codex ?? 0),
    bySource,
    documents: docRows.length,
    duplicatesBlocked: get("SELECT COUNT(*) n FROM documents WHERE duplicate_of IS NOT NULL")!.n,
    sources: get("SELECT COUNT(*) n FROM sources WHERE status = 'connected'")!.n,
    entities: ents.size,
    entityTypes,
    relations: get("SELECT COUNT(*) n FROM relations")!.n,
    skills: get("SELECT COUNT(*) n FROM skills")!.n,
    agents: { executions: t.totals.total, rate: t.totals.rate, failures: t.totals.failed, cost: t.totals.cost, tokens: (t.totals.tin ?? 0) + (t.totals.tout ?? 0), bySkill: t.bySkill, daily: t.daily },
    pending: {
      proposals: get("SELECT COUNT(*) n FROM proposals WHERE status IN ('pending','evaluated')")!.n,
      conflicts: get("SELECT COUNT(*) n FROM conflicts WHERE status = 'open'")!.n,
      recurringFailures: recurringFailures().length,
    },
    ingest: { daily: Object.entries(ingestDaily).sort().map(([day, v]) => ({ day, ...v })), chunks: indexStats.chunks, lakeBytes, imports: get("SELECT COUNT(*) n FROM imports")!.n, index: indexStats },
    activity: all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 12"),
    llm: { enabled: llmEnabled(), model: MODEL },
  });
});

// ---------------- sources & ingestion ----------------
app.get("/api/sources", (c) => {
  const sources = all("SELECT * FROM sources").map((s) => ({ ...s, config: json(s.config, {}), items: get("SELECT COUNT(*) n FROM documents WHERE source_kind = ? AND duplicate_of IS NULL", s.kind)!.n }));
  return c.json({ sources, imports: listImports(40) });
});

app.post("/api/import", async (c) => {
  const p = P(c);
  requirePermission(p, "data.import", "upload");
  const body = await c.req.parseBody({ all: true });
  const files = ([] as any[]).concat(body.files ?? body.file ?? []).filter((f) => f && typeof f === "object" && "arrayBuffer" in f) as File[];
  if (!files.length) return c.json({ error: "No files uploaded (field 'files')" }, 400);
  const visibility = (body.visibility as any) || "org";
  const results: any[] = [];
  for (const f of files) {
    const buf = Buffer.from(await f.arrayBuffer());
    try {
      results.push(await ingestBuffer(buf, p, {
        filename: f.name, visibility, teamId: (body.teamId as string) || null, projectId: (body.projectId as string) || null,
        sourceHint: (body.sourceHint as SourceKind) || undefined, origin: (body.origin as string) || "upload",
      }));
    } catch (e: any) {
      results.push({ filename: f.name, error: e.message });
    }
  }
  return c.json({ results });
});

app.get("/api/imports", (c) => c.json(listImports(100)));

// ---------------- live connectors: GitHub + email ----------------
/** Integrations ingest on behalf of a configured owner, attributed to the integration in the audit log. */
function integrationPrincipal(name: string, ownerId?: string): Principal {
  const base = resolvePrincipal({ userId: ownerId ?? process.env.CONTEXTLOOP_INTEGRATION_USER ?? "u_alice" }) ?? resolvePrincipal({ userId: "u_alice" })!;
  return { ...base, kind: "agent", agent: { key: `integration:${name}`, name, scopes: ["data:write"], maxVisibility: "private", allowedProjects: null } };
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** GitHub webhook: push, pull_request, pull_request_review(_comment), issue_comment. */
app.post("/api/webhooks/github", async (c) => {
  const raw = Buffer.from(await c.req.arrayBuffer());
  const event = c.req.header("x-github-event") ?? "unknown";
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  const sig = c.req.header("x-hub-signature-256") ?? "";
  const verified = !!secret && safeEqual(sig, `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`);
  if (secret && !verified) {
    audit(null, "webhook.github", `event:${event}`, "Rejected: invalid X-Hub-Signature-256", "denied");
    return c.json({ error: "Invalid signature" }, 401);
  }
  if (event === "ping") return c.json({ ok: true, pong: true, verified });
  if (!["push", "pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment"].includes(event) && event !== "unknown") {
    return c.json({ ok: true, ignored: event });
  }
  const q = c.req.query();
  const p = integrationPrincipal("GitHub webhook", q.owner);
  const r = await ingestBuffer(raw, p, {
    filename: `github-${event}-${c.req.header("x-github-delivery") ?? Date.now()}.json`, sourceHint: "github", origin: "webhook",
    visibility: (q.visibility as any) ?? "team", teamId: q.team ?? "t_engineering", projectId: q.project || null,
  });
  return c.json({ ok: true, event, verified, documents: r.documents.map((d) => ({ id: d.id, title: d.title, superseded: d.superseded ?? 0, duplicateOf: d.duplicateOf })) });
});

/** Inbound email (Gmail/Outlook forwarding via Cloudflare Email Workers, SendGrid Inbound Parse, …): raw RFC 822. */
app.post("/api/webhooks/email", async (c) => {
  const token = process.env.EMAIL_INGEST_TOKEN?.trim();
  const given = c.req.query("token") ?? c.req.header("x-contextloop-token") ?? "";
  if (token && !safeEqual(given, token)) {
    audit(null, "webhook.email", "inbound", "Rejected: invalid token", "denied");
    return c.json({ error: "Invalid token" }, 401);
  }
  const ctype = c.req.header("content-type") ?? "";
  let raw: Buffer;
  if (ctype.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const f = (body.email ?? body.file ?? body.raw) as any;
    raw = typeof f === "string" ? Buffer.from(f, "latin1") : Buffer.from(await f.arrayBuffer());
  } else if (ctype.includes("application/json")) {
    const j = await c.req.json();
    raw = Buffer.from(String(j.raw ?? j.email ?? ""), "latin1");
  } else raw = Buffer.from(await c.req.arrayBuffer());
  if (!raw.length) return c.json({ error: "Empty message" }, 400);
  const q = c.req.query();
  const p = integrationPrincipal("Email inbound", q.owner);
  const r = await ingestBuffer(raw, p, {
    filename: `inbound-${Date.now()}.eml`, sourceHint: "email", origin: "webhook",
    visibility: (q.visibility as any) ?? "private", teamId: q.team ?? null, projectId: q.project || null,
  });
  return c.json({ ok: true, documents: r.documents.map((d) => ({ id: d.id, title: d.title, superseded: d.superseded ?? 0, duplicateOf: d.duplicateOf })) });
});

/** Pull recent PRs (+ reviews, comments) and commits for a repository via the GitHub REST API. */
app.post("/api/sources/github/sync", async (c) => {
  const p = P(c);
  requirePermission(p, "data.import", "github-sync");
  const b = await c.req.json();
  const repo = String(b.repo ?? "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  const { prs, commits, rateRemaining } = await fetchGitHubRepo(repo, { token: process.env.GITHUB_TOKEN?.trim() || undefined, limit: Number(b.limit ?? 10) });
  const opts = { sourceHint: "github" as const, origin: "github-sync", visibility: b.visibility ?? "team", teamId: b.teamId ?? "t_engineering", projectId: b.projectId || null };
  const results: any[] = [];
  if (prs.length) results.push(await ingestBuffer(Buffer.from(JSON.stringify(prs)), p, { ...opts, filename: `github-${repo.replace("/", "_")}-pulls.json` }));
  if (commits.length) results.push(await ingestBuffer(Buffer.from(JSON.stringify(commits)), p, { ...opts, filename: `github-${repo.replace("/", "_")}-commits.json` }));
  run("UPDATE sources SET last_sync_at = ?, config = json_set(COALESCE(config, '{}'), '$.repo', ?) WHERE kind = 'github'", now(), repo);
  return c.json({ repo, pullRequests: prs.length, commits: commits.length, rateRemaining, results });
});

// ---------------- data lake ----------------
app.get("/api/documents", (c) => {
  const p = P(c);
  const q = c.req.query();
  const docs = visibleDocIds(p);
  let rows = all("SELECT d.id, d.source_kind, d.title, d.filename, d.project_id, d.visibility, d.team_id, d.owner_id, d.occurred_at, d.ingested_at, d.size_bytes, d.duplicate_of, d.metadata, u.name owner_name, pr.name project_name, (SELECT COUNT(*) FROM chunks ch WHERE ch.doc_id = d.id) chunks FROM documents d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN projects pr ON pr.id = d.project_id ORDER BY d.occurred_at DESC")
    .filter((d) => (d.duplicate_of ? docs.has(d.duplicate_of) || d.owner_id === p.user.id : docs.has(d.id)));
  if (q.source) rows = rows.filter((d) => d.source_kind === q.source);
  if (q.project) rows = rows.filter((d) => d.project_id === q.project);
  if (q.q) rows = rows.filter((d) => d.title.toLowerCase().includes(q.q.toLowerCase()));
  return c.json(rows.map((d) => ({ ...d, metadata: json(d.metadata, {}) })));
});

app.get("/api/documents/:id", (c) => {
  const p = P(c);
  const d = get("SELECT d.*, u.name owner_name, pr.name project_name, t.name team_name FROM documents d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN projects pr ON pr.id = d.project_id LEFT JOIN teams t ON t.id = d.team_id WHERE d.id = ?", c.req.param("id"));
  if (!d) return c.json({ error: "Not found" }, 404);
  const target = d.duplicate_of ? get("SELECT * FROM documents WHERE id = ?", d.duplicate_of)! : d;
  if (!canReadDoc(p, target) && d.owner_id !== p.user.id) {
    audit(p, "knowledge.read", `document:${d.id}`, "Blocked by visibility policy", "denied");
    return c.json({ error: "You do not have access to this document" }, 403);
  }
  const chunks = all("SELECT id, idx, text, speaker FROM chunks WHERE doc_id = ? ORDER BY idx", d.id);
  const entities = all("SELECT DISTINCT e.id, e.type, e.name FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE m.doc_id = ? ORDER BY e.type, e.name", d.id);
  let raw = "";
  const rawBuf = getRaw(d.raw_path);
  if (rawBuf) {
    raw = rawBuf.subarray(0, 200_000).toString("utf8");
    if (rawBuf.length > 200_000) raw += "\n…[raw preview truncated]";
  }
  return c.json({ ...d, metadata: json(d.metadata, {}), chunks, entities, raw, duplicate: d.duplicate_of ? { id: target.id, title: target.title } : null });
});

app.get("/api/documents/:id/raw", (c) => {
  const p = P(c);
  const d = get("SELECT * FROM documents WHERE id = ?", c.req.param("id"));
  if (!d || !canReadDoc(p, d)) return c.json({ error: "Not found" }, 404);
  const buf = getRaw(d.raw_path);
  if (!buf) return c.json({ error: "Raw object missing" }, 404);
  return new Response(new Uint8Array(buf), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${d.filename}"` } });
});

app.put("/api/documents/:id/visibility", async (c) => {
  const p = P(c);
  const d = get("SELECT * FROM documents WHERE id = ?", c.req.param("id"));
  if (!d) return c.json({ error: "Not found" }, 404);
  if (d.owner_id !== p.user.id && p.user.role !== "admin") requirePermission(p, "admin.manage", `document:${d.id}`);
  const b = await c.req.json();
  run("UPDATE documents SET visibility = ?, team_id = ? WHERE id = ?", b.visibility, b.visibility === "team" ? b.teamId : null, d.id);
  invalidateVisibility();
  audit(p, "document.share", `document:${d.id}`, `Visibility → ${b.visibility}${b.teamId ? ` (${b.teamId})` : ""}`);
  return c.json({ ok: true });
});

// ---------------- knowledge graph ----------------
app.get("/api/graph", (c) => {
  const p = P(c);
  const ents = visibleEntityIds(p);
  const docs = visibleDocIds(p);
  const types = c.req.query("types")?.split(",").filter(Boolean);
  const nodes = all("SELECT e.id, e.type, e.name, e.attributes, (SELECT COUNT(DISTINCT doc_id) FROM mentions m WHERE m.entity_id = e.id) mentions FROM entities e")
    .filter((e) => ents.has(e.id) && (!types || types.includes(e.type)))
    .map((e) => ({ ...e, attributes: json(e.attributes, {}) }));
  const ids = new Set(nodes.map((n) => n.id));
  const edgeMap = new Map<string, Row>();
  for (const r of all("SELECT src_id, dst_id, type, doc_id, confidence FROM relations")) {
    if (!ids.has(r.src_id) || !ids.has(r.dst_id) || (r.doc_id && !docs.has(r.doc_id))) continue;
    const k = `${r.src_id}|${r.dst_id}|${r.type}`;
    const e = edgeMap.get(k);
    if (e) e.weight++;
    else edgeMap.set(k, { id: k, source: r.src_id, target: r.dst_id, type: r.type, weight: 1 });
  }
  return c.json({ nodes, edges: [...edgeMap.values()] });
});

app.get("/api/entities", (c) => {
  const p = P(c);
  const ents = visibleEntityIds(p);
  const { type, q } = c.req.query();
  return c.json(all("SELECT id, type, name, description, attributes, updated_at FROM entities ORDER BY type, name").filter((e) => ents.has(e.id) && (!type || e.type === type) && (!q || e.name.toLowerCase().includes(q.toLowerCase()))).map((e) => ({ ...e, attributes: json(e.attributes, {}) })));
});

function entityDetail(p: Principal, id: string) {
  const e = get("SELECT * FROM entities WHERE id = ? OR key = ?", id, id.toLowerCase());
  if (!e || !visibleEntityIds(p).has(e.id)) return null;
  const docs = visibleDocIds(p);
  const claims = all("SELECT c.*, d.title doc_title, d.source_kind FROM claims c LEFT JOIN documents d ON d.id = c.doc_id WHERE c.entity_id = ? ORDER BY c.observed_at", e.id).filter((x) => !x.doc_id || docs.has(x.doc_id));
  const mentions = all("SELECT m.doc_id, m.snippet, d.title, d.source_kind, d.occurred_at FROM mentions m JOIN documents d ON d.id = m.doc_id WHERE m.entity_id = ? ORDER BY d.occurred_at DESC", e.id).filter((m) => docs.has(m.doc_id));
  const relations = all(
    `SELECT r.type, r.src_id, r.dst_id, r.doc_id, r.snippet, s.name src_name, s.type src_type, t.name dst_name, t.type dst_type FROM relations r JOIN entities s ON s.id = r.src_id JOIN entities t ON t.id = r.dst_id WHERE r.src_id = ? OR r.dst_id = ?`, e.id, e.id,
  ).filter((r) => !r.doc_id || docs.has(r.doc_id));
  const ents = visibleEntityIds(p);
  const relMap = new Map<string, Row>();
  for (const r of relations) {
    const other = r.src_id === e.id ? { id: r.dst_id, name: r.dst_name, entityType: r.dst_type, dir: "out" } : { id: r.src_id, name: r.src_name, entityType: r.src_type, dir: "in" };
    if (!ents.has(other.id)) continue;
    const k = `${r.type}|${other.id}`;
    const v = relMap.get(k);
    if (v) v.evidence++;
    else relMap.set(k, { type: r.type, ...other, evidence: 1 });
  }
  const conflicts = all("SELECT * FROM conflicts WHERE entity_id = ? ORDER BY created_at DESC", e.id).map((cf) => ({ ...cf, scores: json(cf.scores, []) }));
  const history = all("SELECT h.*, d.title doc_title FROM entity_history h LEFT JOIN documents d ON d.id = h.doc_id WHERE entity_id = ? ORDER BY at DESC", e.id).filter((h) => !h.doc_id || docs.has(h.doc_id));
  const byDoc = new Map<string, Row>();
  for (const m of mentions) if (!byDoc.has(m.doc_id)) byDoc.set(m.doc_id, m);
  return { ...e, aliases: json(e.aliases, []), attributes: json(e.attributes, {}), claims, evidence: [...byDoc.values()], relations: [...relMap.values()], conflicts, history };
}

app.get("/api/entities/:id", (c) => {
  const d = entityDetail(P(c), c.req.param("id"));
  return d ? c.json(d) : c.json({ error: "Not found" }, 404);
});

app.get("/api/conflicts", (c) => {
  const p = P(c);
  const ents = visibleEntityIds(p);
  const docs = visibleDocIds(p);
  const status = c.req.query("status");
  const rows = all(`SELECT cf.*, e.name entity_name, e.type entity_type FROM conflicts cf JOIN entities e ON e.id = cf.entity_id ${status ? "WHERE cf.status = ?" : ""} ORDER BY cf.created_at DESC`, ...(status ? [status] : [])).filter((r) => ents.has(r.entity_id));
  return c.json(rows.map((r) => ({
    ...r,
    scores: json(r.scores, []),
    claims: all("SELECT c.*, d.title doc_title, d.source_kind, d.occurred_at doc_date FROM claims c LEFT JOIN documents d ON d.id = c.doc_id WHERE c.entity_id = ? AND c.predicate = ? ORDER BY c.observed_at", r.entity_id, r.predicate).filter((x) => !x.doc_id || docs.has(x.doc_id)),
  })));
});

app.post("/api/conflicts/:id/resolve", async (c) => {
  const p = P(c);
  requirePermission(p, "knowledge.resolve", `conflict:${c.req.param("id")}`);
  const b = await c.req.json();
  resolveConflict(c.req.param("id"), b.claimId, p.user.name, b.note);
  audit(p, "knowledge.resolve", `conflict:${c.req.param("id")}`, `Accepted claim ${b.claimId}${b.note ? ` — ${b.note}` : ""}`);
  return c.json({ ok: true });
});

app.get("/api/authority", (c) => c.json(all("SELECT * FROM source_authority ORDER BY weight DESC")));
app.put("/api/authority", async (c) => {
  const p = P(c);
  requirePermission(p, "settings.write", "source_authority");
  const b = (await c.req.json()) as { source_kind: string; weight: number }[];
  for (const r of b) run("UPDATE source_authority SET weight = ? WHERE source_kind = ?", Math.max(0, Math.min(1, r.weight)), r.source_kind);
  audit(p, "settings.authority", "source_authority", b.map((r) => `${r.source_kind}=${r.weight}`).join(", "));
  return c.json({ ok: true });
});

// ---------------- search & memory ----------------
app.get("/api/search", (c) => {
  const p = P(c);
  requirePermission(p, "knowledge.read", "search");
  const q = c.req.query();
  const r = search(q.q ?? "", p, { mode: q.mode as any, projectId: q.project || undefined, sources: q.sources ? q.sources.split(",") : undefined, from: q.from || undefined, to: q.to || undefined, limit: Number(q.limit ?? 15) });
  audit(p, "knowledge.search", `query:${(q.q ?? "").slice(0, 60)}`, `${r.hits.length} hits in ${r.ms} ms`);
  return c.json({ ...r, index: indexStats });
});

app.post("/api/ask", async (c) => {
  const p = P(c);
  requirePermission(p, "knowledge.read", "ask");
  const b = await c.req.json();
  const r = await answer(String(b.question ?? ""), p, { threadId: b.threadId, filters: b.filters });
  audit(p, "knowledge.ask", `question:${String(b.question).slice(0, 60)}`, `${r.citations.length} citations, ${r.mode}, ${r.totalMs} ms`);
  return c.json(r);
});

app.get("/api/threads", (c) => c.json(all("SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) messages FROM chat_threads t WHERE user_id = ? ORDER BY created_at DESC LIMIT 30", P(c).user.id)));
app.get("/api/threads/:id", (c) => {
  const t = get("SELECT * FROM chat_threads WHERE id = ? AND user_id = ?", c.req.param("id"), P(c).user.id);
  return t ? c.json({ ...t, messages: threadMessages(t.id) }) : c.json({ error: "Not found" }, 404);
});

// ---------------- agents / traces ----------------
app.get("/api/traces/overview", (c) => {
  requirePermission(P(c), "traces.read", "traces");
  return c.json({ ...traceOverview(), recurring: recurringFailures(), workflows: repeatedWorkflows() });
});
app.get("/api/traces", (c) => {
  requirePermission(P(c), "traces.read", "traces");
  const q = c.req.query();
  return c.json(listTraces({ skillId: q.skill, status: q.status, agent: q.agent, signature: q.signature, origin: q.origin, limit: Number(q.limit ?? 50), offset: Number(q.offset ?? 0) }));
});
app.get("/api/traces/:id", (c) => {
  requirePermission(P(c), "traces.read", "traces");
  const t = getTrace(c.req.param("id"));
  return t ? c.json(t) : c.json({ error: "Not found" }, 404);
});
app.post("/api/traces", async (c) => {
  const p = P(c);
  requirePermission(p, "traces.write", "traces");
  const b = await c.req.json();
  const items = Array.isArray(b) ? b : [b];
  const ids = items.map((t) => recordTrace(t, { origin: p.agent ? "mcp" : "api", userId: p.user.id }));
  audit(p, "traces.report", `traces:${ids.length}`, items.map((t) => `${t.agent}/${t.skill ?? "-"}: ${t.status}`).join("; "));
  return c.json({ ids });
});
app.post("/api/agents/live-run", async (c) => {
  const p = P(c);
  requirePermission(p, "traces.write", "live-run");
  const b = await c.req.json();
  const r = await runLiveExecutions(b.skill ?? "api-integration", Math.min(Number(b.n ?? 20), 60), p.user.id);
  audit(p, "agents.live_run", `skill:${b.skill ?? "api-integration"}`, `${r.succeeded}/${r.executed} succeeded on v${r.version}`);
  return c.json(r);
});

// ---------------- skills & improvement lab ----------------
app.get("/api/skills", (c) => {
  requirePermission(P(c), "skills.read", "skills");
  return c.json({ skills: listSkills(), targets: syncTargets() });
});
app.get("/api/skills/:id", (c) => {
  const p = P(c);
  requirePermission(p, "skills.read", `skill:${c.req.param("id")}`);
  const s = getSkill(c.req.param("id"));
  if (!s) return c.json({ error: "Not found" }, 404);
  const proposals = listProposals().filter((x) => x.skill_id === s.id);
  const evals = all("SELECT id, baseline_label, candidate_label, baseline_rate, candidate_rate, compiler, created_at FROM eval_runs WHERE skill_id = ? ORDER BY created_at DESC", s.id);
  return c.json({ ...s, proposals, evals });
});
app.post("/api/skills/:id/rollback", async (c) => {
  const p = P(c);
  requirePermission(p, "skills.approve", `skill:${c.req.param("id")}`);
  const b = await c.req.json();
  const r = rollbackSkill(c.req.param("id"), Number(b.version));
  audit(p, "skills.rollback", `skill:${c.req.param("id")}`, `Active version → v${b.version}`);
  return c.json(r);
});
app.post("/api/skills/sync", (c) => {
  const p = P(c);
  requirePermission(p, "skills.approve", "skills");
  const r = syncSkills();
  audit(p, "skills.sync", "skills", r.map((x) => `${x.harness}: ${x.skills}`).join(", "));
  return c.json(r);
});

app.get("/api/proposals", (c) => c.json(listProposals(c.req.query("status"))));
app.get("/api/proposals/:id", (c) => {
  const pr = getProposal(c.req.param("id"));
  if (!pr) return c.json({ error: "Not found" }, 404);
  return c.json({ ...pr, eval: pr.eval_run_id ? getEvalRun(pr.eval_run_id) : null });
});
app.post("/api/lab/analyze", async (c) => {
  const p = P(c);
  requirePermission(p, "skills.propose", "lab");
  const b = await c.req.json().catch(() => ({}));
  const created: string[] = [];
  const skillIds = b.skillId ? [b.skillId] : [...new Set(recurringFailures().map((f) => f.skillId).filter(Boolean))] as string[];
  for (const sid of skillIds) {
    if (get("SELECT id FROM proposals WHERE skill_id = ? AND status IN ('pending','evaluated') AND base_version = (SELECT active_version FROM skills WHERE id = ?)", sid, sid)) continue;
    const id = await proposeImprovement(sid, p.user.id);
    if (id) created.push(id);
  }
  created.push(...proposeNewSkills(p.user.id));
  audit(p, "skills.analyze", "traces", `${created.length} new proposal(s)`);
  return c.json({ created });
});
app.post("/api/proposals/:id/evaluate", async (c) => {
  const p = P(c);
  requirePermission(p, "skills.evaluate", `proposal:${c.req.param("id")}`);
  const pr = getProposal(c.req.param("id"));
  if (!pr || pr.kind !== "improve") return c.json({ error: "Only skill improvements can be evaluated" }, 400);
  const ev = await runEvaluation({ skillId: pr.skill_id, proposalId: pr.id, baseline: { label: `v${pr.base_version} (current)`, content: pr.base_content }, candidate: { label: "proposed", content: pr.proposed_content } });
  run("UPDATE proposals SET eval_run_id = ?, status = CASE WHEN status = 'pending' THEN 'evaluated' ELSE status END WHERE id = ?", ev.id, pr.id);
  audit(p, "skills.evaluate", `proposal:${pr.id}`, `baseline ${(ev.baseline_rate * 100).toFixed(0)}% → candidate ${(ev.candidate_rate * 100).toFixed(0)}% on ${ev.results.length} cases`);
  return c.json(ev);
});
app.post("/api/proposals/:id/refine", async (c) => {
  const p = P(c);
  requirePermission(p, "skills.propose", `proposal:${c.req.param("id")}`);
  const pr = getProposal(c.req.param("id"));
  if (!pr?.eval_run_id) return c.json({ error: "Run an evaluation first" }, 400);
  const r = await refineProposal(pr.id, getEvalRun(pr.eval_run_id)!, p);
  audit(p, "skills.refine", `proposal:${pr.id}`, r.changed ? `Revised for ${(r as any).errorTypes.join(", ")}` : (r as any).reason);
  return c.json(r);
});
app.post("/api/proposals/:id/decide", async (c) => {
  const p = P(c);
  requirePermission(p, "skills.approve", `proposal:${c.req.param("id")}`);
  const b = await c.req.json();
  const r = decideProposal(c.req.param("id"), b.decision, p.user.id, b.note);
  audit(p, `skills.${b.decision}`, `proposal:${c.req.param("id")}`, r.status === "approved" ? `Activated v${(r as any).version}, synced to ${(r as any).synced?.length ?? 0} harness(es)` : b.note ?? "");
  return c.json(r);
});
app.get("/api/evals/:id", (c) => {
  const ev = getEvalRun(c.req.param("id"));
  return ev ? c.json(ev) : c.json({ error: "Not found" }, 404);
});

// ---------------- agent-facing context (used by MCP + CLI) ----------------
app.get("/api/context/project/:id", (c) => {
  const p = P(c);
  requirePermission(p, "knowledge.read", `project:${c.req.param("id")}`);
  const id = c.req.param("id");
  const proj = get("SELECT * FROM projects WHERE id = ? OR lower(name) = lower(?) OR lower(name) = lower(?)", id, id, `project ${id}`);
  if (!proj) return c.json({ error: "Unknown project" }, 404);
  const docs = visibleDocIds(p);
  const projDocs = all("SELECT id, title, source_kind, occurred_at FROM documents WHERE project_id = ? AND duplicate_of IS NULL ORDER BY occurred_at DESC", proj.id).filter((d) => docs.has(d.id));
  if (!projDocs.length && proj.restricted) {
    audit(p, "knowledge.read", `project:${proj.id}`, "Restricted project", "denied");
    return c.json({ error: "Unknown project" }, 404);
  }
  const ent = entityDetail(p, proj.entity_id);
  audit(p, "context.project", `project:${proj.id}`, `${projDocs.length} sources`);
  return c.json({
    project: { id: proj.id, name: proj.name, description: proj.description },
    attributes: ent?.attributes ?? {},
    openConflicts: (ent?.conflicts ?? []).filter((x: Row) => x.status === "open").map((x: Row) => ({ predicate: x.predicate, rationale: x.rationale })),
    decisions: (ent?.relations ?? []).filter((r: Row) => r.type === "decision_for").map((r: Row) => r.name),
    people: (ent?.relations ?? []).filter((r: Row) => r.type === "works_on" || r.type === "owns").map((r: Row) => r.name),
    issues: (ent?.relations ?? []).filter((r: Row) => r.type === "affects").map((r: Row) => r.name),
    technologies: (ent?.relations ?? []).filter((r: Row) => r.type === "uses").map((r: Row) => r.name),
    recentSources: projDocs.slice(0, 10),
  });
});

// ---------------- team & permissions ----------------
app.get("/api/team", (c) => {
  const p = P(c);
  return c.json({
    users: all("SELECT u.*, (SELECT group_concat(tm.team_id) FROM team_members tm WHERE tm.user_id = u.id) team_ids FROM users u ORDER BY name").map((u) => ({ ...u, team_ids: (u.team_ids ?? "").split(",").filter(Boolean) })),
    teams: all("SELECT t.*, (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) members FROM teams t"),
    projects: all("SELECT p.*, t.name team_name FROM projects p LEFT JOIN teams t ON t.id = p.team_id"),
    workspaces: all("SELECT * FROM workspaces"),
    keys: all("SELECT k.key, k.name, k.user_id, u.name user_name, k.scopes, k.max_visibility, k.allowed_projects, k.created_at, k.last_used_at, k.revoked FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at")
      .filter((k) => p.user.role === "admin" || k.user_id === p.user.id)
      .map((k) => ({ ...k, key: p.user.role === "admin" || k.user_id === p.user.id ? k.key : k.key.slice(0, 10) + "…", scopes: json(k.scopes, []), allowed_projects: json(k.allowed_projects, null) })),
    canManage: can(p, "admin.manage"),
  });
});
app.put("/api/users/:id/role", async (c) => {
  const p = P(c);
  requirePermission(p, "admin.manage", `user:${c.req.param("id")}`);
  const b = await c.req.json();
  run("UPDATE users SET role = ? WHERE id = ?", b.role, c.req.param("id"));
  audit(p, "admin.role", `user:${c.req.param("id")}`, `Role → ${b.role}`);
  return c.json({ ok: true });
});
app.post("/api/keys", async (c) => {
  const p = P(c);
  const b = await c.req.json();
  const userId = b.userId && p.user.role === "admin" ? b.userId : p.user.id;
  const key = `clk_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  run("INSERT INTO api_keys(key, name, user_id, scopes, max_visibility, allowed_projects, created_at) VALUES (?,?,?,?,?,?,?)", key, b.name ?? "Agent key", userId, JSON.stringify(b.scopes ?? ["knowledge:read", "skills:read"]), b.maxVisibility ?? "team", b.allowedProjects?.length ? JSON.stringify(b.allowedProjects) : null, now());
  audit(p, "admin.key_create", `key:${key.slice(0, 12)}…`, `${b.name} for ${userId}: ${(b.scopes ?? []).join(",")}, max ${b.maxVisibility}`);
  return c.json({ key });
});
app.delete("/api/keys/:key", (c) => {
  const p = P(c);
  const k = get("SELECT * FROM api_keys WHERE key = ?", c.req.param("key"));
  if (!k) return c.json({ error: "Not found" }, 404);
  if (k.user_id !== p.user.id) requirePermission(p, "admin.manage", "key");
  run("UPDATE api_keys SET revoked = 1 WHERE key = ?", k.key);
  audit(p, "admin.key_revoke", `key:${k.key.slice(0, 12)}…`, k.name);
  return c.json({ ok: true });
});
/** Access simulator: run the same query as different principals to show policy enforcement. */
app.post("/api/permissions/simulate", async (c) => {
  const p = P(c);
  const b = await c.req.json();
  const subjects: { label: string; principal: Principal | null }[] = [];
  for (const u of all("SELECT id, name FROM users ORDER BY role, name")) subjects.push({ label: u.name, principal: resolvePrincipal({ userId: u.id }) });
  for (const k of all("SELECT key, name FROM api_keys WHERE revoked = 0")) subjects.push({ label: `🤖 ${k.name}`, principal: resolvePrincipal({ authorization: `Bearer ${k.key}` }) });
  const results = subjects.map(({ label, principal }) => {
    if (!principal) return { label, error: "invalid" };
    if (!can(principal, "knowledge.read")) return { label, kind: principal.kind, allowed: false, hits: [], reason: "Missing knowledge:read scope" };
    const r = search(String(b.query ?? ""), principal, { limit: 5 });
    return { label, kind: principal.kind, role: principal.user.role, allowed: true, hits: r.hits.map((h) => ({ title: h.title, sourceKind: h.sourceKind })), docs: visibleDocIds(principal).size };
  });
  audit(p, "permissions.simulate", `query:${String(b.query).slice(0, 60)}`, `${results.length} principals evaluated`);
  return c.json(results);
});

// ---------------- audit & settings ----------------
app.get("/api/audit", (c) => {
  const p = P(c);
  const q = c.req.query();
  const where: string[] = [];
  const args: any[] = [];
  if (p.user.role !== "admin") { where.push("(actor_id = ? OR actor_name LIKE ?)"); args.push(p.user.id, `%${p.user.name}%`); }
  if (q.outcome) { where.push("outcome = ?"); args.push(q.outcome); }
  if (q.actorType) { where.push("actor_type = ?"); args.push(q.actorType); }
  if (q.q) { where.push("(action LIKE ? OR resource LIKE ? OR detail LIKE ? OR actor_name LIKE ?)"); args.push(...Array(4).fill(`%${q.q}%`)); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return c.json({ rows: all(`SELECT * FROM audit_logs ${w} ORDER BY id DESC LIMIT ?`, ...args, Number(q.limit ?? 200)), total: get(`SELECT COUNT(*) n FROM audit_logs ${w}`, ...args)!.n });
});

app.get("/api/settings", (c) => c.json({
  llm: { enabled: llmEnabled(), configured: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), model: MODEL, toggle: getSetting("llm.enabled", true), stats: llmStats, lastError: lastLlmError },
  syncTargets: getSetting("sync.targets", null) ?? syncTargets(),
  authority: all("SELECT * FROM source_authority ORDER BY weight DESC"),
  storage: { dataDir: path.relative(ROOT, DATA_DIR) || DATA_DIR, lake: "raw_objects table (content-addressed)", rawObjects: get("SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM raw_objects"), persistence: persistenceInfo(), index: indexStats },
}));
app.put("/api/settings", async (c) => {
  const p = P(c);
  requirePermission(p, "settings.write", "settings");
  const b = await c.req.json();
  if (typeof b.llmEnabled === "boolean") setSetting("llm.enabled", b.llmEnabled);
  if (Array.isArray(b.syncTargets)) setSetting("sync.targets", b.syncTargets);
  audit(p, "settings.update", "settings", JSON.stringify(b).slice(0, 200));
  return c.json({ ok: true });
});
app.post("/api/admin/reset", async (c) => {
  const p = P(c);
  requirePermission(p, "admin.manage", "demo");
  const { seed } = await import("./seed.js");
  const counts = await seed({ quiet: true });
  return c.json({ ok: true, counts });
});

// ---------------- shared bootstrap ----------------
let prepared: Promise<{ seeded: boolean }> | null = null;
/** Idempotent startup: default authority weights, demo seed on an empty database, search index. */
export function prepare(): Promise<{ seeded: boolean }> {
  return (prepared ??= (async () => {
    ensureDefaultAuthority();
    let seeded = false;
    if (!get("SELECT id FROM users LIMIT 1")) {
      console.log("Empty database — seeding demo organization…");
      const { seed } = await import("./seed.js");
      try {
        await seed({ quiet: true });
      } catch (e) {
        // Never leave (or persist) a half-seeded database: wipe it so the next request retries cleanly.
        resetDatabase();
        throw e;
      }
      seeded = true;
    }
    buildIndex();
    return { seeded };
  })().catch((e) => { prepared = null; throw e; }));
}

export { app, indexStats, llmEnabled, MODEL };
