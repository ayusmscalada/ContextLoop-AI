import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BookOpen, GitBranch, RotateCcw, RefreshCw, FlaskConical, ArrowLeft, CheckCircle2 } from "lucide-react";
import { post, useAction, useApi } from "../lib/api";
import { ago, date, dateTime, ms, num, pct } from "../lib/format";
import { Badge, Button, Callout, Card, CardTitle, CodeBlock, cx, DiffView, Empty, ErrorBox, Meter, PageHeader, Spinner, StatusBadge, Table, Td, Tabs } from "../components/ui";

const HARNESS_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
const rateColor = (r: number | null) => (r == null ? "var(--muted)" : "var(--s1)");

export default function Skills() {
  const { id } = useParams();
  return id ? <SkillDetail id={id} /> : <Registry />;
}

function Registry() {
  const { data, loading, error, reload } = useApi<any>("/skills");
  const nav = useNavigate();
  const [synced, setSynced] = useState<any[] | null>(null);
  const sync = useAction(async () => { const r = await post<any[]>("/skills/sync"); setSynced(r); await reload(); });
  const skills = data?.skills ?? [];
  return (
    <div>
      <PageHeader
        title="Skill Library"
        subtitle="Reusable, versioned agent capabilities shared across Claude Code and Codex. Every invocation is measured; improvements arrive through the Improvement Lab and require human approval."
        actions={<Button icon={<GitBranch className="size-4" />} busy={sync.busy} onClick={() => sync.run()}>Sync to harnesses</Button>}
      />
      <ErrorBox error={error ?? sync.error} />
      {synced && <div className="mb-4"><Callout tone="good" icon={<CheckCircle2 className="size-4 text-good-ink" />}>Synced {synced.map((s) => `${s.skills} skills → ${HARNESS_LABEL[s.harness] ?? s.harness} (${s.dir})`).join("; ")}</Callout></div>}
      {loading && !data ? <Spinner /> : (
        <Card pad={false}>
          <Table head={["Skill", "Active", "Success rate", "Last 20", "Runs", "Harnesses", "Pending", "Synced"]}>
            {skills.map((s: any) => (
              <tr key={s.id} className="cursor-pointer hover:bg-surface-2" onClick={() => nav(`/skills/${s.slug}`)}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <div className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent"><BookOpen className="size-4" /></div>
                    <div className="min-w-0">
                      <div className="font-medium text-ink">{s.name}</div>
                      <div className="max-w-[340px] truncate text-xs text-muted">{s.description}</div>
                    </div>
                  </div>
                </Td>
                <Td><Badge tone="accent">v{s.active_version}</Badge><span className="ml-1.5 text-xs text-muted">of {s.versions}</span></Td>
                <Td className="w-48">
                  <div className="flex items-center gap-2"><Meter value={s.stats.rate} color={rateColor(s.stats.rate)} /><span className="w-10 text-right text-xs font-medium tabular">{pct(s.stats.rate)}</span></div>
                </Td>
                <Td className="text-sm tabular">{pct(s.stats.recentRate)}</Td>
                <Td className="text-sm tabular">{num(s.stats.runs)}</Td>
                <Td><div className="flex gap-1">{s.harnesses.map((h: string) => <Badge key={h}>{HARNESS_LABEL[h] ?? h}</Badge>)}</div></Td>
                <Td>{s.pending ? <Badge tone="warning">{s.pending} proposal{s.pending > 1 ? "s" : ""}</Badge> : <span className="text-xs text-muted">—</span>}</Td>
                <Td className="text-xs text-muted">{ago(s.synced_at)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {data?.targets && (
        <Card className="mt-5">
          <CardTitle sub="Approved versions are written as SKILL.md files; Codex also gets an AGENTS.md index. Point these at ~/.claude/skills or a repo in Settings.">Sync targets</CardTitle>
          <div className="space-y-1.5">
            {data.targets.map((t: any) => (
              <div key={t.harness} className="flex flex-wrap items-center gap-2 text-sm"><Badge>{HARNESS_LABEL[t.harness] ?? t.harness}</Badge><code className="rounded bg-code px-1.5 py-0.5 text-xs text-ink-2">{t.dir}</code></div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function SkillDetail({ id }: { id: string }) {
  const { data: s, error, loading, reload } = useApi<any>(`/skills/${id}`);
  const [tab, setTab] = useState<"content" | "versions" | "history">("content");
  const [compare, setCompare] = useState<number | null>(null);
  const rollback = useAction(async (v: number) => { await post(`/skills/${s.id}/rollback`, { version: v }); await reload(); });
  if (loading && !s) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!s) return null;
  const active = s.versions.find((v: any) => v.version === s.active_version);
  const cmp = compare ? s.versions.find((v: any) => v.version === compare) : null;

  return (
    <div>
      <Link to="/skills" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink"><ArrowLeft className="size-3" /> Skill Library</Link>
      <PageHeader
        title={s.name}
        badge={<Badge tone="accent">v{s.active_version} active</Badge>}
        subtitle={s.description}
        actions={<Link to="/lab"><Button icon={<FlaskConical className="size-4" />}>Improvement Lab</Button></Link>}
      />
      <ErrorBox error={rollback.error} />
      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Card><div className="text-xs text-muted">Success rate (all)</div><div className="text-2xl font-semibold tabular">{pct(s.stats.rate)}</div><div className="text-xs text-muted">{num(s.stats.runs)} runs</div></Card>
        <Card><div className="text-xs text-muted">Last 20 executions</div><div className="text-2xl font-semibold tabular">{pct(s.stats.recentRate)}</div></Card>
        <Card><div className="text-xs text-muted">Versions</div><div className="text-2xl font-semibold tabular">{s.versions.length}</div><div className="text-xs text-muted">category: {s.category}</div></Card>
        <Card><div className="text-xs text-muted">Synced</div><div className="text-2xl font-semibold">{s.synced_at ? ago(s.synced_at) : "never"}</div><div className="text-xs text-muted">{s.harnesses.map((h: string) => HARNESS_LABEL[h] ?? h).join(" · ")}</div></Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card>
          <Tabs tabs={[{ id: "content", label: "Active SKILL.md" }, { id: "versions", label: "Versions", count: s.versions.length }, { id: "history", label: "Evaluations & proposals", count: s.evals.length + s.proposals.length }]} value={tab} onChange={setTab} />
          {tab === "content" && <CodeBlock code={s.content} lang={`${s.slug}/SKILL.md · v${s.active_version}`} maxHeight={560} />}
          {tab === "versions" && (
            <div className="space-y-3">
              {s.versions.map((v: any) => (
                <div key={v.id} className={cx("rounded-lg border p-3", v.version === s.active_version ? "border-accent/40 bg-accent-soft" : "border-line")}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">v{v.version}</span>
                      {v.version === s.active_version && <Badge tone="accent">active</Badge>}
                      <span className="text-xs text-muted">{v.author ?? "system"} · {dateTime(v.created_at)}</span>
                    </div>
                    <div className="flex gap-1.5">
                      {v.version !== s.active_version && <Button size="sm" variant="ghost" onClick={() => setCompare(compare === v.version ? null : v.version)}>{compare === v.version ? "Hide diff" : "Diff vs active"}</Button>}
                      {v.version !== s.active_version && <Button size="sm" icon={<RotateCcw className="size-3" />} busy={rollback.busy} onClick={() => rollback.run(v.version)}>{v.version < s.active_version ? "Roll back" : "Activate"}</Button>}
                    </div>
                  </div>
                  <div className="mt-1 text-sm text-ink-2">{v.changelog}</div>
                  {v.proposal_id && <Link to={`/lab/${v.proposal_id}`} className="mt-1 inline-block text-xs text-accent hover:underline">From proposal →</Link>}
                  {cmp && cmp.id === v.id && active && <DiffView className="mt-3 max-h-80" diff={lineDiffClient(v.content, active.content)} />}
                </div>
              ))}
            </div>
          )}
          {tab === "history" && (
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-xs font-semibold text-ink">Evaluation runs</div>
                {s.evals.length ? (
                  <Table head={["When", "Baseline", "Candidate", "Compiler"]}>
                    {s.evals.map((e: any) => <tr key={e.id}><Td className="text-xs">{dateTime(e.created_at)}</Td><Td className="text-xs">{e.baseline_label}: <b>{pct(e.baseline_rate)}</b></Td><Td className="text-xs">{e.candidate_label}: <b>{pct(e.candidate_rate)}</b></Td><Td className="text-xs">{e.compiler}</Td></tr>)}
                  </Table>
                ) : <div className="text-sm text-muted">No evaluations yet.</div>}
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold text-ink">Proposals</div>
                {s.proposals.length ? s.proposals.map((p: any) => (
                  <Link key={p.id} to={`/lab/${p.id}`} className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-line p-2.5 hover:border-accent">
                    <span className="truncate text-sm">{p.title}</span><StatusBadge status={p.status} />
                  </Link>
                )) : <div className="text-sm text-muted">No proposals.</div>}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle sub="Measured on real executions (eval replays excluded)">Success by version</CardTitle>
          {s.stats.byVersion.length ? (
            <div className="space-y-3">
              {s.stats.byVersion.map((v: any) => (
                <div key={v.v}>
                  <div className="mb-1 flex items-center justify-between text-xs"><span className="font-medium text-ink">v{v.v}</span><span className="text-ink-2 tabular"><b className="text-ink">{pct(v.rate)}</b> · {v.ok}/{v.runs} · {ms(v.lat)} avg</span></div>
                  <Meter value={v.rate} />
                </div>
              ))}
            </div>
          ) : <Empty title="No executions yet" />}
          <div className="mt-5 border-t border-line pt-4">
            <div className="mb-2 text-xs font-semibold text-ink">Recent executions</div>
            <RecentTraces skillId={s.id} />
          </div>
          <Button className="mt-4 w-full" size="sm" variant="ghost" icon={<RefreshCw className="size-3" />} onClick={() => reload()}>Refresh</Button>
          <div className="mt-2 text-center text-[11px] text-muted">Created {date(s.created_at)}</div>
        </Card>
      </div>
    </div>
  );
}

function RecentTraces({ skillId }: { skillId: string }) {
  const { data } = useApi<any>(`/traces?skill=${skillId}&limit=8`);
  if (!data) return <Spinner />;
  return (
    <div className="space-y-1.5">
      {data.rows.map((t: any) => (
        <Link key={t.id} to={`/agents/${t.id}`} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-surface-2">
          <span className="truncate text-ink-2">v{t.skill_version} · {t.task}</span>
          <StatusBadge status={t.status} />
        </Link>
      ))}
    </div>
  );
}

/** Client-side line diff for version comparisons (same LCS as the server). */
function lineDiffClient(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: "eq" | "add" | "del"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push({ op: "eq", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "del", text: A[i++] });
    else out.push({ op: "add", text: B[j++] });
  }
  while (i < A.length) out.push({ op: "del", text: A[i++] });
  while (j < B.length) out.push({ op: "add", text: B[j++] });
  return out;
}
