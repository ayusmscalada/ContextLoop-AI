import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import cytoscape from "cytoscape";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Clock, FileText, Maximize2, Quote, Scale, X } from "lucide-react";
import { post, put, useAction, useApi } from "../lib/api";
import { ENTITY_META, ENTITY_ORDER, SOURCE_META, cssColor, date, dateTime, fmtValue } from "../lib/format";
import { Badge, Button, Callout, Card, CardTitle, EntityBadge, ErrorBox, Empty, Input, PageHeader, SourceBadge, Spinner, StatusBadge, Tabs, cx } from "../components/ui";

type Tab = "graph" | "conflicts" | "authority";

export default function Graph() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "graph";
  const { data: conflicts, reload: reloadConflicts } = useApi<any[]>("/conflicts");
  const open = conflicts?.filter((c) => c.status === "open").length ?? 0;
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); t === "graph" ? p.delete("tab") : p.set("tab", t); setParams(p); };

  return (
    <div>
      <PageHeader
        title="Knowledge graph"
        subtitle="The live state of the company: typed entities and relationships extracted from every source, with claims that keep their evidence, conflicts surfaced for review, and source authority you control."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "graph", label: "Graph" },
          { id: "conflicts", label: <span className="inline-flex items-center gap-1.5">Conflicts {open > 0 && <AlertTriangle className="size-3.5 text-warning-ink" />}</span>, count: open },
          { id: "authority", label: "Source authority" },
        ]}
      />
      {tab === "graph" && <GraphView />}
      {tab === "conflicts" && <Conflicts conflicts={conflicts} reload={reloadConflicts} />}
      {tab === "authority" && <Authority />}
    </div>
  );
}

