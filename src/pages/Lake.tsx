import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Copy, Download, Eye, Globe, Lock, Search as SearchIcon, Users } from "lucide-react";
import { getUserId, useApi } from "../lib/api";
import { SOURCE_META, SOURCE_ORDER, bytes, date, dateTime } from "../lib/format";
import { Badge, Button, Card, CodeBlock, Drawer, EntityBadge, ErrorBox, Input, KV, PageHeader, Select, SourceBadge, Spinner, Table, Tabs, Td, Empty } from "../components/ui";

export function VisibilityBadge({ v, team }: { v: string; team?: string | null }) {
  if (v === "private") return <Badge tone="critical"><Lock className="size-3" />Private</Badge>;
  if (v === "team") return <Badge tone="accent"><Users className="size-3" />Team{team ? ` · ${team.replace(/^t_/, "")}` : ""}</Badge>;
  return <Badge><Globe className="size-3" />Org</Badge>;
}

export default function Lake() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const source = params.get("source") ?? "";
  const project = params.get("project") ?? "";
  const [q, setQ] = useState("");
  const { data: docs, error, loading } = useApi<any[]>("/documents");
  const { data: team } = useApi<any>("/team");

  const rows = useMemo(
    () => (docs ?? []).filter((d) => (!source || d.source_kind === source) && (!project || d.project_id === project) && (!q || d.title.toLowerCase().includes(q.toLowerCase()) || (d.filename ?? "").toLowerCase().includes(q.toLowerCase()))),
    [docs, source, project, q],
  );
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }); };
  const totalBytes = rows.reduce((a, d) => a + (d.size_bytes ?? 0), 0);

  return (
    <div>
      <PageHeader title="Data lake" subtitle="Raw sessions, documents and traces exactly as captured. Each record keeps its byte-exact original, a normalized view used for indexing, and auto-extracted metadata." />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title or file…" className="w-64 pl-8" />
          </div>
          <Select value={source} onChange={(e) => setParam("source", e.target.value)}>
            <option value="">All sources</option>
            {SOURCE_ORDER.map((k) => <option key={k} value={k}>{SOURCE_META[k].label}</option>)}
          </Select>
          <Select value={project} onChange={(e) => setParam("project", e.target.value)}>
            <option value="">All projects</option>
            {team?.projects?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <div className="ml-auto text-xs text-muted tabular">{rows.length} records · {bytes(totalBytes)} raw</div>
        </div>
        {loading && !docs ? <Spinner /> : error ? <div className="p-4"><ErrorBox error={error} /></div> : rows.length === 0 ? (
          <Empty title="No records match">Only records you have access to are shown.</Empty>
        ) : (
          <Table head={["Title", "Source", "Project", "Visibility", "Owner", "Occurred", "Chunks", "Size"]}>
            {rows.map((d) => (
              <tr key={d.id} onClick={() => nav(`/lake/${d.id}${params.toString() ? `?${params}` : ""}`)} className="cursor-pointer hover:bg-surface-2/60">
                <Td className="max-w-[380px]">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink">{d.title}</span>
                    {d.duplicate_of && <Badge><Copy className="size-3" />Duplicate</Badge>}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted">{d.filename}</div>
                </Td>
                <Td><SourceBadge kind={d.source_kind} /></Td>
                <Td className="whitespace-nowrap text-ink-2">{d.project_name ?? <span className="text-muted">—</span>}</Td>
                <Td><VisibilityBadge v={d.visibility} team={d.team_id} /></Td>
                <Td className="whitespace-nowrap text-ink-2">{d.owner_name}</Td>
                <Td className="whitespace-nowrap text-ink-2">{date(d.occurred_at)}</Td>
                <Td className="tabular text-ink-2">{d.chunks}</Td>
                <Td className="tabular whitespace-nowrap text-ink-2">{bytes(d.size_bytes)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {id && <DocDrawer id={id} onClose={() => nav(`/lake${params.toString() ? `?${params}` : ""}`)} />}
    </div>
  );
}

function DocDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: d, error, loading } = useApi<any>(`/documents/${id}`);
  const [tab, setTab] = useState<"overview" | "chunks" | "raw" | "entities">("overview");
  const [dl, setDl] = useState<string | null>(null);

  const download = async () => {
    setDl(null);
    try {
      const res = await fetch(`/api/documents/${id}/raw`, { headers: { "x-user-id": getUserId() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Download failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = d?.filename ?? "raw";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e: any) {
      setDl(e.message);
    }
  };

  const meta = d?.metadata ?? {};
  return (
    <Drawer open onClose={onClose} width={760} title={d ? <span className="flex items-center gap-2"><SourceBadge kind={d.source_kind} /><span className="truncate">{d.title}</span></span> : "Record"}>
      {loading && !d ? <Spinner /> : error ? <ErrorBox error={error} /> : d && (
        <>
          {d.duplicate && (
            <div className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
              Exact or near-duplicate of <Link to={`/lake/${d.duplicate.id}`} className="font-medium text-accent hover:underline">{d.duplicate.title}</Link> — stored for provenance, not re-indexed.
            </div>
          )}
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "chunks", label: "Normalized", count: d.chunks.length },
              { id: "raw", label: "Raw" },
              { id: "entities", label: "Entities", count: d.entities.length },
            ]}
          />
          {tab === "overview" && (
            <div className="space-y-5">
              <KV
                items={[
                  ["Source", <SourceBadge kind={d.source_kind} />],
                  ["File", <span className="font-mono text-xs">{d.filename}</span>],
                  ["Detected format", meta.detected_format ?? d.mime],
                  ["Occurred", dateTime(d.occurred_at)],
                  ["Ingested", dateTime(d.ingested_at)],
                  ["Owner", d.owner_name],
                  ["Project", d.project_name],
                  ["Visibility", <VisibilityBadge v={d.visibility} team={d.team_name} />],
                  ["Size", bytes(d.size_bytes)],
                  ["Content hash", <span className="font-mono text-[11px] text-ink-2">{d.content_hash?.slice(0, 24)}…</span>],
                  ["Raw object", <span className="font-mono text-[11px] text-ink-2">lake/{d.raw_path}</span>],
                ]}
              />
              <div className="flex gap-2">
                <Button size="sm" icon={<Download className="size-3.5" />} onClick={download}>Download raw file</Button>
                <Button size="sm" variant="ghost" icon={<Eye className="size-3.5" />} onClick={() => setTab("raw")}>View raw</Button>
              </div>
              <ErrorBox error={dl} />
              <div>
                <div className="mb-1.5 text-xs font-medium text-ink-2">Auto-extracted metadata</div>
                <CodeBlock code={JSON.stringify(meta, null, 2)} lang="json" maxHeight={320} />
              </div>
            </div>
          )}
          {tab === "chunks" && (
            <div className="space-y-2">
              <p className="text-xs text-muted">Speaker-attributed chunks used for retrieval and extraction.</p>
              {d.chunks.length === 0 && <Empty title="No chunks">Duplicates are not chunked or indexed.</Empty>}
              {d.chunks.map((c: any) => (
                <div key={c.id} className="rounded-lg border border-line p-3">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                    <span className="font-mono">#{c.idx}</span>
                    {c.speaker && <Badge>{c.speaker}</Badge>}
                  </div>
                  <div className="whitespace-pre-wrap text-sm text-ink">{c.text}</div>
                </div>
              ))}
            </div>
          )}
          {tab === "raw" && (
            <div>
              <p className="mb-2 text-xs text-muted">Byte-exact original as captured (preview up to 200 KB).</p>
              <CodeBlock code={d.raw || "(raw object unavailable)"} lang={d.filename?.split(".").pop()} maxHeight={640} />
            </div>
          )}
          {tab === "entities" && (
            <div className="flex flex-wrap gap-1.5">
              {d.entities.length === 0 && <Empty title="No entities extracted" />}
              {d.entities.map((e: any) => (
                <Link key={e.id} to={`/graph/${e.id}`} className="rounded-md hover:ring-1 hover:ring-accent"><EntityBadge type={e.type} name={e.name} /></Link>
              ))}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
