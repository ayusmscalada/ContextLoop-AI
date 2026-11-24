import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  FlaskConical, Radar, FileDiff, Gauge, ShieldCheck, RefreshCw, Activity, Wand2, ArrowRight, CheckCircle2, XCircle, Sparkles, BookOpen, AlertTriangle, Play, GitBranch, FileText,
} from "lucide-react";
import { post, useAction, useApi } from "../lib/api";
import { ago, date, dateTime, ms, pct } from "../lib/format";
import { Badge, Button, Callout, Card, CardTitle, CodeBlock, cx, DiffView, Empty, ErrorBox, Input, KV, PageHeader, SourceBadge, Spinner, StatusBadge, Table, Td, Tabs } from "../components/ui";

const LOOP = [
  { icon: Radar, label: "Detect", sub: "Mine traces for recurring failures" },
  { icon: Wand2, label: "Propose", sub: "Draft a targeted skill edit" },
  { icon: Gauge, label: "Evaluate", sub: "Replay historical failures" },
  { icon: ShieldCheck, label: "Approve", sub: "Human review & versioning" },
  { icon: GitBranch, label: "Sync", sub: "Claude Code + Codex" },
  { icon: Activity, label: "Measure", sub: "Live success by version" },
];

function stage(p: any): number {
  if (!p) return 0;
  if (p.status === "approved") return 5;
  if (p.status === "rejected") return 3;
  if (p.eval_run_id) return 3;
  return 2;
}