// ======================= Graph view =======================
function GraphView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, loading } = useApi<any>("/graph");
  const [types, setTypes] = useState<string[]>(["project", "person", "customer", "technology", "issue", "decision"]);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of data?.nodes ?? []) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [data]);

  useEffect(() => {
    if (!data || !box.current) return;
    const nodes = data.nodes.filter((n: any) => types.includes(n.type));
    const ids = new Set(nodes.map((n: any) => n.id));
    const edges = data.edges.filter((e: any) => ids.has(e.source) && ids.has(e.target));
    const maxM = Math.max(1, ...nodes.map((n: any) => n.mentions));
    const ink = cssColor("var(--ink)"), ink2 = cssColor("var(--ink-2)"), surface = cssColor("var(--surface)"), grid = cssColor("var(--axis)"), accent = cssColor("var(--accent)"), warn = cssColor("var(--warning)");
    const inst = cytoscape({
      container: box.current,
      elements: [
        ...nodes.map((n: any) => ({
          data: { id: n.id, label: n.name.length > 34 ? n.name.slice(0, 32) + "…" : n.name, color: cssColor(ENTITY_META[n.type]?.color ?? "var(--muted)"), size: 14 + 26 * Math.sqrt(n.mentions / maxM), conflict: Object.values(n.attributes ?? {}).some((a: any) => a?.status === "conflict") ? 1 : 0 },
        })),
        ...edges.map((e: any) => ({ data: { id: e.id, source: e.source, target: e.target, label: e.type.replace(/_/g, " "), w: e.weight } })),
      ],
      style: [
        { selector: "node", style: { "background-color": "data(color)", width: "data(size)", height: "data(size)", label: "data(label)", "font-size": 10, color: ink, "text-valign": "bottom", "text-margin-y": 4, "text-outline-color": surface, "text-outline-width": 2, "border-width": 2, "border-color": surface } },
        { selector: "node[conflict = 1]", style: { "border-color": warn, "border-width": 3 } },
        { selector: "edge", style: { width: "mapData(w, 1, 5, 1, 3)", "line-color": grid, "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": grid, "arrow-scale": 0.7, opacity: 0.8 } },
        { selector: "edge.show", style: { label: "data(label)", "font-size": 9, color: ink2, "text-rotation": "autorotate", "text-outline-color": surface, "text-outline-width": 2, "line-color": accent, "target-arrow-color": accent, opacity: 1 } },
        { selector: "node:selected", style: { "border-color": accent, "border-width": 3 } },
        { selector: ".faded", style: { opacity: 0.15 } },
      ],
      layout: { name: "cose", animate: false, padding: 30, nodeRepulsion: () => 9000, idealEdgeLength: () => 90, randomize: true } as any,
      minZoom: 0.2,
      maxZoom: 3,
    });
    inst.on("tap", "node", (evt) => nav(`/graph/${evt.target.id()}`));
    inst.on("tap", (evt) => { if (evt.target === inst) nav("/graph"); });
    inst.on("mouseover", "edge", (e) => e.target.addClass("show"));
    inst.on("mouseout", "edge", (e) => { if (!e.target.connectedNodes().some((n: any) => n.selected())) e.target.removeClass("show"); });
    inst.on("mouseover", "node", (e) => { inst.elements().not(e.target.closedNeighborhood()).addClass("faded"); e.target.connectedEdges().addClass("show"); });
    inst.on("mouseout", "node", (e) => { inst.elements().removeClass("faded"); if (!e.target.selected()) e.target.connectedEdges().removeClass("show"); });
    cy.current = inst;
    return () => { inst.destroy(); cy.current = null; };
  }, [data, types, nav]);

  // reflect selection
  useEffect(() => {
    const inst = cy.current;
    if (!inst) return;
    inst.elements().unselect();
    inst.edges().removeClass("show");
    if (id) {
      const n = inst.getElementById(id);
      if (n.nonempty()) { n.select(); n.connectedEdges().addClass("show"); inst.animate({ center: { eles: n }, duration: 250 }); }
    }
  }, [id, data, types]);

  useEffect(() => {
    const inst = cy.current;
    if (!inst) return;
    inst.nodes().removeClass("faded");
    if (q.trim()) inst.nodes().filter((n) => !String(n.data("label")).toLowerCase().includes(q.toLowerCase())).addClass("faded");
  }, [q, data, types]);

  const toggle = (t: string) => setTypes((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
      <Card pad={false} className="flex min-h-[620px] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line p-3">
          {ENTITY_ORDER.map((t) => (
            <button key={t} onClick={() => toggle(t)} className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition", types.includes(t) ? "border-line-strong bg-surface text-ink" : "border-line bg-transparent text-muted line-through")}>
              <span className="size-2 rounded-full" style={{ background: types.includes(t) ? ENTITY_META[t].color : "var(--muted)" }} />
              {ENTITY_META[t].label} <span className="tabular text-muted">{counts[t] ?? 0}</span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Highlight…" className="h-8 w-40" />
            <Button size="sm" variant="ghost" icon={<Maximize2 className="size-3.5" />} onClick={() => cy.current?.fit(undefined, 30)}>Fit</Button>
          </div>
        </div>
        <div className="relative flex-1">
          {loading && !data && <div className="absolute inset-0"><Spinner /></div>}
          <ErrorBox error={error} />
          {/* explicit height: cytoscape forces position:relative on its container, so inset-0 sizing collapses */}
          <div ref={box} className="h-[580px] w-full" />
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-surface/90 px-2 py-1 text-[11px] text-muted">
            Node size = number of source documents · <span className="text-warning-ink">amber ring</span> = conflicting facts · hover for relationships
          </div>
        </div>
      </Card>
      <div>{id ? <EntityPanel id={id} onClose={() => nav("/graph")} /> : (
        <Card><Empty title="Select an entity" icon={<ArrowLeftRight className="size-6" />}>Click any node to see its attributes, relationships, claims with source evidence, and update history.</Empty></Card>
      )}</div>
    </div>
  );
}

function EntityPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: e, error, loading } = useApi<any>(`/entities/${id}`);
  if (loading && !e) return <Card><Spinner /></Card>;
  if (error) return <Card><ErrorBox error={error} /></Card>;
  if (!e) return null;
  const attrs = Object.entries(e.attributes ?? {}) as [string, any][];
  const rels = [...e.relations].sort((a: any, b: any) => a.type.localeCompare(b.type));
  return (
    <Card pad={false} className="max-h-[calc(100vh-180px)] overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-line bg-surface p-4">
        <div className="min-w-0">
          <EntityBadge type={e.type} />
          <h2 className="mt-1.5 text-base font-semibold leading-snug text-ink">{e.name}</h2>
          {e.description && e.description !== e.name && <p className="mt-1 text-xs text-ink-2">{e.description}</p>}
          {e.aliases?.length > 0 && <p className="mt-1 text-[11px] text-muted">aka {e.aliases.join(", ")}</p>}
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2"><X className="size-4" /></button>
      </div>

      <div className="space-y-5 p-4">
        {attrs.length > 0 && (
          <Section title="Current state">
            <div className="space-y-2">
              {attrs.map(([k, a]) => (
                <div key={k} className={cx("rounded-lg border p-2.5", a.status === "conflict" ? "border-warning/50 bg-warning-soft" : "border-line")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs capitalize text-muted">{k}</span>
                    <StatusBadge status={a.status === "conflict" ? "conflict" : "current"} />
                  </div>
                  <div className="mt-0.5 text-sm font-semibold text-ink">{fmtValue(k, a.value)}</div>
                  <div className="mt-0.5 text-[11px] text-ink-2">
                    {a.status === "conflict" ? (
                      <Link to="/graph?tab=conflicts" className="text-warning-ink underline decoration-dotted">{a.alternatives} conflicting value{a.alternatives > 1 ? "s" : ""} — proposed, awaiting review →</Link>
                    ) : a.reviewed_by ? `Confirmed by ${a.reviewed_by} · ${date(a.reviewed_at)}` : `${a.sources ?? 1} agreeing source${(a.sources ?? 1) > 1 ? "s" : ""}`}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {rels.length > 0 && (
          <Section title={`Relationships (${rels.length})`}>
            <ul className="space-y-1">
              {rels.map((r: any) => (
                <li key={r.type + r.id} className="flex items-center gap-2 text-sm">
                  <span className="w-24 shrink-0 truncate text-[11px] text-muted">{r.dir === "out" ? "" : "← "}{r.type.replace(/_/g, " ")}{r.dir === "out" ? " →" : ""}</span>
                  <Link to={`/graph/${r.id}`} className="min-w-0"><EntityBadge type={r.entityType} name={r.name} /></Link>
                  {r.evidence > 1 && <span className="text-[11px] text-muted">×{r.evidence}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {e.claims.length > 0 && (
          <Section title="Claims & provenance">
            <div className="space-y-2">
              {e.claims.map((c: any) => (
                <div key={c.id} className="rounded-lg border border-line p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm"><span className="capitalize text-muted">{c.predicate}:</span> <span className="font-medium text-ink">{fmtValue(c.predicate, c.value)}</span></span>
                    <StatusBadge status={c.status} />
                  </div>
                  <p className="mt-1 flex gap-1.5 text-xs italic text-ink-2"><Quote className="mt-0.5 size-3 shrink-0 text-muted" />{c.snippet}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                    <SourceBadge kind={c.source_kind} />
                    <Link to={`/lake/${c.doc_id}`} className="truncate text-accent hover:underline">{c.doc_title}</Link>
                    <span>{date(c.observed_at)}</span>
                    {c.speaker && <span>by {c.speaker}</span>}
                    <span>authority {Number(c.authority).toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section title={`Evidence (${e.evidence.length} source${e.evidence.length === 1 ? "" : "s"})`}>
          <ul className="space-y-1.5">
            {e.evidence.slice(0, 12).map((m: any) => (
              <li key={m.doc_id}>
                <Link to={`/lake/${m.doc_id}`} className="group block rounded-lg border border-line p-2 hover:border-accent">
                  <div className="flex items-center gap-2 text-xs"><FileText className="size-3.5 text-muted" /><span className="min-w-0 flex-1 truncate font-medium text-ink group-hover:text-accent">{m.title}</span><span className="shrink-0 text-muted">{date(m.occurred_at)}</span></div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-ink-2">{m.snippet}</div>
                </Link>
              </li>
            ))}
            {e.evidence.length === 0 && <li className="text-xs text-muted">Seeded entity — no document evidence you can access.</li>}
          </ul>
        </Section>

        {e.history.length > 0 && (
          <Section title="Update history">
            <ol className="relative space-y-3 border-l border-line pl-4">
              {e.history.map((h: any) => (
                <li key={h.id} className="relative">
                  <span className="absolute -left-[21px] top-1 size-2.5 rounded-full border-2 border-surface bg-line-strong" />
                  <div className="text-xs text-ink">
                    {h.field === "created" ? "Discovered" : <><span className="capitalize text-muted">{h.field}</span>{h.old_value ? <> {fmtValue(h.field, h.old_value)} →</> : ""} <span className="font-medium">{fmtValue(h.field, h.new_value)}</span></>}
                  </div>
                  <div className="text-[11px] text-muted">{h.note}{h.doc_title ? ` · ${h.doc_title}` : ""}</div>
                  <div className="flex items-center gap-1 text-[10px] text-muted"><Clock className="size-2.5" />{dateTime(h.at)} · {h.actor}</div>
                </li>
              ))}
            </ol>
          </Section>
        )}
      </div>
    </Card>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section>
    <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h4>
    {children}
  </section>
);

// ======================= Conflicts =======================
function Conflicts({ conflicts, reload }: { conflicts: any[] | null; reload: () => void }) {
  if (!conflicts) return <Spinner />;
  const open = conflicts.filter((c) => c.status === "open");
  const done = conflicts.filter((c) => c.status !== "open");
  return (
    <div className="space-y-4">
      <Callout icon={<Scale className="size-4 text-accent" />}>
        When sources disagree about a single-valued fact (deadline, owner, status, budget), ContextLoop keeps <b>every</b> claim with its evidence and proposes the authoritative value using source authority, recency and explicitness. A human confirms; nothing is silently overwritten.
      </Callout>
      {open.length === 0 && <Card><Empty title="No open conflicts" icon={<CheckCircle2 className="size-6" />}>Import <code className="font-mono text-xs">sample-data/demo/1-alpha-planning…</code> and <code className="font-mono text-xs">2-alpha-sprint-review…</code> to see deadline conflict detection live.</Empty></Card>}
      {open.map((c) => <ConflictCard key={c.id} c={c} reload={reload} />)}
      {done.length > 0 && (
        <>
          <h3 className="pt-2 text-sm font-semibold text-ink">Resolved</h3>
          {done.map((c) => <ConflictCard key={c.id} c={c} reload={reload} />)}
        </>
      )}
    </div>
  );
}

function ConflictCard({ c, reload }: { c: any; reload: () => void }) {
  const [note, setNote] = useState("");
  const resolve = useAction(async (claimId: string) => { await post(`/conflicts/${c.id}/resolve`, { claimId, note: note || undefined }); reload(); });
  const scoreOf = (id: string) => c.scores?.find((s: any) => s.claim_id === id);
  const isOpen = c.status === "open";
  const claims = [...c.claims].sort((a: any, b: any) => (scoreOf(b.id)?.score ?? 0) - (scoreOf(a.id)?.score ?? 0));
  return (
    <Card>
      <CardTitle
        sub={<>Detected {dateTime(c.created_at)}{c.resolved_by && <> · resolved by <b className="text-ink-2">{c.resolved_by}</b> {dateTime(c.resolved_at)}</>}</>}
        right={<StatusBadge status={c.status} />}
      >
        <Link to={`/graph/${c.entity_id}`} className="hover:text-accent">{c.entity_name}</Link> <span className="font-normal text-muted">→</span> <span className="capitalize">{c.predicate}</span>
      </CardTitle>

      <div className="grid gap-3 md:grid-cols-2">
        {claims.map((cl: any) => {
          const s = scoreOf(cl.id);
          const proposed = cl.id === c.proposed_claim_id;
          const chosen = cl.id === c.resolved_claim_id;
          return (
            <div key={cl.id} className={cx("relative flex flex-col rounded-lg border p-3.5", (isOpen ? proposed : chosen) ? "border-accent bg-accent-soft/40 ring-1 ring-accent/30" : "border-line")}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-lg font-semibold tabular text-ink">{fmtValue(c.predicate, cl.value)}</span>
                {isOpen && proposed && <Badge tone="accent">Proposed</Badge>}
                {!isOpen && <StatusBadge status={cl.status} />}
              </div>
              <p className="mb-2 flex gap-1.5 text-xs italic text-ink-2"><Quote className="mt-0.5 size-3 shrink-0 text-muted" />{cl.snippet}</p>
              <div className="mb-2 space-y-0.5 text-[11px] text-ink-2">
                <div className="flex items-center gap-2"><SourceBadge kind={cl.source_kind} /> <Link to={`/lake/${cl.doc_id}`} className="truncate text-accent hover:underline">{cl.doc_title}</Link></div>
                <div className="text-muted">{date(cl.doc_date ?? cl.observed_at)}{cl.speaker ? ` · stated by ${cl.speaker}` : ""}</div>
              </div>
              {s && (
                <div className="mb-3 grid grid-cols-4 gap-1 rounded-md bg-surface-2 p-2 text-center text-[10px] text-muted">
                  <Score label="Authority" v={s.authority} />
                  <Score label="Recency" v={s.recency} />
                  <Score label="Explicit" v={s.explicitness} />
                  <Score label="Score" v={s.score} strong />
                </div>
              )}
              {isOpen && (
                <Button className="mt-auto" size="sm" variant={proposed ? "primary" : "secondary"} busy={resolve.busy} icon={<CheckCircle2 className="size-3.5" />} onClick={() => resolve.run(cl.id)}>
                  {proposed ? "Approve proposed value" : "Accept this value instead"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-2"><b className="text-ink">Rationale:</b> {c.rationale}</p>
      {isOpen && (
        <div className="mt-3 flex items-center gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional reviewer note…" className="flex-1" />
        </div>
      )}
      <div className="mt-2"><ErrorBox error={resolve.error} /></div>
    </Card>
  );
}

const Score = ({ label, v, strong }: { label: string; v: number; strong?: boolean }) => (
  <div>
    <div className={cx("tabular text-xs", strong ? "font-semibold text-ink" : "text-ink-2")}>{Number(v).toFixed(2)}</div>
    <div>{label}</div>
  </div>
);

// ======================= Authority =======================
function Authority() {
  const { data, error, loading, setData } = useApi<any[]>("/authority");
  const save = useAction(async () => { await put("/authority", data!.map((r) => ({ source_kind: r.source_kind, weight: r.weight }))); return true; });
  const [saved, setSaved] = useState(false);
  if (loading && !data) return <Spinner />;
  return (
    <Card className="max-w-3xl">
      <CardTitle sub="How much each source type is trusted when facts conflict. Combined with recency (40%) and explicit change language (20%) into the resolution score.">Source authority</CardTitle>
      <ErrorBox error={error} />
      <div className="space-y-4">
        {data?.map((r, i) => (
          <div key={r.source_kind} className="grid grid-cols-[150px_1fr_48px] items-center gap-4">
            <div>
              <SourceBadge kind={r.source_kind} />
              <div className="mt-0.5 text-[11px] text-muted">{r.note}</div>
            </div>
            <input type="range" min={0} max={1} step={0.05} value={r.weight} onChange={(e) => { const d = [...data]; d[i] = { ...r, weight: +e.target.value }; setData(d); setSaved(false); }} className="w-full" style={{ accentColor: SOURCE_META[r.source_kind]?.color ? cssColor(SOURCE_META[r.source_kind].color) : undefined }} />
            <span className="tabular text-right text-sm font-medium text-ink">{Number(r.weight).toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Button variant="primary" busy={save.busy} onClick={async () => { if (await save.run()) setSaved(true); }}>Save weights</Button>
        {saved && !save.error && <span className="inline-flex items-center gap-1 text-xs text-good-ink"><CheckCircle2 className="size-3.5" />Saved — applies to new claims</span>}
      </div>
      <div className="mt-3"><ErrorBox error={save.error} /></div>
    </Card>
  );
}
