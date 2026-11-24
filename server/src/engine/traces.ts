/**
 * Agent observability: trace storage, failure signatures, recurring failure
 * clustering and repeated-workflow mining (candidate new skills).
 */
import { all, get, json, now, run, uid, type Row } from "../db.ts";
import type { TraceInput } from "../ingest/parsers.ts";

export function errorSignature(type: string | null | undefined, msg: string | null | undefined): string | null {
  if (!type && !msg) return null;
  const m = (msg ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/"[^"]*"/g, "<name>")
    .replace(/[a-z]:\\\S+|\/[\w./-]+/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${type ?? "error"}: ${m}`;
}

const PRICE_IN = 3 / 1e6, PRICE_OUT = 15 / 1e6;

export function recordTrace(t: TraceInput, o: { origin: string; userId?: string | null; startedAt?: string }): string {
  const skill = t.skill ? get("SELECT id, active_version FROM skills WHERE slug = ? OR id = ?", t.skill, t.skill) : undefined;
  const project = t.project ? get("SELECT id FROM projects WHERE id = ? OR lower(name) = lower(?)", t.project, t.project) : undefined;
  const id = uid("trc");
  const tokensIn = t.tokens_in ?? 0, tokensOut = t.tokens_out ?? 0;
  run(
    `INSERT INTO traces(id, agent, harness, skill_id, skill_version, task, project_id, status, error_type, error_message, signature, tokens_in, tokens_out, latency_ms, cost_usd, started_at, steps, fault, origin, user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, t.agent, t.harness ?? null, skill?.id ?? null, t.skill_version ?? skill?.active_version ?? null, t.task, project?.id ?? null, t.status,
    t.error_type ?? null, t.error_message ?? null, t.status === "failure" ? errorSignature(t.error_type, t.error_message) : null,
    tokensIn, tokensOut, t.latency_ms ?? null, t.cost_usd ?? +(tokensIn * PRICE_IN + tokensOut * PRICE_OUT).toFixed(5),
    o.startedAt ?? t.started_at ?? now(), JSON.stringify(t.steps ?? []), JSON.stringify((t as any).fault ?? null), o.origin, o.userId ?? null,
  );
  return id;
}

export function listTraces(f: { skillId?: string; status?: string; agent?: string; signature?: string; limit?: number; offset?: number; origin?: string }) {
  const where: string[] = [];
  const args: any[] = [];
  if (f.skillId) { where.push("t.skill_id = ?"); args.push(f.skillId); }
  if (f.status) { where.push("t.status = ?"); args.push(f.status); }
  if (f.agent) { where.push("t.agent = ?"); args.push(f.agent); }
  if (f.signature) { where.push("t.signature = ?"); args.push(f.signature); }
  if (f.origin) { where.push("t.origin = ?"); args.push(f.origin); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = get(`SELECT COUNT(*) n FROM traces t ${w}`, ...args)!.n;
  const rows = all(`SELECT t.id, t.agent, t.harness, t.skill_id, s.name AS skill_name, t.skill_version, t.task, t.status, t.error_type, t.error_message, t.signature, t.tokens_in, t.tokens_out, t.latency_ms, t.cost_usd, t.started_at, t.origin FROM traces t LEFT JOIN skills s ON s.id = t.skill_id ${w} ORDER BY t.started_at DESC LIMIT ? OFFSET ?`, ...args, f.limit ?? 50, f.offset ?? 0);
  return { total, rows };
}

export function getTrace(id: string) {
  const t = get("SELECT t.*, s.name AS skill_name, s.slug AS skill_slug FROM traces t LEFT JOIN skills s ON s.id = t.skill_id WHERE t.id = ?", id);
  if (!t) return null;
  return { ...t, steps: json(t.steps, []), fault: json(t.fault, null) };
}

export function traceOverview() {
  const totals = get("SELECT COUNT(*) total, SUM(status='success') ok, SUM(status='failure') failed, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(cost_usd) cost, AVG(latency_ms) lat FROM traces")!;
  const bySkill = all(
    `SELECT s.id, s.name, s.slug, s.active_version, COUNT(t.id) runs, SUM(t.status='success') ok, AVG(t.latency_ms) lat, SUM(t.cost_usd) cost, SUM(t.tokens_in + t.tokens_out) tokens
     FROM skills s LEFT JOIN traces t ON t.skill_id = s.id GROUP BY s.id ORDER BY runs DESC`,
  ).map((r) => ({ ...r, rate: r.runs ? r.ok / r.runs : null }));
  const byAgent = all("SELECT agent, harness, COUNT(*) runs, SUM(status='success') ok, AVG(latency_ms) lat, SUM(cost_usd) cost FROM traces GROUP BY agent, harness ORDER BY runs DESC").map((r) => ({ ...r, rate: r.ok / r.runs }));
  const daily = all("SELECT substr(started_at,1,10) day, SUM(status='success') ok, SUM(status='failure') failed, SUM(cost_usd) cost, SUM(tokens_in+tokens_out) tokens FROM traces GROUP BY day ORDER BY day DESC LIMIT 30").reverse();
  const errors = all("SELECT error_type, COUNT(*) n FROM traces WHERE status='failure' GROUP BY error_type ORDER BY n DESC");
  const tools = new Map<string, { calls: number; errors: number; latency: number }>();
  for (const r of all("SELECT steps FROM traces ORDER BY started_at DESC LIMIT 600")) {
    for (const s of json<any[]>(r.steps, [])) {
      if (s.type !== "tool_call") continue;
      const k = s.name ?? "tool";
      const v = tools.get(k) ?? { calls: 0, errors: 0, latency: 0 };
      v.calls++;
      if (s.status === "error") v.errors++;
      v.latency += s.latency_ms ?? 0;
      tools.set(k, v);
    }
  }
  return {
    totals: { ...totals, rate: totals.total ? totals.ok / totals.total : 0 },
    bySkill, byAgent, daily, errors,
    tools: [...tools.entries()].map(([name, v]) => ({ name, ...v, avgLatency: v.calls ? Math.round(v.latency / v.calls) : 0 })).sort((a, b) => b.calls - a.calls).slice(0, 12),
  };
}

export interface FailureCluster { skillId: string | null; skillName: string | null; signature: string; errorType: string; count: number; share: number; firstSeen: string; lastSeen: string; sampleTraceIds: string[]; agents: string[]; windowRuns: number; windowFailures: number }

/** Group failures by (skill, normalized signature). Recurring = seen ≥ 3 times. */
export function recurringFailures(minCount = 3): FailureCluster[] {
  const rows = all(
    `SELECT t.skill_id, s.name skill_name, t.signature, t.error_type, COUNT(*) n, MIN(t.started_at) first, MAX(t.started_at) last, GROUP_CONCAT(t.id) ids, GROUP_CONCAT(DISTINCT t.agent) agents
     FROM traces t LEFT JOIN skills s ON s.id = t.skill_id WHERE t.status='failure' AND t.signature IS NOT NULL AND t.origin != 'eval'
     GROUP BY t.skill_id, t.signature HAVING n >= ? ORDER BY n DESC`, minCount,
  );
  return rows.map((r) => {
    const runs = get("SELECT COUNT(*) n FROM traces WHERE skill_id IS ? AND origin != 'eval'", r.skill_id)!.n;
    const recent = all("SELECT status, signature FROM traces WHERE skill_id IS ? AND origin != 'eval' ORDER BY started_at DESC LIMIT 20", r.skill_id);
    return {
      skillId: r.skill_id, skillName: r.skill_name, signature: r.signature, errorType: r.error_type, count: r.n, share: runs ? r.n / runs : 0,
      firstSeen: r.first, lastSeen: r.last, sampleTraceIds: (r.ids as string).split(",").slice(-8).reverse(), agents: (r.agents as string).split(","),
      windowRuns: recent.length, windowFailures: recent.filter((x) => x.signature === r.signature).length,
    };
  });
}

/** Mine tool-call sequences in traces to find repeated multi-step workflows no skill covers. */
export function repeatedWorkflows(minSupport = 5) {
  const counts = new Map<string, { traces: Set<string>; tasks: Set<string> }>();
  for (const r of all("SELECT id, task, steps FROM traces WHERE skill_id IS NULL AND status='success'")) {
    const seq = json<any[]>(r.steps, []).filter((s) => s.type === "tool_call").map((s) => s.name as string);
    const seen = new Set<string>();
    for (let n = 3; n <= 5; n++) {
      for (let i = 0; i + n <= seq.length; i++) {
        const key = seq.slice(i, i + n).join(" → ");
        if (seen.has(key)) continue;
        seen.add(key);
        const v = counts.get(key) ?? { traces: new Set(), tasks: new Set() };
        v.traces.add(r.id);
        v.tasks.add(r.task);
        counts.set(key, v);
      }
    }
  }
  const out = [...counts.entries()].filter(([, v]) => v.traces.size >= minSupport).map(([k, v]) => ({ sequence: k, steps: k.split(" → "), support: v.traces.size, exampleTasks: [...v.tasks].slice(0, 4), traceIds: [...v.traces].slice(0, 6) }));
  // keep maximal sequences only
  return out
    .filter((a) => !out.some((b) => b !== a && b.steps.length > a.steps.length && b.sequence.includes(a.sequence) && b.support >= a.support))
    .sort((a, b) => b.support * b.steps.length - a.support * a.steps.length)
    .slice(0, 5);
}

export function skillStats(skillId: string) {
  const byVersion = all("SELECT skill_version v, COUNT(*) runs, SUM(status='success') ok, AVG(latency_ms) lat FROM traces WHERE skill_id = ? AND origin != 'eval' GROUP BY skill_version ORDER BY v", skillId).map((r) => ({ ...r, rate: r.ok / r.runs }));
  const recent = all("SELECT status FROM traces WHERE skill_id = ? AND origin != 'eval' ORDER BY started_at DESC LIMIT 20", skillId);
  const total = get("SELECT COUNT(*) runs, SUM(status='success') ok FROM traces WHERE skill_id = ? AND origin != 'eval'", skillId)!;
  return { byVersion, recentRate: recent.length ? recent.filter((r) => r.status === "success").length / recent.length : null, recentRuns: recent.length, runs: total.runs, rate: total.runs ? total.ok / total.runs : null };
}

export type { Row };
