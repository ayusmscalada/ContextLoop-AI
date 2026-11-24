/**
 * PayFlow sandbox: a fault-injecting payment API used to replay the conditions
 * captured in historical agent failures. Real HTTP, real timing, per-run state.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Scenario =
  | "ok"
  | "slow_but_ok"
  | "latency_spike"
  | "transient_503"
  | "rate_limit_429"
  | "timeout_after_commit"
  | "bad_request_400";

export const SCENARIOS: Record<Scenario, { label: string; description: string; expect: "charged" | "declined" }> = {
  ok: { label: "Healthy upstream", description: "API responds in ~60 ms", expect: "charged" },
  slow_but_ok: { label: "Slow but healthy", description: "API responds in ~450 ms; aggressive timeouts would break it", expect: "charged" },
  latency_spike: { label: "Latency spike", description: "First attempt(s) hang ~3 s (peak traffic), then recover", expect: "charged" },
  transient_503: { label: "Transient 503", description: "Upstream returns 503 twice, then succeeds", expect: "charged" },
  rate_limit_429: { label: "Rate limited", description: "429 with Retry-After: 400 ms; early retries are rejected again", expect: "charged" },
  timeout_after_commit: { label: "Timeout after commit", description: "Charge is committed but the response hangs; a retry without an Idempotency-Key double-charges", expect: "charged" },
  bad_request_400: { label: "Invalid card (control)", description: "Permanent 400; correct behaviour is to fail fast without retrying", expect: "declined" },
};

interface RunState { attempts: number; charges: string[]; idem: Map<string, string>; retryAfterUntil: number }
const runs = new Map<string, RunState>();
let server: http.Server | null = null;
let baseUrl = "";

export function runState(runId: string) {
  return runs.get(runId);
}
export function clearRun(runId: string) {
  runs.delete(runId);
}

let starting: Promise<string> | null = null;
export function ensureMockApi(): Promise<string> {
  return (starting ??= startMockApi());
}

async function startMockApi(): Promise<string> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method !== "POST" || url.pathname !== "/v1/charges") {
      res.writeHead(404).end();
      return;
    }
    const scenario = (req.headers["x-scenario"] as Scenario) ?? "ok";
    const runId = (req.headers["x-run-id"] as string) ?? "default";
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    let st = runs.get(runId);
    if (!st) runs.set(runId, (st = { attempts: 0, charges: [], idem: new Map(), retryAfterUntil: 0 }));
    st.attempts++;
    const attempt = st.attempts;
    const recoverAfter = Number(req.headers["x-recover-after"] ?? 1);
    const send = (code: number, body: object, delay = 40, headers: Record<string, string> = {}) => {
      const t = setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      }, delay);
      res.on("close", () => clearTimeout(t)); // client aborted (timeout) → drop the pending response
    };
    const charge = () => {
      if (idemKey && st!.idem.has(idemKey)) return st!.idem.get(idemKey)!;
      const id = `ch_${runId.slice(-6)}_${st!.charges.length + 1}`;
      st!.charges.push(id);
      if (idemKey) st!.idem.set(idemKey, id);
      return id;
    };
    req.resume();
    req.on("end", () => {
      switch (scenario) {
        case "ok":
          return send(200, { id: charge(), status: "succeeded" }, 60);
        case "slow_but_ok":
          return send(200, { id: charge(), status: "succeeded" }, 450);
        case "latency_spike":
          if (attempt <= recoverAfter) return send(200, { id: "late", status: "succeeded" }, 3000);
          return send(200, { id: charge(), status: "succeeded" }, 70);
        case "transient_503":
          if (attempt <= 2) return send(503, { error: "service_unavailable" }, 30);
          return send(200, { id: charge(), status: "succeeded" }, 60);
        case "rate_limit_429":
          if (attempt === 1 || Date.now() < st!.retryAfterUntil) {
            if (attempt === 1) st!.retryAfterUntil = Date.now() + 400;
            return send(429, { error: "rate_limited" }, 20, { "retry-after-ms": "400", "retry-after": "1" });
          }
          return send(200, { id: charge(), status: "succeeded" }, 60);
        case "timeout_after_commit": {
          const id = charge();
          if (attempt === 1) return send(200, { id, status: "succeeded" }, 3000);
          return send(200, { id, status: "succeeded" }, 60);
        }
        case "bad_request_400":
          return send(400, { error: "card_declined", message: "Invalid card number" }, 30);
      }
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return baseUrl;
}
