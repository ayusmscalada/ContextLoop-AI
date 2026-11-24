/** Generates sample AI-tool exports in their native formats (run once; outputs are committed). */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../db.ts";

const corpus = path.join(ROOT, "sample-data", "corpus");
const demo = path.join(ROOT, "sample-data", "demo");
fs.mkdirSync(corpus, { recursive: true });
fs.mkdirSync(demo, { recursive: true });

// ---------------- Claude Code session (#024) ----------------
function claudeSession(file: string, sessionId: string, start: string, cwd: string, branch: string, turns: [string, any][], summary?: string) {
  let t = new Date(start).getTime();
  const lines: any[] = [];
  if (summary) lines.push({ type: "summary", summary, leafUuid: `${sessionId}-leaf` });
  let parent: string | null = null;
  turns.forEach(([role, content], i) => {
    t += 20_000 + i * 3000;
    const uuid = `${sessionId}-${i}`;
    lines.push({
      parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.300", gitBranch: branch,
      type: role, uuid, timestamp: new Date(t).toISOString(),
      message: role === "assistant" ? { id: `msg_${i}`, type: "message", role, model: "claude-opus-5-5", content, usage: { input_tokens: 1800 + i * 220, output_tokens: 240 + i * 30 } } : { role, content },
    });
    parent = uuid;
  });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

claudeSession(path.join(corpus, "claude-code-session-024-payflow-timeout.jsonl"), "5b1f0c2a-024", "2026-10-09T14:02:00Z", "/home/ben/northwind/charge-service", "fix/payflow-timeouts", [
  ["user", "Claude Code session #024. The Project Alpha charge service is failing when the PayFlow API is slow under load. Find out why and fix it per the decision in engineering meeting #018: exponential backoff, retry limits and idempotency keys."],
  ["assistant", [{ type: "text", text: "I'll start by looking at how the charge service calls PayFlow." }, { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "payflow", path: "src" } }]],
  ["user", [{ type: "tool_result", tool_use_id: "t1", content: "src/payflow/client.py:14: resp = requests.post(f\"{BASE}/v1/charges\", json=payload)\nsrc/charges/service.py:40: result = payflow.create_charge(order)" }]],
  ["assistant", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "src/payflow/client.py" } }]],
  ["user", [{ type: "tool_result", tool_use_id: "t2", content: "def create_charge(payload):\n    resp = requests.post(f\"{BASE}/v1/charges\", json=payload)\n    resp.raise_for_status()\n    return resp.json()" }]],
  ["assistant", [{ type: "text", text: "Found the root cause: requests.post is called without a timeout, so when the PayFlow API is slow during high traffic the call hangs until the worker is killed. There is also no retry, and no idempotency key, so adding a naive retry would risk duplicate charges for requests that already committed." }, { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "src/payflow/client.py", old_string: "resp = requests.post(f\"{BASE}/v1/charges\", json=payload)", new_string: "resp = session.post(f\"{BASE}/v1/charges\", json=payload, timeout=0.8, headers={\"Idempotency-Key\": key})" } }]],
  ["user", [{ type: "tool_result", tool_use_id: "t3", content: "File updated." }]],
  ["assistant", [{ type: "text", text: "I implemented retry logic with exponential backoff (200 ms base, jitter, max 3 retries) that only retries timeouts, 5xx and 429 responses, honors Retry-After, and reuses one idempotency key per order across retries. Running the tests now." }, { type: "tool_use", id: "t4", name: "Bash", input: { command: "pytest tests/payflow -q" } }]],
  ["user", [{ type: "tool_result", tool_use_id: "t4", content: "18 passed in 2.31s" }]],
  ["assistant", [{ type: "text", text: "All 18 PayFlow tests pass. Summary: the payment integration failed because the PayFlow API exceeded its timeout under load and the client had no timeout or retry. Fixed with an 800 ms timeout, exponential backoff with retry limits, idempotency keys, and transient-only retries. Next step is the async worker Maya is building on Redis." }]],
], "Fix PayFlow API timeouts in charge service (retry + idempotency)");

