import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock, Coins, Cpu, FlaskConical, Hash, ListTree, Play, RefreshCw, Repeat, ScrollText, Timer, Wrench, XCircle,
} from "lucide-react";
import { post, useAction, useApi } from "../lib/api";
import { ago, dateTime, ms, num, pct, usd } from "../lib/format";
import { axisProps, ChartTooltip, gridProps, Legend } from "../components/charts";
import { Badge, Button, Callout, Card, CardTitle, CodeBlock, cx, Drawer, Empty, ErrorBox, KV, Meter, PageHeader, Select, Spinner, Stat, StatusBadge, Table, Td } from "../components/ui";

const PAGE = 25;

export default function Agents() {
  const { traceId } = useParams();
  const nav = useNavigate();
  const ov = useApi<any>("/traces/overview");
  const [filters, setFilters] = useState({ skill: "", status: "", signature: "" });
  const [page, setPage] = useState(0);
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE), ...(filters.skill && { skill: filters.skill }), ...(filters.status && { status: filters.status }), ...(filters.signature && { signature: filters.signature }) });
  const list = useApi<any>(`/traces?${qs}`);
  const [liveResult, setLiveResult] = useState<any>(null);
  const live = useAction(async () => {
    const r = await post("/agents/live-run", { skill: "api-integration", n: 20 });
    setLiveResult(r);
    ov.reload();
    list.reload();
    return r;
  });

  const setFilter = (k: keyof typeof filters, v: string) => { setFilters((f) => ({ ...f, [k]: v })); setPage(0); };
  const viewSignature = (sig: string, skillId: string | null) => {
    setFilters({ skill: skillId ?? "", status: "failure", signature: sig });
    setPage(0);
    document.getElementById("executions")?.scrollIntoView({ behavior: "smooth" });
  };

  const d = ov.data;
  const t = d?.totals;
  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Agents"
        subtitle="Every execution reported by Claude Code, Codex and other harnesses — step-by-step traces, tool calls, tokens, cost, and the failure patterns that feed the Improvement Lab."
        actions={
          <>
            <Button icon={<RefreshCw className="size-3.5" />} onClick={() => { ov.reload(); list.reload(); }}>Refresh</Button>
            <Button variant="primary" icon={<Play className="size-3.5" />} busy={live.busy} onClick={() => live.run()}>Run 20 live executions</Button>
          </>
        }
      />
      <ErrorBox error={ov.error || live.error} />
      {liveResult && (
        <Callout tone={liveResult.succeeded / liveResult.executed >= 0.9 ? "good" : "warning"} icon={<Activity className="size-4" />}>
          <b className="tabular">{liveResult.succeeded}/{liveResult.executed}</b> live payments-agent executions succeeded on <b>api-integration v{liveResult.version}</b> (real HTTP calls against the PayFlow sandbox with a production-like fault mix; policy compiled by {liveResult.compiler === "claude" ? "Claude" : "the rule-based compiler"}).
        </Callout>
      )}

      {!d ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Executions" value={num(t.total)} icon={<Activity className="size-4" />} sub="all harnesses" />
            <Stat label="Success rate" value={pct(t.rate)} icon={<CheckCircle2 className="size-4" />} sub={`${num(t.ok)} succeeded`} />
            <Stat label="Failures" value={num(t.failed)} icon={<XCircle className="size-4" />} sub={`${d.recurring.length} recurring patterns`} />
            <Stat label="Tokens" value={num((t.tin ?? 0) + (t.tout ?? 0))} icon={<Hash className="size-4" />} sub={`${num(t.tin)} in · ${num(t.tout)} out`} />
            <Stat label="Est. cost" value={usd(t.cost)} icon={<Coins className="size-4" />} sub="at list token prices" />
            <Stat label="Avg latency" value={ms(t.lat)} icon={<Timer className="size-4" />} sub="per execution" />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardTitle sub="Share of executions that completed successfully, by skill">Success rate by skill</CardTitle>
              <SkillRates rows={d.bySkill} />
            </Card>
            <Card>
              <CardTitle sub="Daily executions, last 30 days" right={<Legend items={[{ label: "Success", color: "var(--good)" }, { label: "Failure", color: "var(--critical)" }]} />}>Outcomes over time</CardTitle>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={d.daily} margin={{ top: 4, right: 4, left: -18, bottom: 0 }} barCategoryGap="18%">
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="day" {...axisProps} tickFormatter={(v) => v.slice(5)} minTickGap={16} />
                    <YAxis {...axisProps} allowDecimals={false} />
                    <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip labelFormat={(l) => l} />} />
                    <Bar dataKey="ok" name="Success" stackId="a" fill="var(--good)" stroke="var(--surface)" strokeWidth={1} />
                    <Bar dataKey="failed" name="Failure" stackId="a" fill="var(--critical)" stroke="var(--surface)" strokeWidth={1} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div>
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="size-4 text-serious" />
              <h2 className="text-sm font-semibold text-ink">Recurring failures</h2>
              <span className="text-xs text-muted">failures grouped by skill + normalized error signature (≥ 3 occurrences)</span>
            </div>
            {!d.recurring.length ? <Card><Empty title="No recurring failures">Every failure pattern has been seen fewer than 3 times.</Empty></Card> : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {d.recurring.map((f: any) => <FailureCard key={f.skillId + f.signature} f={f} onView={() => viewSignature(f.signature, f.skillId)} />)}
              </div>
            )}
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.1fr_1fr]">
            <Card pad={false}>
              <div className="p-5 pb-2"><CardTitle sub="Normalized across the last 600 executions"><span className="inline-flex items-center gap-1.5"><Wrench className="size-4 text-muted" />Tool invocations</span></CardTitle></div>
              <Table head={["Tool", "Calls", "Errors", "Error rate", "Avg latency"]}>
                {d.tools.map((tl: any) => (
                  <tr key={tl.name}>
                    <Td className="font-mono text-xs">{tl.name}</Td>
                    <Td className="tabular">{num(tl.calls)}</Td>
                    <Td className="tabular">{tl.errors ? <span className="text-critical">{tl.errors}</span> : 0}</Td>
                    <Td className="w-32"><div className="flex items-center gap-2"><Meter value={tl.errors / tl.calls} color="var(--critical)" /><span className="w-9 text-right text-xs tabular">{pct(tl.errors / tl.calls)}</span></div></Td>
                    <Td className="tabular">{ms(tl.avgLatency)}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
            <div className="space-y-5">
              <Card pad={false}>
                <div className="p-5 pb-2"><CardTitle sub="Same agent, different harness"><span className="inline-flex items-center gap-1.5"><Cpu className="size-4 text-muted" />Agent performance comparison</span></CardTitle></div>
                <Table head={["Agent", "Harness", "Runs", "Success", "Avg latency", "Cost"]}>
                  {d.byAgent.map((a: any) => (
                    <tr key={a.agent + a.harness}>
                      <Td className="font-medium">{a.agent}</Td>
                      <Td><Badge>{a.harness ?? "—"}</Badge></Td>
                      <Td className="tabular">{a.runs}</Td>
                      <Td className="tabular"><span className={a.rate < 0.8 ? "text-critical" : "text-ink"}>{pct(a.rate)}</span></Td>
                      <Td className="tabular">{ms(a.lat)}</Td>
                      <Td className="tabular">{usd(a.cost)}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
              <Card>
                <CardTitle sub="Grouped by error type">Error analysis</CardTitle>
                <div className="space-y-2">
                  {d.errors.map((e: any) => {
                    const max = Math.max(...d.errors.map((x: any) => x.n));
                    return (
                      <div key={e.error_type} className="grid grid-cols-[140px_1fr_36px] items-center gap-3 text-sm">
                        <span className="truncate font-mono text-xs text-ink-2">{e.error_type}</span>
                        <Meter value={e.n / max} color="var(--critical)" />
                        <span className="text-right text-xs font-medium tabular">{e.n}</span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          </div>

          {!!d.workflows?.length && (
            <Card>
              <CardTitle sub="Tool sequences that successful sessions repeat without any skill guiding them — candidates for new skills" right={<Link to="/lab"><Button size="sm" icon={<FlaskConical className="size-3.5" />}>Review in Lab</Button></Link>}>
                <span className="inline-flex items-center gap-1.5"><Repeat className="size-4 text-muted" />Repeated workflows</span>
              </CardTitle>
              <div className="space-y-3">
                {d.workflows.map((w: any) => (
                  <div key={w.sequence} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {w.steps.map((s: string, i: number) => (
                        <span key={i} className="inline-flex items-center gap-1.5">
                          <code className="rounded bg-code px-1.5 py-0.5 text-xs">{s}</code>
                          {i < w.steps.length - 1 && <ChevronRight className="size-3 text-muted" />}
                        </span>
                      ))}
                      <Badge tone="accent" className="ml-auto">{w.support} sessions</Badge>
                    </div>
                    <div className="mt-2 text-xs text-muted">e.g. {w.exampleTasks.map((x: string) => `“${x}”`).join(", ")}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <Card pad={false} className="scroll-mt-4">
        <div id="executions" className="flex flex-wrap items-center justify-between gap-3 p-5 pb-3">
          <div className="flex items-center gap-2"><ListTree className="size-4 text-muted" /><h3 className="text-sm font-semibold">Execution history</h3><span className="text-xs text-muted tabular">{list.data ? `${num(list.data.total)} executions` : ""}</span></div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={filters.skill} onChange={(e) => setFilter("skill", e.target.value)} className="h-8 text-xs">
              <option value="">All skills</option>
              {d?.bySkill.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select value={filters.status} onChange={(e) => setFilter("status", e.target.value)} className="h-8 text-xs">
              <option value="">Any status</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </Select>
            {filters.signature && (
              <Badge tone="warning" className="max-w-xs">
                <span className="truncate">signature: {filters.signature}</span>
                <button onClick={() => setFilter("signature", "")} className="ml-1 font-bold">×</button>
              </Badge>
            )}
          </div>
        </div>
        {list.loading && !list.data ? <Spinner /> : (
          <Table head={["Status", "Task", "Agent", "Skill", "Tokens", "Latency", "Cost", "Started", ""]}>
            {list.data?.rows.map((r: any) => (
              <tr key={r.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => nav(`/agents/${r.id}`)}>
                <Td><StatusBadge status={r.status} /></Td>
                <Td className="max-w-[340px]">
                  <div className="truncate text-ink">{r.task}</div>
                  {r.error_message && <div className="truncate text-xs text-critical">{r.error_type}: {r.error_message}</div>}
                </Td>
                <Td><div className="text-xs">{r.agent}</div><div className="text-[11px] text-muted">{r.harness}</div></Td>
                <Td className="whitespace-nowrap text-xs">{r.skill_name ? <>{r.skill_name} <span className="text-muted">v{r.skill_version}</span></> : <span className="text-muted">—</span>}</Td>
                <Td className="text-xs tabular">{num((r.tokens_in ?? 0) + (r.tokens_out ?? 0))}</Td>
                <Td className="text-xs tabular">{ms(r.latency_ms)}</Td>
                <Td className="text-xs tabular">{usd(r.cost_usd)}</Td>
                <Td className="whitespace-nowrap text-xs text-muted">{ago(r.started_at)}</Td>
                <Td>{r.origin !== "seed" && <Badge tone="accent">{r.origin}</Badge>}</Td>
              </tr>
            ))}
          </Table>
        )}
        {list.data && list.data.total > PAGE && (
          <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-muted">
            <span className="tabular">{page * PAGE + 1}–{Math.min((page + 1) * PAGE, list.data.total)} of {list.data.total}</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" disabled={(page + 1) * PAGE >= list.data.total} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        )}
      </Card>

      <TraceDrawer id={traceId} onClose={() => nav("/agents")} />
    </div>
  );
}

function SkillRates({ rows }: { rows: any[] }) {
  const sorted = [...rows].filter((r) => r.runs).sort((a, b) => b.rate - a.rate);
  return (
    <div className="space-y-3">
      {sorted.map((s) => (
        <Link key={s.id} to={`/skills/${s.slug}`} className="group grid grid-cols-[150px_1fr_80px] items-center gap-3">
          <span className="truncate text-sm text-ink group-hover:text-accent">{s.name} <span className="text-xs text-muted">v{s.active_version}</span></span>
          <div className="relative h-2.5 rounded-full bg-surface-2">
            <div className="h-full rounded-r-[4px] rounded-l-full" style={{ width: `${s.rate * 100}%`, background: "var(--s1)" }} title={`${pct(s.rate, 1)} of ${s.runs} runs`} />
            <div className="absolute inset-y-[-3px] w-px bg-axis" style={{ left: "90%", background: "var(--axis)" }} title="90% target" />
          </div>
          <span className="text-right text-sm tabular"><span className="font-medium text-ink">{pct(s.rate)}</span> <span className="text-xs text-muted">· {s.runs}</span></span>
        </Link>
      ))}
      <div className="flex justify-end text-[11px] text-muted">vertical tick = 90% target · number after dot = runs</div>
    </div>
  );
}

function FailureCard({ f, onView }: { f: any; onView: () => void }) {
  return (
    <Card className="flex flex-col !p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted">{f.skillName ?? "No skill"}</div>
          <div className="mt-0.5 font-mono text-xs leading-snug text-ink break-words">{f.signature}</div>
        </div>
        <Badge tone="critical"><XCircle className="size-3" />{f.count}×</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div><div className="text-muted">Share of skill runs</div><div className="font-medium tabular">{pct(f.share)}</div></div>
        <div><div className="text-muted">Last 20 runs</div><div className="font-medium tabular">{f.windowFailures} / {f.windowRuns} failed</div></div>
        <div><div className="text-muted">First seen</div><div>{ago(f.firstSeen)}</div></div>
        <div><div className="text-muted">Last seen</div><div>{ago(f.lastSeen)}</div></div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">{f.agents.map((a: string) => <Badge key={a}>{a}</Badge>)}</div>
      <div className="mt-auto flex gap-2 pt-3">
        <Button size="sm" icon={<ListTree className="size-3.5" />} onClick={onView}>View traces</Button>
        <Link to="/lab"><Button size="sm" variant="primary" icon={<FlaskConical className="size-3.5" />}>Open in Lab</Button></Link>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- trace drawer
const STEP_ICON: Record<string, ReactNode> = {
  plan: <ScrollText className="size-3.5" />,
  tool_call: <Wrench className="size-3.5" />,
  wait: <Clock className="size-3.5" />,
  log: <ScrollText className="size-3.5" />,
  error: <XCircle className="size-3.5" />,
  result: <CheckCircle2 className="size-3.5" />,
  output: <ScrollText className="size-3.5" />,
};

function TraceDrawer({ id, onClose }: { id?: string; onClose: () => void }) {
  const { data: t, error, loading } = useApi<any>(id ? `/traces/${id}` : null);
  return (
    <Drawer open={!!id} onClose={onClose} width={720} title={t ? <span className="flex items-center gap-2"><StatusBadge status={t.status} /><span className="truncate">{t.task}</span></span> : "Execution trace"}>
      {loading && !t && <Spinner />}
      <ErrorBox error={error} />
      {t && (
        <div className="space-y-5">
          {t.status === "failure" && (
            <Callout tone="critical" icon={<XCircle className="size-4 text-critical" />}>
              <div className="font-medium">{t.error_type}</div>
              <div className="text-ink-2">{t.error_message}</div>
            </Callout>
          )}
          <Card className="!p-4">
            <KV items={[
              ["Agent", t.agent],
              ["Harness", t.harness ?? "—"],
              ["Skill", t.skill_name ? <Link className="text-accent hover:underline" to={`/skills/${t.skill_slug}`}>{t.skill_name} v{t.skill_version}</Link> : "—"],
              ["Tokens", `${num(t.tokens_in)} in · ${num(t.tokens_out)} out`],
              ["Est. cost", usd(t.cost_usd)],
              ["Latency", ms(t.latency_ms)],
              ["Started", dateTime(t.started_at)],
              ["Origin", <Badge>{t.origin}</Badge>],
              ...(t.fault?.scenario ? [["Fault scenario", <span className="font-mono text-xs">{t.fault.scenario}{t.fault.recoverAfter ? ` · recovers after ${t.fault.recoverAfter}` : ""}</span>] as [ReactNode, ReactNode]] : []),
              ...(t.signature ? [["Signature", <span className="font-mono text-xs">{t.signature}</span>] as [ReactNode, ReactNode]] : []),
            ]} />
          </Card>
          <div>
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">Step-by-step trace · {t.steps.length} steps</div>
            {!t.steps.length ? <div className="text-sm text-muted">No steps recorded.</div> : (
              <ol className="relative space-y-2 border-l border-line pl-5">
                {t.steps.map((s: any, i: number) => <StepItem key={i} s={s} i={i} />)}
              </ol>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function StepItem({ s, i }: { s: any; i: number }) {
  const [open, setOpen] = useState(s.status === "error" || s.type === "result");
  const err = s.status === "error" || s.type === "error";
  const ok = s.status === "ok";
  const hasBody = s.input !== undefined || s.output !== undefined;
  return (
    <li className="relative">
      <span className={cx("absolute -left-[29px] top-1.5 grid size-[18px] place-items-center rounded-full border bg-surface", err ? "border-critical text-critical" : ok ? "border-good text-good-ink" : "border-line-strong text-muted")}>
        {STEP_ICON[s.type] ?? <span className="text-[9px]">{i + 1}</span>}
      </span>
      <button onClick={() => hasBody && setOpen(!open)} className={cx("flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left", err ? "border-critical/30 bg-critical-soft" : "border-line bg-surface", hasBody && "hover:border-line-strong")}>
        {hasBody ? (open ? <ChevronDown className="size-3.5 text-muted" /> : <ChevronRight className="size-3.5 text-muted" />) : <span className="w-3.5" />}
        <span className="text-[11px] uppercase tracking-wide text-muted">{s.type.replace("_", " ")}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{s.name}</span>
        {err && <Badge tone="critical"><XCircle className="size-3" />error</Badge>}
        {ok && <Badge tone="good"><CheckCircle2 className="size-3" />ok</Badge>}
        {s.latency_ms != null && <span className="text-xs text-muted tabular">{ms(s.latency_ms)}</span>}
      </button>
      {open && hasBody && (
        <div className="mt-1.5 grid gap-2">
          {s.input !== undefined && <CodeBlock lang="input" code={JSON.stringify(s.input, null, 2)} maxHeight={200} />}
          {s.output !== undefined && <CodeBlock lang="output" code={JSON.stringify(s.output, null, 2)} maxHeight={240} />}
        </div>
      )}
    </li>
  );
}
