/**
 * Skill evaluation harness.
 *  1. compilePolicy(): turns a skill's natural-language instructions into the concrete
 *     execution policy an agent would follow (Claude when configured, else a rule parser).
 *  2. executeTask(): an agent runtime executes a payment task under that policy with
 *     real HTTP calls against the PayFlow sandbox.
 *  3. runEvaluation(): replays historical failure cases (+ regression and control cases)
 *     against baseline and candidate skill versions and scores both.
 */
import { z } from "zod";
import { all, get, json, now, run, uid } from "../db.js";
import { structured } from "../llm.js";
import { clearRun, ensureMockApi, runState, SCENARIOS, type Scenario } from "./mockApi.js";

export const Policy = z.object({
  timeoutMs: z.number().nullable().describe("Per-request client timeout in ms, or null if the skill sets none"),
  maxRetries: z.number().describe("Retries after the first attempt (0 if the skill does not say to retry)"),
  backoff: z.enum(["none", "fixed", "exponential"]),
  backoffBaseMs: z.number(),
  jitter: z.boolean(),
  retryOn: z.enum(["all", "transient"]).describe("'transient' = only timeouts, 5xx and 429"),
  respectRetryAfter: z.boolean(),
  idempotencyKey: z.boolean(),
  logFinalFailure: z.boolean(),
});
export type Policy = z.infer<typeof Policy>;

export function compilePolicyRules(skill: string): Policy {
  const s = skill.toLowerCase();
  const num = (re: RegExp) => {
    const m = s.match(re);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return /^s|sec/.test(m[2] ?? "ms") && !/^ms/.test(m[2] ?? "") ? v * 1000 : v;
  };
  const mentionsTimeout = /(configure|set|use|apply)[^.\n]{0,40}timeout|timeout of \d/.test(s);
  const retries = /\bretr(y|ies)\b/.test(s);
  return {
    timeoutMs: mentionsTimeout ? num(/timeout of (\d+(?:\.\d+)?)\s*(ms|milliseconds|s|seconds)?/) ?? num(/(\d+(?:\.\d+)?)\s*(ms|s)\b[^.\n]{0,20}timeout/) ?? 1000 : null,
    maxRetries: retries ? num(/(?:up to|max(?:imum)?(?: of)?)\s*(\d+)\s*(?:times|retries|attempts)?/) ?? 3 : 0,
    backoff: /exponential/.test(s) ? "exponential" : /(fixed|constant) delay|wait (\d+)/.test(s) ? "fixed" : "none",
    backoffBaseMs: num(/(?:starting at|base(?: delay)? of|initial delay of)\s*(\d+)\s*(ms)?/) ?? 200,
    jitter: /jitter/.test(s),
    retryOn: /transient|5xx|retryable|never retry 4\d\d|do not retry/.test(s) ? "transient" : "all",
    respectRetryAfter: /retry-after/.test(s),
    idempotencyKey: /idempoten/.test(s),
    logFinalFailure: /log (the )?final|log .*failure/.test(s),
  };
}

const policyCache = new Map<string, { policy: Policy; compiler: string }>();
export async function compilePolicy(skill: string): Promise<{ policy: Policy; compiler: "claude" | "rules" }> {
  const hit = policyCache.get(skill);
  if (hit) return hit as any;
  const llm = await structured({
    system: "You are an agent runtime. Translate a skill's instructions into the exact execution policy an agent following ONLY those instructions would use when calling an external HTTP API. Do not add best practices the skill does not ask for. If the skill doesn't mention a behaviour, use the inert value (null timeout, 0 retries, 'none' backoff, false flags, retryOn 'all').",
    prompt: `<skill>\n${skill}\n</skill>`,
    schema: Policy,
    effort: "low",
  });
  const r = llm ? { policy: llm, compiler: "claude" as const } : { policy: compilePolicyRules(skill), compiler: "rules" as const };
  policyCache.set(skill, r);
  return r;
}

export interface Step { type: string; name?: string; input?: any; output?: any; status?: string; latency_ms?: number; at?: string }
export interface ExecResult {
  status: "success" | "failure";
  outcome: string;
  error_type: string | null;
  error_message: string | null;
  attempts: number;
  charges: number;
  latency_ms: number;
  steps: Step[];
  violations: string[];
}