// ---------------- Codex rollout (#042) ----------------
function codexRollout(file: string, id: string, start: string, cwd: string, items: any[]) {
  let t = new Date(start).getTime();
  const lines: any[] = [{ timestamp: new Date(t).toISOString(), type: "session_meta", payload: { id, timestamp: new Date(t).toISOString(), cwd, originator: "codex_cli_rs", cli_version: "0.98.0", model: "gpt-5-codex", git: { branch: "test/payflow-retry" } } }];
  for (const it of items) {
    t += 15_000;
    lines.push({ timestamp: new Date(t).toISOString(), type: "response_item", payload: it });
  }
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
codexRollout(path.join(corpus, "codex-execution-042-integration-test.jsonl"), "codex-042", "2026-10-10T09:15:00Z", "/home/ben/northwind/charge-service", [
  { type: "message", role: "user", content: [{ type: "input_text", text: "Codex execution #042: write an integration test for the new PayFlow retry logic in Project Alpha. Simulate a timeout followed by success and a slow request that committed, and assert we never create a duplicate charge." }] },
  { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls tests/payflow"] }), call_id: "c1" },
  { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "test_client.py\ntest_service.py\n", metadata: { exit_code: 0 } }) },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll add tests/payflow/test_retry_integration.py with a fake PayFlow server that times out once, then succeeds, plus a commit-then-hang case to verify the idempotency key prevents a duplicate charge." }] },
  { type: "function_call", name: "apply_patch", arguments: "*** Begin Patch\n*** Add File: tests/payflow/test_retry_integration.py\n+def test_timeout_then_success(fake_payflow): ...\n+def test_commit_then_hang_no_duplicate(fake_payflow): ...\n*** End Patch", call_id: "c2" },
  { type: "function_call_output", call_id: "c2", output: JSON.stringify({ output: "Success. Updated the following files:\nA tests/payflow/test_retry_integration.py", metadata: { exit_code: 0 } }) },
  { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pytest tests/payflow -q"] }), call_id: "c3" },
  { type: "function_call_output", call_id: "c3", output: JSON.stringify({ output: "21 passed in 3.02s", metadata: { exit_code: 0 } }) },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "Successful integration test: all 21 tests pass, including timeout-then-success and commit-then-hang. The retry logic with idempotency keys never produced a duplicate charge." }] },
]);

// ---------------- ChatGPT export ----------------
function chatgptConv(title: string, created: string, msgs: [string, string][]) {
  const mapping: Record<string, any> = { root: { id: "root", message: null, parent: null, children: ["m0"] } };
  let t = new Date(created).getTime() / 1000;
  msgs.forEach(([role, text], i) => {
    t += 40;
    mapping[`m${i}`] = { id: `m${i}`, parent: i === 0 ? "root" : `m${i - 1}`, children: i < msgs.length - 1 ? [`m${i + 1}`] : [], message: { id: `m${i}`, author: { role }, create_time: t, content: { content_type: "text", parts: [text] }, metadata: role === "assistant" ? { model_slug: "gpt-5" } : {} } };
  });
  return { title, create_time: new Date(created).getTime() / 1000, update_time: t, mapping, current_node: `m${msgs.length - 1}`, conversation_id: `conv-${title.length}-${msgs.length}` };
}
fs.writeFileSync(path.join(corpus, "chatgpt-conversations.json"), JSON.stringify([
  chatgptConv("Backoff vs circuit breaker for payment APIs", "2026-10-07T18:20:00Z", [
    ["user", "For Project Alpha we call the PayFlow API for every charge. When it gets slow under high traffic, should we use exponential backoff or a circuit breaker?"],
    ["assistant", "Use both, for different jobs. Exponential backoff with jitter and a retry limit handles transient failures like timeouts and 503s. A circuit breaker stops hammering a provider that is clearly down. For payments, the critical piece is an idempotency key on every charge so a retry after a timeout cannot double-charge a customer."],
    ["user", "What timeout should we use if our p99 checkout budget is 800 ms?"],
    ["assistant", "Keep the per-attempt client timeout well under the budget. Many teams use an 800 ms ceiling for the whole call and move retries off the request path with asynchronous processing on a queue, so checkout returns immediately and a worker retries in the background."],
  ]),
  chatgptConv("Postgres advisory locks for migrations", "2026-10-29T11:05:00Z", [
    ["user", "Our agent-run migrations keep blocking writes on the orders table. Ideas?"],
    ["assistant", "Set lock_timeout so ALTER TABLE fails fast instead of queueing behind long transactions, use CREATE INDEX CONCURRENTLY, and backfill new columns in batches. Advisory locks can serialize migrations across workers."],
  ]),
], null, 2));