export default function Lab() {
  const { id } = useParams();
  const nav = useNavigate();
  const list = useApi<any[]>("/proposals");
  const overview = useApi<any>("/traces/overview");
  const analyze = useAction(async () => {
    const r = await post("/lab/analyze");
    await list.reload();
    return r;
  });
  const [lastAnalyze, setLastAnalyze] = useState<number | null>(null);

  const proposals = list.data ?? [];
  const ordered = useMemo(() => {
    const rank = (s: string) => ({ pending: 0, evaluated: 0, approved: 1, rejected: 2 } as any)[s] ?? 3;
    return [...proposals].sort((a, b) => rank(a.status) - rank(b.status) || b.created_at.localeCompare(a.created_at));
  }, [proposals]);
  const selectedId = id ?? ordered.find((p) => p.kind === "improve" && ["pending", "evaluated"].includes(p.status))?.id ?? ordered[0]?.id;
  const recurring = (overview.data?.recurring ?? []).filter((r: any) => r.skillId);

  return (
    <div>
      <PageHeader
        title="Improvement Lab"
        badge={<Badge tone="accent"><FlaskConical className="size-3" /> Core</Badge>}
        subtitle="Skills are the unit of improvement. The lab mines execution traces for recurring failures and repeated workflows, drafts reviewable skill edits grounded in organizational knowledge, proves them against replays of the real failures, and ships approved versions to every agent harness."
        actions={
          <Button variant="primary" icon={<Radar className="size-4" />} busy={analyze.busy} onClick={async () => { const r = await analyze.run(); if (r) setLastAnalyze(r.created.length); }}>
            Analyze traces
          </Button>
        }
      />
      <ErrorBox error={analyze.error} />
      {lastAnalyze != null && <div className="mb-4"><Callout tone={lastAnalyze ? "good" : "accent"} icon={<Sparkles className="size-4" />}>{lastAnalyze ? `Drafted ${lastAnalyze} new proposal(s) from recurring failures and repeated workflows.` : "No new patterns — every recurring failure already has a pending proposal for the active skill version."}</Callout></div>}

      {/* Loop strip */}
      <Card className="mb-5" pad={false}>
        <div className="grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          {LOOP.map((s, i) => {
            const active = stage(proposals.find((p) => p.id === selectedId)) >= i;
            return (
              <div key={s.label} className="flex items-start gap-2.5 px-4 py-3">
                <div className={cx("grid size-8 shrink-0 place-items-center rounded-lg", active ? "bg-accent text-white" : "bg-surface-2 text-muted")}><s.icon className="size-4" /></div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink">{i + 1}. {s.label}</div>
                  <div className="text-[11px] leading-snug text-muted">{s.sub}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <div className="space-y-5">
          <Card pad={false}>
            <div className="border-b border-line px-4 py-3 text-sm font-semibold">Proposals</div>
            {list.loading && !list.data ? <Spinner /> : !ordered.length ? (
              <Empty title="No proposals yet" icon={<FlaskConical className="size-6" />}>Click “Analyze traces” to mine recent agent executions.</Empty>
            ) : (
              <div className="max-h-[520px] divide-y divide-line overflow-y-auto">
                {ordered.map((p) => (
                  <button key={p.id} onClick={() => nav(`/lab/${p.id}`)} className={cx("block w-full px-4 py-3 text-left transition hover:bg-surface-2", p.id === selectedId && "bg-accent-soft")}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-muted">{p.kind === "new_skill" ? "New skill" : p.skill_name}</span>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="line-clamp-2 text-sm font-medium text-ink">{p.kind === "new_skill" ? p.proposed_name : p.issue}</div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                      <span>{p.generator === "claude" ? "Claude" : "Rule engine"}</span>·<span>{ago(p.created_at)}</span>
                      {p.stats?.historicalRate != null && <>·<span>{pct(p.stats.historicalRate)} success</span></>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <CardTitle sub="Signals feeding the lab (≥3 occurrences)">Recurring failures</CardTitle>
            <div className="space-y-2.5">
              {recurring.slice(0, 6).map((r: any) => (
                <div key={r.skillId + r.signature} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink">{r.skillName}</span>
                    <span className="tabular text-ink-2">×{r.count}</span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted" title={r.signature}>{r.signature}</div>
                </div>
              ))}
              {!recurring.length && <div className="text-xs text-muted">No recurring failures.</div>}
            </div>
          </Card>
        </div>

        <div className="min-w-0">{selectedId ? <ProposalDetail key={selectedId} id={selectedId} onChange={list.reload} /> : <Card><Empty title="Select a proposal" /></Card>}</div>
      </div>
    </div>
  );
}

function ProposalDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const { data: p, error, loading, reload } = useApi<any>(`/proposals/${id}`);
  const [tab, setTab] = useState<"diff" | "side" | "proposed">("diff");
  const [note, setNote] = useState("");
  const [liveResult, setLiveResult] = useState<any>(null);
  const [decision, setDecision] = useState<any>(null);
  const refresh = async () => { await reload(); onChange(); };
  const evaluate = useAction(async () => { await post(`/proposals/${id}/evaluate`); await refresh(); });
  const refine = useAction(async () => { await post(`/proposals/${id}/refine`); await refresh(); });
  const decide = useAction(async (d: "approve" | "reject") => { const r = await post(`/proposals/${id}/decide`, { decision: d, note }); setDecision(r); await refresh(); });
  const live = useAction(async () => { const r = await post(`/agents/live-run`, { skill: p.skill_slug, n: 20 }); setLiveResult(r); });

  if (loading && !p) return <Card><Spinner /></Card>;
  if (error) return <ErrorBox error={error} />;
  if (!p) return null;
  const ev = p.eval;
  const candFails = ev ? ev.results.filter((r: any) => r.candidate.status === "failure") : [];
  const isOpen = ["pending", "evaluated"].includes(p.status);
  const clusters = p.evidence?.clusters ?? [];
  const knowledge = p.evidence?.knowledge ?? [];
  const revisions = p.evidence?.revisions ?? [];

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              {p.kind === "new_skill" ? <Badge tone="accent"><Sparkles className="size-3" />New skill from repeated workflow</Badge> : <Link to={`/skills/${p.skill_slug}`} className="inline-flex items-center gap-1 hover:text-accent"><BookOpen className="size-3" />{p.skill_name} · v{p.base_version} → proposed</Link>}
              <span>·</span><span>Drafted by {p.generator === "claude" ? "Claude" : "the rule engine"} · {dateTime(p.created_at)}</span>
            </div>
            <h2 className="text-lg font-semibold text-ink">{p.title}</h2>
          </div>
          <StatusBadge status={p.status} />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          {p.kind === "improve" ? (
            <>
              <Mini label="Detected issue" value={p.issue} />
              <Mini label="Historical success" value={pct(p.stats?.historicalRate)} sub={`${p.stats?.runs ?? 0} runs`} />
              <Mini label="Recent success (last 20)" value={pct(p.stats?.recentRate)} />
              <Mini label="Failures analysed" value={p.stats?.failures ?? "—"} sub={`${clusters.length} cluster(s)`} />
            </>
          ) : (
            <>
              <Mini label="Pattern" value="Repeated manual workflow" />
              <Mini label="Support" value={`${p.stats?.support ?? "?"} sessions`} />
              <Mini label="Steps" value={p.evidence?.sequence?.length ?? "—"} />
              <Mini label="Harnesses" value="Claude Code, Codex" />
            </>
          )}
        </div>
        <p className="mt-4 text-sm leading-relaxed text-ink-2"><span className="font-medium text-ink">Analysis. </span>{p.analysis}</p>
      </Card>

      {/* Evidence */}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardTitle sub="Normalized failure signatures from execution traces">Evidence from traces</CardTitle>
          {p.kind === "improve" ? (
            <div className="space-y-3">
              {clusters.map((c: any) => (
                <div key={c.signature} className="rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="critical"><XCircle className="size-3" />{c.errorType}</Badge>
                    <span className="text-xs text-ink-2 tabular">{c.count} failures · {pct(c.share)} of runs</span>
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] text-ink-2">{c.signature}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {c.sampleTraceIds.slice(0, 5).map((t: string) => <Link key={t} to={`/agents/${t}`} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-2 hover:border-accent hover:text-accent">{t.slice(-8)}</Link>)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                {(p.evidence?.sequence ?? []).map((s: string, i: number) => <span key={i} className="inline-flex items-center gap-1.5">{i > 0 && <ArrowRight className="size-3 text-muted" />}<code className="rounded bg-code px-1.5 py-0.5 text-xs">{s}</code></span>)}
              </div>
              <div className="text-xs text-muted">Example tasks: {(p.evidence?.exampleTasks ?? []).map((t: string) => `“${t}”`).join(", ")}</div>
              <div className="flex flex-wrap gap-1.5">{(p.evidence?.traceIds ?? []).map((t: string) => <Link key={t} to={`/agents/${t}`} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-2 hover:border-accent">{t.slice(-8)}</Link>)}</div>
            </div>
          )}
        </Card>
        <Card>
          <CardTitle sub="What the organization already knows about this problem">Grounding in organizational memory</CardTitle>
          {knowledge.length ? (
            <div className="space-y-2.5">
              {knowledge.filter((k: any, i: number, a: any[]) => a.findIndex((x) => x.docId === k.docId) === i).slice(0, 4).map((k: any) => (
                <Link key={k.docId} to={`/lake/${k.docId}`} className="block rounded-lg border border-line p-3 transition hover:border-accent">
                  <div className="mb-1 flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-ink">{k.title}</span><SourceBadge kind={k.sourceKind} /></div>
                  <div className="line-clamp-2 text-xs text-ink-2">{k.snippet}</div>
                </Link>
              ))}
            </div>
          ) : <div className="text-sm text-muted">No related documents found for this pattern.</div>}
          {revisions.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-xs font-semibold text-ink">Revision history</div>
              {revisions.map((r: any, i: number) => (
                <div key={i} className="mb-2 flex gap-2 text-xs">
                  <RefreshCw className="mt-0.5 size-3 shrink-0 text-accent" />
                  <div><span className="text-ink">Revised after evaluation ({r.errorTypes.join(", ")})</span><div className="text-muted">{r.reason}</div></div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Before / after */}
      <Card>
        <CardTitle sub={p.kind === "improve" ? `Current v${p.base_version} vs proposed` : "Proposed SKILL.md"} right={p.kind === "improve" && <FileDiff className="size-4 text-muted" />}>Skill change</CardTitle>
        {p.kind === "improve" ? (
          <>
            <Tabs tabs={[{ id: "diff", label: "Unified diff" }, { id: "side", label: "Side by side" }, { id: "proposed", label: "Proposed file" }]} value={tab} onChange={setTab} />
            {tab === "diff" && <DiffView diff={p.diff} className="max-h-[420px]" />}
            {tab === "side" && (
              <div className="grid gap-3 md:grid-cols-2">
                <div><div className="mb-1.5 text-xs font-medium text-muted">Current · v{p.base_version}</div><DiffView diff={p.diff.filter((d: any) => d.op !== "add")} className="max-h-[420px]" /></div>
                <div><div className="mb-1.5 text-xs font-medium text-muted">Proposed</div><DiffView diff={p.diff.filter((d: any) => d.op !== "del")} className="max-h-[420px]" /></div>
              </div>
            )}
            {tab === "proposed" && <CodeBlock code={p.proposed_content} lang="SKILL.md" maxHeight={420} />}
          </>
        ) : <CodeBlock code={p.proposed_content} lang="SKILL.md" maxHeight={420} />}
      </Card>

      {/* Evaluation */}
      {p.kind === "improve" && (
        <Card>
          <CardTitle
            sub="Each historical failure's fault conditions are replayed against the PayFlow sandbox with real HTTP calls; the agent runtime follows each skill version's compiled policy. Regression and control cases guard against breaking healthy paths."
            right={<Button variant={ev ? "secondary" : "primary"} icon={<Play className="size-3.5" />} busy={evaluate.busy} onClick={() => evaluate.run()} disabled={!isOpen}>{ev ? "Re-run evaluation" : "Run evaluation"}</Button>}
          >
            Evaluation against historical failures
          </CardTitle>
          <ErrorBox error={evaluate.error} />
          {evaluate.busy && <div className="flex items-center gap-2 py-3 text-sm text-muted"><RefreshCw className="size-4 animate-spin" /> Replaying failure cases against both versions…</div>}
          {!ev && !evaluate.busy && <Empty title="Not evaluated yet" icon={<Gauge className="size-6" />}>The proposed target must be validated by actual tests before approval.</Empty>}
          {ev && <EvalResults ev={ev} />}
          {ev && candFails.length > 0 && isOpen && (
            <div className="mt-4">
              <Callout tone="warning" icon={<AlertTriangle className="size-4 text-warning-ink" />}>
                <div className="font-medium">The evaluation caught {candFails.length} case(s) the proposed skill still fails.</div>
                <div className="mt-0.5 text-ink-2">{[...new Set(candFails.map((r: any) => `${r.case.label}: ${r.candidate.outcome}`))].slice(0, 3).join(" · ")}</div>
                <Button className="mt-2.5" size="sm" variant="primary" icon={<Wand2 className="size-3.5" />} busy={refine.busy} onClick={() => refine.run()}>Refine proposal from evaluation</Button>
                <ErrorBox error={refine.error} />
              </Callout>
            </div>
          )}
        </Card>
      )}

      {/* Decision */}
      <Card>
        <CardTitle sub="Approval creates a new immutable version, activates it, and syncs it to Claude Code and Codex. Rollback is one click in the Skill Library.">Human review</CardTitle>
        {isOpen ? (
          <div className="space-y-3">
            {p.kind === "improve" && !ev && <Callout tone="warning" icon={<AlertTriangle className="size-4 text-warning-ink" />}>Not evaluated yet — run the evaluation before approving.</Callout>}
            {ev && ev.candidate_rate < ev.baseline_rate && <Callout tone="critical" icon={<XCircle className="size-4 text-critical" />}>The proposed version performs worse than the current one on the evaluation.</Callout>}
            <Input placeholder="Review note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="w-full" />
            <div className="flex flex-wrap gap-2">
              <Button variant="good" icon={<CheckCircle2 className="size-4" />} busy={decide.busy} onClick={() => decide.run("approve")}>Approve {p.kind === "improve" ? "improvement" : "new skill"}</Button>
              <Button variant="danger" icon={<XCircle className="size-4" />} disabled={decide.busy} onClick={() => decide.run("reject")}>Reject</Button>
            </div>
            <ErrorBox error={decide.error} />
          </div>
        ) : (
          <div className="space-y-3">
            <KV items={[["Decision", <StatusBadge status={p.status} />], ["Decided", dateTime(p.decided_at)], ["Note", p.decision_note]]} />
            {decision?.synced && (
              <Callout tone="good" icon={<GitBranch className="size-4 text-good-ink" />}>
                Activated v{decision.version}. Synced to {decision.synced.map((s: any) => `${s.harness} (${s.skills} skills)`).join(", ")}.
              </Callout>
            )}
          </div>
        )}
      </Card>

      {p.status === "approved" && p.kind === "improve" && (
        <Card>
          <CardTitle sub="Run production-like traffic through the real executor with the active skill version and compare success by version." right={<Button variant="primary" icon={<Activity className="size-3.5" />} busy={live.busy} onClick={() => live.run()}>Run 20 live executions</Button>}>Verify in subsequent executions</CardTitle>
          <ErrorBox error={live.error} />
          {liveResult && <div className="mb-3"><Callout tone={liveResult.succeeded / liveResult.executed > 0.9 ? "good" : "warning"} icon={<Activity className="size-4" />}>{liveResult.succeeded}/{liveResult.executed} executions succeeded on v{liveResult.version}.</Callout></div>}
          <VersionCompare slug={p.skill_slug} bump={liveResult} />
        </Card>
      )}
    </div>
  );
}

const Mini = ({ label, value, sub }: { label: string; value: any; sub?: string }) => (
  <div className="rounded-lg bg-surface-2 px-3 py-2.5">
    <div className="text-[11px] text-muted">{label}</div>
    <div className="truncate text-[15px] font-semibold text-ink tabular" title={typeof value === "string" ? value : undefined}>{value}</div>
    {sub && <div className="text-[11px] text-muted">{sub}</div>}
  </div>
);

function EvalResults({ ev }: { ev: any }) {
  const [open, setOpen] = useState<string | null>(null);
  const delta = ev.candidate_rate - ev.baseline_rate;
  const policyKeys = ["timeoutMs", "maxRetries", "backoff", "backoffBaseMs", "retryOn", "respectRetryAfter", "idempotencyKey", "logFinalFailure"];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-line p-4">
          <div className="text-xs text-muted">{ev.baseline_label}</div>
          <div className="text-3xl font-semibold tabular text-ink">{pct(ev.baseline_rate)}</div>
          <div className="text-xs text-muted">{ev.results.filter((r: any) => r.baseline.status === "success").length}/{ev.results.length} cases pass</div>
        </div>
        <div className="rounded-lg border border-line p-4">
          <div className="text-xs text-muted">Proposed</div>
          <div className="text-3xl font-semibold tabular text-ink">{pct(ev.candidate_rate)}</div>
          <div className="text-xs text-muted">{ev.results.filter((r: any) => r.candidate.status === "success").length}/{ev.results.length} cases pass</div>
        </div>
        <div className={cx("rounded-lg border p-4", delta > 0 ? "border-good/30 bg-good-soft" : "border-line")}>
          <div className="text-xs text-muted">Measured change</div>
          <div className={cx("text-3xl font-semibold tabular", delta > 0 ? "text-good-ink" : delta < 0 ? "text-critical" : "text-ink")}>{delta > 0 ? "+" : ""}{(delta * 100).toFixed(0)} pts</div>
          <div className="text-xs text-muted">{ev.results.length} cases · {ms(ev.duration_ms)} · policy compiler: {ev.compiler === "claude" ? "Claude" : "rules"}</div>
        </div>
      </div>

      <details className="rounded-lg border border-line">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-2">Compiled execution policy (what the agent actually does under each version)</summary>
        <Table head={["Policy field", ev.baseline_label, "Proposed"]}>
          {policyKeys.map((k) => {
            const a = ev.baseline_policy?.[k], b = ev.candidate_policy?.[k];
            return <tr key={k}><Td className="font-mono text-xs text-ink-2">{k}</Td><Td className="font-mono text-xs">{String(a)}</Td><Td className={cx("font-mono text-xs", String(a) !== String(b) && "font-semibold text-good-ink")}>{String(b)}</Td></tr>;
          })}
        </Table>
      </details>

      <Table head={["Case", "Origin", ev.baseline_label, "Proposed", ""]}>
        {ev.results.map((r: any) => (
          <FragmentRow key={r.case.id} r={r} open={open === r.case.id} toggle={() => setOpen(open === r.case.id ? null : r.case.id)} />
        ))}
      </Table>
    </div>
  );
}

function Outcome({ x }: { x: any }) {
  return (
    <div className="flex items-center gap-1.5">
      {x.status === "success" ? <CheckCircle2 className="size-3.5 shrink-0 text-good" /> : <XCircle className="size-3.5 shrink-0 text-critical" />}
      <span className="text-xs text-ink-2">{x.outcome} <span className="text-muted">· {x.attempts} att · {ms(x.latency_ms)}</span></span>
    </div>
  );
}

function stepNote(s: any): string {
  const o = s.output ?? {};
  const parts: string[] = [];
  if (o.status != null) parts.push(`HTTP ${o.status}`);
  if (o.ms != null) parts.push(`wait ${o.ms}ms`);
  if (o.error) parts.push(o.error);
  if (o.outcome) parts.push(o.outcome);
  if (s.input?.idempotency_key) parts.push("idempotency-key ✓");
  if (s.latency_ms != null) parts.push(`${s.latency_ms}ms`);
  return parts.join(" · ");
}

function FragmentRow({ r, open, toggle }: { r: any; open: boolean; toggle: () => void }) {
  const originTone = r.case.origin === "historical_failure" ? "critical" : r.case.origin === "control" ? "accent" : "neutral";
  return (
    <>
      <tr className="cursor-pointer hover:bg-surface-2" onClick={toggle}>
        <Td className="text-xs text-ink">{r.case.label}{r.case.traceId && <Link onClick={(e) => e.stopPropagation()} to={`/agents/${r.case.traceId}`} className="ml-1.5 font-mono text-[10px] text-muted hover:text-accent">trace</Link>}</Td>
        <Td><Badge tone={originTone as any}>{r.case.origin.replace("_", " ")}</Badge></Td>
        <Td><Outcome x={r.baseline} /></Td>
        <Td><Outcome x={r.candidate} /></Td>
        <Td className="text-xs text-muted">{open ? "Hide" : "Steps"}</Td>
      </tr>
      {open && (
        <tr>
          <Td colSpan={5} className="bg-surface-2">
            <div className="grid gap-3 md:grid-cols-2">
              {(["baseline", "candidate"] as const).map((k) => (
                <div key={k}>
                  <div className="mb-1 text-[11px] font-medium text-muted">{k === "baseline" ? "Current" : "Proposed"}</div>
                  <ol className="space-y-1">
                    {r[k].steps.filter((s: any) => s.type !== "plan").map((s: any, i: number) => (
                      <li key={i} className="flex items-start gap-1.5 font-mono text-[11px]">
                        <span className={cx("mt-1 size-1.5 shrink-0 rounded-full", s.status === "error" ? "bg-critical" : s.status === "ok" ? "bg-good" : "bg-muted")} />
                        <span className="text-ink">{s.type}{s.name ? ` · ${s.name}` : ""}</span>
                        <span className="truncate text-muted">{stepNote(s)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </Td>
        </tr>
      )}
    </>
  );
}

function VersionCompare({ slug, bump }: { slug: string; bump: unknown }) {
  const { data, reload } = useApi<any>(`/skills/${slug}`);
  useEffect(() => { if (bump) reload(); }, [bump]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Spinner />;
  const rows = data.stats.byVersion as any[];
  return (
    <div className="space-y-3">
      {rows.map((v) => (
        <div key={v.v} className="grid grid-cols-[70px_1fr_150px] items-center gap-3 text-sm">
          <span className="font-medium text-ink">v{v.v}{v.v === data.active_version && <span className="ml-1 text-[10px] text-accent">active</span>}</span>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-[var(--s1)]" style={{ width: `${v.rate * 100}%` }} /></div>
          <span className="text-right text-xs text-ink-2 tabular"><span className="font-semibold text-ink">{pct(v.rate)}</span> · {v.ok}/{v.runs} runs · {ms(v.lat)}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5 pt-1 text-xs text-muted"><FileText className="size-3" /> Live executions recorded as traces (origin: live) — open <Link to="/agents" className="text-accent hover:underline">AI Agents</Link> to inspect them. Updated {date(new Date().toISOString())}.</div>
    </div>
  );
}
