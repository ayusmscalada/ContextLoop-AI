import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, AlertTriangle, ArrowRight, Bot, BookOpen, Boxes, Database, FlaskConical, Network, Plug, Search, Share2, Sparkles, XCircle } from "lucide-react";
import { useApi } from "../lib/api";
import { ENTITY_META, ENTITY_ORDER, SOURCE_META, SOURCE_ORDER, ago, bytes, num, pct, usd } from "../lib/format";
import { Badge, Callout, Card, CardTitle, ErrorBox, Meter, PageHeader, Spinner, Stat, StatusBadge, cx } from "../components/ui";
import { ChartTooltip, Legend, axisProps, gridProps } from "../components/charts";

const shortDay = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default function Overview() {
  const { data: o, error, loading } = useApi<any>("/overview");
  if (loading && !o) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!o) return null;

  const avgQuery = o.ingest.index.queries ? o.ingest.index.totalQueryMs / o.ingest.index.queries : null;
  const sourcesPresent = SOURCE_ORDER.filter((k) => o.ingest.daily.some((d: any) => d[k]));
  const loop = [
    { label: "Capture", value: num(o.sessions), sub: "AI sessions", to: "/sources", icon: Plug },
    { label: "Store", value: num(o.documents), sub: `docs · ${bytes(o.ingest.lakeBytes)}`, to: "/lake", icon: Database },
    { label: "Understand", value: num(o.entities), sub: `entities · ${num(o.relations)} links`, to: "/graph", icon: Network },
    { label: "Retrieve", value: num(o.ingest.chunks), sub: `chunks · ${avgQuery != null ? avgQuery.toFixed(1) + " ms" : "—"} avg`, to: "/search", icon: Search },
    { label: "Improve", value: num(o.pending.proposals), sub: "pending proposals", to: "/lab", icon: FlaskConical },
    { label: "Share", value: num(o.skills), sub: "synced skills", to: "/skills", icon: Share2 },
  ];
  const skills = [...o.agents.bySkill].filter((s: any) => s.runs).sort((a: any, b: any) => (a.rate ?? 0) - (b.rate ?? 0));
  const attention = o.pending.conflicts + o.pending.proposals + o.pending.recurringFailures;

  return (
    <div>
      <PageHeader
        title="Organizational intelligence"
        subtitle="Everything your people and agents produce, captured raw, turned into typed knowledge, and fed back into better skills."
        badge={o.llm.enabled ? <Badge tone="accent"><Sparkles className="size-3" />Claude</Badge> : <Badge>Offline engine</Badge>}
      />

      {/* Learning loop */}
      <Card pad={false} className="mb-5 overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {loop.map((s, i) => (
            <Link key={s.label} to={s.to} className={cx("group relative flex flex-col gap-1 px-4 py-3.5 transition hover:bg-surface-2", i > 0 && "lg:border-l border-line")}>
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                <s.icon className="size-3.5" /> {s.label}
                {i < loop.length - 1 && <ArrowRight className="ml-auto size-3 text-line-strong max-lg:hidden" />}
              </div>
              <div className="tabular text-xl font-semibold text-ink">{s.value}</div>
              <div className="truncate text-xs text-ink-2">{s.sub}</div>
            </Link>
          ))}
        </div>
      </Card>

      {attention > 0 && (
        <div className="mb-5">
          <Callout tone="warning" icon={<AlertTriangle className="size-4 text-warning-ink" />}>
            <span className="font-medium">Needs attention: </span>
            <Link to="/graph?tab=conflicts" className="underline decoration-dotted underline-offset-2">{o.pending.conflicts} knowledge conflict{o.pending.conflicts === 1 ? "" : "s"}</Link>
            {" · "}
            <Link to="/lab" className="underline decoration-dotted underline-offset-2">{o.pending.proposals} skill proposal{o.pending.proposals === 1 ? "" : "s"} awaiting review</Link>
            {" · "}
            <Link to="/agents" className="underline decoration-dotted underline-offset-2">{o.pending.recurringFailures} recurring failure pattern{o.pending.recurringFailures === 1 ? "" : "s"}</Link>
          </Callout>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Captured AI sessions" value={num(o.sessions)} icon={<Boxes className="size-4" />} sub={`${o.bySource.chatgpt ?? 0} ChatGPT · ${o.bySource.claude_code ?? 0} Claude Code · ${o.bySource.codex ?? 0} Codex`} />
        <Stat label="Connected sources" value={num(o.sources)} icon={<Plug className="size-4" />} sub={`${num(o.documents)} documents · ${o.duplicatesBlocked} duplicates blocked`} />
        <Stat label="Knowledge entities" value={num(o.entities)} icon={<Network className="size-4" />} sub={`${num(o.relations)} relationships`} />
        <Stat label="Active skills" value={num(o.skills)} icon={<BookOpen className="size-4" />} sub="synced to Claude Code & Codex" />
        <Stat label="Agent success rate" value={pct(o.agents.rate)} icon={<Bot className="size-4" />} sub={`${num(o.agents.executions)} executions`} />
        <Stat label="Agent failures" value={num(o.agents.failures)} tone={o.agents.failures ? "critical" : undefined} icon={<XCircle className="size-4" />} sub={`${o.pending.recurringFailures} recurring patterns`} />
        <Stat label="Pending improvements" value={num(o.pending.proposals)} icon={<FlaskConical className="size-4" />} sub={<Link to="/lab" className="text-accent hover:underline">Open Improvement Lab →</Link>} />
        <Stat label="Agent spend" value={usd(o.agents.cost)} icon={<Activity className="size-4" />} sub={`${num(o.agents.tokens)} tokens`} />
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle sub="Documents ingested per day, by source" right={<Legend items={sourcesPresent.map((k) => ({ label: SOURCE_META[k].label, color: SOURCE_META[k].color }))} />}>Data ingestion</CardTitle>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={o.ingest.daily} margin={{ top: 4, right: 4, left: -24, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="day" tickFormatter={shortDay} {...axisProps} />
                <YAxis allowDecimals={false} {...axisProps} axisLine={false} />
                <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTooltip labelFormat={shortDay} />} />
                {sourcesPresent.map((k, i) => (
                  <Bar key={k} dataKey={k} name={SOURCE_META[k].label} stackId="a" fill={SOURCE_META[k].color} stroke="var(--surface)" strokeWidth={2} radius={i === sourcesPresent.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={18} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs sm:grid-cols-4">
            <Mini label="Indexed chunks" value={num(o.ingest.chunks)} />
            <Mini label="Raw lake size" value={bytes(o.ingest.lakeBytes)} />
            <Mini label="Index terms" value={num(o.ingest.index.terms)} />
            <Mini label="Avg query latency" value={avgQuery != null ? `${avgQuery.toFixed(2)} ms` : "—"} />
          </div>
        </Card>

        <Card>
          <CardTitle sub="Typed knowledge in the ontology">Entities by type</CardTitle>
          <div className="space-y-2.5">
            {ENTITY_ORDER.filter((t) => o.entityTypes[t]).map((t) => {
              const max = Math.max(...Object.values(o.entityTypes as Record<string, number>));
              return (
                <Link to="/graph" key={t} className="block">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="inline-flex items-center gap-1.5 text-ink-2"><span className="size-2 rounded-sm" style={{ background: ENTITY_META[t].color }} />{ENTITY_META[t].label}</span>
                    <span className="tabular font-medium text-ink">{o.entityTypes[t]}</span>
                  </div>
                  <Meter value={o.entityTypes[t] / max} color={ENTITY_META[t].color} />
                </Link>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle sub="All-time success rate per skill, lowest first" right={<Link to="/skills" className="text-xs text-accent hover:underline">Skill Library</Link>}>Agent success by skill</CardTitle>
          <div className="space-y-3">
            {skills.map((s: any) => (
              <Link key={s.id} to={`/skills/${s.slug}`} className="block">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-ink">{s.name} <span className="text-muted">v{s.active_version}</span></span>
                  <span className="tabular text-ink-2"><span className="font-medium text-ink">{pct(s.rate)}</span> · {s.runs} runs</span>
                </div>
                <Meter value={s.rate} color="var(--s1)" />
              </Link>
            ))}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle sub="Latest actions by people and agents" right={<Link to="/audit" className="text-xs text-accent hover:underline">Audit log</Link>}>Recent organizational activity</CardTitle>
          <ul className="divide-y divide-line">
            {o.activity.map((a: any) => (
              <li key={a.id} className="flex items-start gap-3 py-2 text-sm">
                <span className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", a.outcome === "denied" ? "bg-critical" : a.actor_type === "agent" ? "bg-accent" : "bg-line-strong")} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium text-ink">{a.actor_name}</span>
                    <code className="rounded bg-surface-2 px-1 text-[11px] text-ink-2">{a.action}</code>
                    {a.outcome === "denied" && <StatusBadge status="denied" />}
                  </div>
                  <div className="truncate text-xs text-muted">{a.detail || a.resource}</div>
                </div>
                <span className="shrink-0 text-xs text-muted">{ago(a.at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

const Mini = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="text-muted">{label}</div>
    <div className="tabular text-sm font-medium text-ink">{value}</div>
  </div>
);