// ================= LIVE DEMO FILES =================
fs.writeFileSync(path.join(demo, "1-alpha-planning-2026-10-02.txt"), `Meeting: Project Alpha planning
Date: 2026-10-02
Type: planning
Attendees: Priya Patel, Maya Chen, Ben Okafor, Carol Diaz
Project: Project Alpha

Priya Patel: Goal for today is to lock the launch plan with Acme Retail.
Maya Chen: Ledger and checkout API are on track. PayFlow sandbox certification is the long pole.
Priya Patel: Then the Project Alpha launch is November 15, 2026. Carol, you can share that date with Acme Retail.
Carol Diaz: Great, Acme Retail wants to run their holiday campaign on the new platform.
Ben Okafor: I'll make sure the charge service load test happens before then.
Action item: Carol will confirm the November 15 launch with Acme Retail.
Action item: Ben will run the peak-traffic load rehearsal.
`);
fs.writeFileSync(path.join(demo, "2-alpha-sprint-review-2026-10-20.txt"), `Meeting: Project Alpha sprint review
Date: 2026-10-20
Type: planning
Attendees: Priya Patel, Maya Chen, Alice Morgan
Project: Project Alpha

Maya Chen: The retry and idempotency work from the incident review is done, but PayFlow moved our production certification window by three weeks.
Alice Morgan: Can we launch without certification?
Maya Chen: No, PayFlow will not enable live charges until we pass it.
Priya Patel: Then the date changes. The Project Alpha launch moved to December 6, 2026. I will tell Acme Retail today.
Alice Morgan: Agreed. Priya owns the customer communication.
Project Alpha is at risk until certification is complete.
Action item: Priya will send Acme Retail the revised launch date.
`);

claudeSession(path.join(demo, "3-claude-code-session-webhooks.jsonl"), "9a7e44d1-031", "2026-11-18T10:30:00Z", "/home/maya/northwind/charge-service", "feat/webhook-verification", [
  ["user", "Webhook signature failures are showing up for Project Alpha settlement events from PayFlow. Can you investigate?"],
  ["assistant", [{ type: "tool_use", id: "w1", name: "Grep", input: { pattern: "hmac", path: "src/webhooks" } }]],
  ["user", [{ type: "tool_result", tool_use_id: "w1", content: "src/webhooks/verify.py:9: expected = hmac.new(secret, request.body, sha256).hexdigest()" }]],
  ["assistant", [{ type: "text", text: "The webhook signature mismatch happens because we verify against the parsed JSON body re-serialized by FastAPI instead of the raw bytes. I switched verification to the raw request body and added a 5 minute timestamp tolerance to block replays." }, { type: "tool_use", id: "w2", name: "Bash", input: { command: "pytest tests/webhooks -q" } }]],
  ["user", [{ type: "tool_result", tool_use_id: "w2", content: "9 passed in 0.88s" }]],
  ["assistant", [{ type: "text", text: "Fixed: webhook signature verification now uses raw bytes; all 9 webhook tests pass. Decision: we verify PayFlow webhooks on the raw body with a 5 minute replay window." }]],
], "Fix PayFlow webhook signature verification");

fs.writeFileSync(path.join(demo, "4-chatgpt-export-conversations.json"), JSON.stringify([
  chatgptConv("Settlement reconciliation cadence", "2026-11-19T16:00:00Z", [
    ["user", "For Project Alpha, should settlement reconciliation against PayFlow run hourly or daily?"],
    ["assistant", "Run a lightweight hourly reconciliation for anomaly detection and a full daily reconciliation that closes the books in PostgreSQL. Hourly catches webhook gaps quickly; daily gives finance a single authoritative report."],
  ]),
], null, 2));

codexRollout(path.join(demo, "5-codex-rollout-reconciliation.jsonl"), "codex-057", "2026-11-20T13:00:00Z", "/home/sam/northwind/ledger", [
  { type: "message", role: "user", content: [{ type: "input_text", text: "Implement the hourly settlement reconciliation job for Project Alpha against the PayFlow settlement report." }] },
  { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pytest tests/reconcile -q"] }), call_id: "r1" },
  { type: "function_call_output", call_id: "r1", output: JSON.stringify({ output: "6 passed in 1.10s", metadata: { exit_code: 0 } }) },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added the hourly reconciliation job with Redis locking; 6 tests pass." }] },
]);

fs.writeFileSync(path.join(demo, "6-agent-executions.json"), JSON.stringify({
  executions: [1, 2, 3].map((i) => ({
    agent: "payments-agent", harness: "codex", skill: "api-integration", task: `Refund order #49${i}10 via PayFlow API`, status: "failure",
    error_type: "timeout", error_message: `Agent exceeded 2500ms task deadline waiting on PayFlow API (no client timeout configured)`,
    tokens_in: 3100, tokens_out: 640, latency_ms: 2500 + i * 3, started_at: `2026-11-2${i}T0${i}:15:00Z`, project: "Project Alpha",
    fault: { scenario: "latency_spike", recoverAfter: 1 },
    steps: [{ type: "plan", name: "skill_policy" }, { type: "tool_call", name: "http.post /v1/refunds", status: "error", latency_ms: 2500 }, { type: "result", name: "failure", status: "error" }],
  })),
}, null, 2));

console.log("Sample data written to", corpus, "and", demo);
