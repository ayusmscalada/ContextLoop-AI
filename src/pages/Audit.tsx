import { useEffect, useState } from "react";
import { Bot, Download, RefreshCw, Search, Server, ShieldX, User } from "lucide-react";
import { useApi } from "../lib/api";
import { dateTime, num } from "../lib/format";
import { Button, Card, cx, Empty, ErrorBox, Input, PageHeader, Select, Spinner, Stat, StatusBadge, Table, Td } from "../components/ui";

const ACTOR_ICON: Record<string, any> = { user: User, agent: Bot, system: Server };

export default function Audit() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [outcome, setOutcome] = useState("");
  const [actorType, setActorType] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const qs = new URLSearchParams({ limit: "300", ...(debounced && { q: debounced }), ...(outcome && { outcome }), ...(actorType && { actorType }) });
  const { data, error, loading, reload } = useApi<any>(`/audit?${qs}`);
  const all = useApi<any>("/audit?limit=1");
  const denied = useApi<any>("/audit?limit=1&outcome=denied");
  const agents = useApi<any>("/audit?limit=1&actorType=agent");

  const exportCsv = () => {
    if (!data) return;
    const rows = [["at", "actor_type", "actor", "action", "resource", "detail", "outcome"], ...data.rows.map((r: any) => [r.at, r.actor_type, r.actor_name, r.action, r.resource, r.detail, r.outcome])];
    const csv = rows.map((r) => r.map((c: any) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "contextloop-audit.csv";
    a.click();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit Logs"
        subtitle="Every read, search, import, approval and policy denial — by humans and by the agents acting for them. Non-admins see only their own activity."
        actions={<><Button icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button><Button icon={<Download className="size-3.5" />} onClick={exportCsv} disabled={!data?.rows.length}>Export CSV</Button></>}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Events recorded" value={num(all.data?.total)} />
        <Stat label="Agent events" value={num(agents.data?.total)} icon={<Bot className="size-4" />} sub="MCP & CLI calls" />
        <Stat label="Denied by policy" value={num(denied.data?.total)} icon={<ShieldX className="size-4" />} tone={denied.data?.total ? "critical" : undefined} sub="blocked reads & actions" />
      </div>

      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
          <div className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actor, action, resource, detail…" className="w-full pl-9" />
          </div>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All outcomes</option><option value="allowed">Allowed</option><option value="denied">Denied</option>
          </Select>
          <Select value={actorType} onChange={(e) => setActorType(e.target.value)}>
            <option value="">All actors</option><option value="user">Humans</option><option value="agent">Agents</option><option value="system">System</option>
          </Select>
          {data && <span className="text-xs text-muted tabular">{data.rows.length} of {num(data.total)} shown</span>}
        </div>
        <ErrorBox error={error} />
        {loading && !data ? <Spinner /> : !data?.rows.length ? <Empty title="No matching events" /> : (
          <Table head={["Time", "Outcome", "Actor", "Action", "Resource", "Detail"]}>
            {data.rows.map((r: any) => {
              const Icon = ACTOR_ICON[r.actor_type] ?? User;
              return (
                <tr key={r.id} className={cx(r.outcome === "denied" && "bg-critical-soft/60")}>
                  <Td className="whitespace-nowrap text-xs text-muted tabular">{dateTime(r.at)}</Td>
                  <Td><StatusBadge status={r.outcome} /></Td>
                  <Td className="whitespace-nowrap"><span className="inline-flex items-center gap-1.5 text-xs text-ink"><Icon className="size-3.5 text-muted" />{r.actor_name}</span></Td>
                  <Td className="font-mono text-xs">{r.action}</Td>
                  <Td className="max-w-[260px] truncate text-xs text-ink-2" >{r.resource}</Td>
                  <Td className={cx("max-w-[420px] text-xs", r.outcome === "denied" ? "font-medium text-critical" : "text-ink-2")}>{r.detail}</Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