const TASK_DEADLINE_MS = 2500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Execute "charge the customer" under a policy against a scenario. */
export async function executeTask(policy: Policy, scenario: Scenario, opts: { recoverAfter?: number; amount?: number } = {}): Promise<ExecResult> {
  const base = await ensureMockApi();
  const runId = uid("run");
  const steps: Step[] = [];
  const t0 = Date.now();
  const deadline = AbortSignal.timeout(TASK_DEADLINE_MS);
  const idem = policy.idempotencyKey ? `idem_${runId}` : undefined;
  const violations: string[] = [];
  steps.push({ type: "plan", name: "skill_policy", output: policy, at: new Date().toISOString() });

  let attempt = 0;
  let lastErr: { type: string; message: string } | null = null;
  let charged = false;
  let declined = false;

  while (attempt <= policy.maxRetries) {
    attempt++;
    const a0 = Date.now();
    const signals = [deadline];
    if (policy.timeoutMs) signals.push(AbortSignal.timeout(policy.timeoutMs));
    let status = 0;
    let retryAfterMs = 0;
    try {
      const res = await fetch(`${base}/v1/charges`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-scenario": scenario, "x-run-id": runId, "x-recover-after": String(opts.recoverAfter ?? 1), ...(idem ? { "idempotency-key": idem } : {}) },
        body: JSON.stringify({ amount: opts.amount ?? 4999, currency: "usd", customer: "cus_demo" }),
        signal: AbortSignal.any(signals),
      });
      status = res.status;
      retryAfterMs = Number(res.headers.get("retry-after-ms") ?? 0);
      const body = await res.json().catch(() => ({}));
      steps.push({ type: "tool_call", name: "http.post /v1/charges", input: { attempt, idempotency_key: idem ?? null }, output: { status, body }, status: status < 300 ? "ok" : "error", latency_ms: Date.now() - a0, at: new Date(a0).toISOString() });
      if (status < 300) { charged = true; break; }
      lastErr = status === 429 ? { type: "rate_limited", message: `429 Too Many Requests from PayFlow API` } : status >= 500 ? { type: "upstream_error", message: `${status} Service Unavailable from PayFlow API` } : { type: "validation_error", message: `${status} ${body.error ?? "Bad Request"}: ${body.message ?? ""}`.trim() };
      if (status >= 400 && status < 500 && status !== 429) declined = true;
    } catch (e: any) {
      const overall = deadline.aborted;
      const isAbort = e?.name === "TimeoutError" || e?.name === "AbortError";
      lastErr = overall
        ? { type: "timeout", message: `Agent exceeded ${TASK_DEADLINE_MS}ms task deadline waiting on PayFlow API${policy.timeoutMs ? "" : " (no client timeout configured)"}` }
        : isAbort
          ? { type: "timeout", message: `Request to PayFlow API timed out after ${policy.timeoutMs}ms` }
          : { type: "network_error", message: `${e?.message ?? e}${e?.cause ? `: ${e.cause.code ?? e.cause.message}` : ""}` };
      steps.push({ type: "tool_call", name: "http.post /v1/charges", input: { attempt, idempotency_key: idem ?? null }, output: { error: lastErr.message }, status: "error", latency_ms: Date.now() - a0, at: new Date(a0).toISOString() });
      if (overall) break;
    }
    // Decide whether to retry.
    if (attempt > policy.maxRetries) break;
    const transient = lastErr!.type === "timeout" || lastErr!.type === "upstream_error" || lastErr!.type === "rate_limited";
    if (policy.retryOn === "transient" && !transient) break;
    if (!transient) violations.push("Retried a non-retryable 4xx error");
    let wait = policy.backoff === "none" ? 0 : policy.backoff === "fixed" ? policy.backoffBaseMs : policy.backoffBaseMs * 2 ** (attempt - 1);
    if (policy.jitter && wait) wait = Math.round(wait * (0.8 + Math.random() * 0.4));
    if (policy.respectRetryAfter && retryAfterMs) wait = Math.max(wait, retryAfterMs);
    if (Date.now() - t0 + wait >= TASK_DEADLINE_MS) break;
    steps.push({ type: "wait", name: policy.respectRetryAfter && retryAfterMs ? "honor Retry-After" : `${policy.backoff} backoff`, output: { ms: wait }, at: new Date().toISOString() });
    if (wait) await sleep(wait);
    if (deadline.aborted) break;
  }

  const st = runState(runId);
  const charges = st?.charges.length ?? 0;
  clearRun(runId);
  const expect = SCENARIOS[scenario].expect;
  let status: "success" | "failure" = "failure";
  let outcome = "";
  if (expect === "charged") {
    if (charged && charges === 1) { status = "success"; outcome = "Customer charged exactly once"; }
    else if (charges > 1) { outcome = `Customer charged ${charges} times`; lastErr = { type: "duplicate_charge", message: `Retry without idempotency key created ${charges} charges for one order` }; }
    else outcome = "Charge not completed";
  } else {
    if (declined && attempt === 1) { status = "success"; outcome = "Declined card reported without retrying"; }
    else if (declined) { outcome = `Declined card retried ${attempt - 1} time(s)`; lastErr = { type: "validation_error", message: `Retried non-retryable 400 card_declined ${attempt - 1} time(s)` }; }
    else outcome = "Unexpected result";
  }
  if (status === "failure" && policy.logFinalFailure) steps.push({ type: "log", name: "final_failure", output: { attempts: attempt, last_error: lastErr }, at: new Date().toISOString() });
  steps.push({ type: "result", name: status, output: { outcome, attempts: attempt, charges }, status: status === "success" ? "ok" : "error", at: new Date().toISOString() });
  return {
    status, outcome, attempts: attempt, charges, latency_ms: Date.now() - t0, steps, violations,
    error_type: status === "success" ? null : lastErr?.type ?? "unknown",
    error_message: status === "success" ? null : lastErr?.message ?? outcome,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export interface EvalCase { id: string; scenario: Scenario; recoverAfter: number; origin: "historical_failure" | "regression" | "control"; traceId?: string; label: string }

/** Build cases from the skill's historical failure traces (+ regression + control). */
export function buildCases(skillId: string, max = 16): EvalCase[] {
  const fails = all("SELECT id, fault, error_type, started_at FROM traces WHERE skill_id = ? AND status = 'failure' AND fault IS NOT NULL AND fault != 'null' AND origin != 'eval' ORDER BY started_at DESC LIMIT ?", skillId, max);
  const cases: EvalCase[] = fails
    .map((f) => ({ f, fault: json<any>(f.fault, null) }))
    .filter((x) => x.fault?.scenario)
    .map(({ f, fault }) => ({ id: uid("case"), scenario: fault.scenario, recoverAfter: fault.recoverAfter ?? 1, origin: "historical_failure" as const, traceId: f.id, label: `Replay ${f.id.slice(-6)} · ${SCENARIOS[fault.scenario as Scenario]?.label ?? fault.scenario}` }));
  cases.push({ id: uid("case"), scenario: "ok", recoverAfter: 1, origin: "regression", label: "Regression · healthy upstream" });
  cases.push({ id: uid("case"), scenario: "slow_but_ok", recoverAfter: 1, origin: "regression", label: "Regression · slow but healthy" });
  cases.push({ id: uid("case"), scenario: "bad_request_400", recoverAfter: 1, origin: "control", label: "Control · invalid card must fail fast" });
  return cases;
}

export async function runEvaluation(opts: { skillId: string; baseline: { label: string; content: string }; candidate: { label: string; content: string }; proposalId?: string }) {
  const t0 = Date.now();
  const [b, c] = await Promise.all([compilePolicy(opts.baseline.content), compilePolicy(opts.candidate.content)]);
  const cases = buildCases(opts.skillId);
  if (cases.length <= 3) throw new Error("No historical failure traces with replayable fault data for this skill — an executable eval harness is only available for skills that call external HTTP APIs.");
  const results = await pool(cases, 8, async (cs) => {
    const [rb, rc] = await Promise.all([executeTask(b.policy, cs.scenario, { recoverAfter: cs.recoverAfter }), executeTask(c.policy, cs.scenario, { recoverAfter: cs.recoverAfter })]);
    return { case: cs, baseline: rb, candidate: rc };
  });
  const rate = (k: "baseline" | "candidate") => results.filter((r) => r[k].status === "success").length / results.length;
  const id = uid("evl");
  const row = {
    id, proposal_id: opts.proposalId ?? null, skill_id: opts.skillId, baseline_label: opts.baseline.label, candidate_label: opts.candidate.label,
    baseline_policy: JSON.stringify(b.policy), candidate_policy: JSON.stringify(c.policy), results: JSON.stringify(results),
    baseline_rate: rate("baseline"), candidate_rate: rate("candidate"), compiler: b.compiler === "claude" || c.compiler === "claude" ? "claude" : "rules", created_at: now(), duration_ms: Date.now() - t0,
  };
  run(`INSERT INTO eval_runs(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, ...Object.values(row));
  return getEvalRun(id)!;
}

export function getEvalRun(id: string) {
  const r = get("SELECT * FROM eval_runs WHERE id = ?", id);
  if (!r) return null;
  return { ...r, baseline_policy: json(r.baseline_policy, null), candidate_policy: json(r.candidate_policy, null), results: json<any[]>(r.results, []) };
}

/** Production-like traffic mix used for "live" executions. */
export const TRAFFIC_MIX: [Scenario, number][] = [["ok", 0.5], ["latency_spike", 0.18], ["transient_503", 0.1], ["rate_limit_429", 0.08], ["timeout_after_commit", 0.06], ["slow_but_ok", 0.05], ["bad_request_400", 0.03]];
export function sampleScenario(): Scenario {
  let r = Math.random();
  for (const [s, w] of TRAFFIC_MIX) { if ((r -= w) <= 0) return s; }
  return "ok";
}
