import { useState, type FormEvent } from "react";
import { Bot, CheckCircle2, FolderLock, KeyRound, Lock, Plus, ShieldCheck, ShieldX, User, Users, XCircle } from "lucide-react";
import { del, getUserId, post, put, useAction, useApi } from "../lib/api";
import { ago, SOURCE_META } from "../lib/format";
import { Badge, Button, Callout, Card, CardTitle, CodeBlock, cx, ErrorBox, Input, Modal, PageHeader, Select, Spinner, Table, Td } from "../components/ui";

const ALL_SCOPES = ["knowledge:read", "skills:read", "skills:propose", "traces:read", "traces:write", "data:write"];

export default function Team() {
  const { data, error, reload } = useApi<any>("/team");
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const me = getUserId();
  const action = useAction(async (fn: () => Promise<any>) => { await fn(); reload(); });

  if (!data) return <div><PageHeader title="Team & Permissions" /><ErrorBox error={error} />{!error && <Spinner />}</div>;
  const teamName = (id: string) => data.teams.find((t: any) => t.id === id)?.name ?? id;
  const projectName = (id: string) => data.projects.find((p: any) => p.id === id)?.name ?? id;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Team & Permissions"
        subtitle="Share organizational thinking without oversharing. Humans and their agents see only what policy allows — enforced at retrieval time for the UI, the CLI and MCP alike."
        actions={<Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreateOpen(true)}>New agent key</Button>}
      />
      <ErrorBox error={action.error} />

      <AccessSimulator />

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card pad={false}>
          <div className="p-5 pb-2"><CardTitle sub={data.canManage ? "As an admin you can change roles" : "Only admins can change roles"}><span className="inline-flex items-center gap-1.5"><Users className="size-4 text-muted" />Members</span></CardTitle></div>
          <Table head={["Member", "Role", "Teams"]}>
            {data.users.map((u: any) => (
              <tr key={u.id}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span className="grid size-7 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ background: u.color }}>{u.name.split(" ").map((x: string) => x[0]).join("")}</span>
                    <div><div className="text-sm text-ink">{u.name} {u.id === me && <Badge tone="accent">you</Badge>}</div><div className="text-[11px] text-muted">{u.title} · {u.email}</div></div>
                  </div>
                </Td>
                <Td>
                  {data.canManage && u.id !== me ? (
                    <Select value={u.role} className="h-8 text-xs capitalize" onChange={(e) => action.run(() => put(`/users/${u.id}/role`, { role: e.target.value }))}>
                      <option value="admin">admin</option><option value="member">member</option><option value="viewer">viewer</option>
                    </Select>
                  ) : <Badge tone={u.role === "admin" ? "accent" : "neutral"} className="capitalize">{u.role}</Badge>}
                </Td>
                <Td><div className="flex flex-wrap gap-1">{u.team_ids.map((t: string) => <Badge key={t}>{teamName(t)}</Badge>)}</div></Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardTitle><span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4 text-muted" />Policy model</span></CardTitle>
          <div className="space-y-3 text-xs leading-relaxed text-ink-2">
            <div className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink"><b>Effective access</b> = the human's access <b>∩</b> the agent key's policy</div>
            <div>
              <div className="mb-1 font-medium text-ink">Visibility (per document)</div>
              <ul className="space-y-0.5">
                <li><Badge>private</Badge> owner only — personal notes never leak to the team.</li>
                <li><Badge>team</Badge> members of one team (admins included).</li>
                <li><Badge>org</Badge> everyone in Northwind Labs.</li>
                <li><Badge tone="critical"><Lock className="size-3" />restricted project</Badge> only the owning team; agents need an explicitly elevated key.</li>
              </ul>
            </div>
            <div>
              <div className="mb-1 font-medium text-ink">Roles</div>
              <ul className="space-y-0.5">
                <li><b className="text-ink">Admin</b> — everything incl. approving skills, rollbacks, roles, settings.</li>
                <li><b className="text-ink">Member</b> — import data, resolve conflicts, propose and evaluate skills.</li>
                <li><b className="text-ink">Viewer</b> — read and ask only.</li>
              </ul>
            </div>
            <div><div className="mb-1 font-medium text-ink">Agent keys</div>scopes limit actions; <i>max visibility</i> caps what the agent can read; <i>allowed projects</i> narrows it further. Denials are written to the audit log.</div>
          </div>
        </Card>
      </div>

      <Card pad={false}>
        <div className="p-5 pb-2"><CardTitle sub="Credentials used by Claude Code, Codex, ChatGPT connectors and the CLI"><span className="inline-flex items-center gap-1.5"><KeyRound className="size-4 text-muted" />Agent access policies</span></CardTitle></div>
        <Table head={["Agent", "Acts for", "Scopes", "Max visibility", "Projects", "Last used", ""]}>
          {data.keys.map((k: any) => (
            <tr key={k.key} className={k.revoked ? "opacity-50" : ""}>
              <Td><div className="flex items-center gap-2"><Bot className="size-4 text-muted" /><div><div className="text-sm text-ink">{k.name}</div><code className="text-[11px] text-muted">{k.key}</code></div></div></Td>
              <Td className="text-xs">{k.user_name}</Td>
              <Td><div className="flex max-w-[300px] flex-wrap gap-1">{k.scopes.map((s: string) => <Badge key={s}>{s}</Badge>)}</div></Td>
              <Td><Badge tone={k.max_visibility === "private" ? "warning" : "neutral"}>{k.max_visibility}</Badge></Td>
              <Td className="text-xs">{k.allowed_projects ? k.allowed_projects.map(projectName).join(", ") : <span className="text-muted">all permitted</span>}</Td>
              <Td className="whitespace-nowrap text-xs text-muted">{k.last_used_at ? ago(k.last_used_at) : "never"}</Td>
              <Td>{k.revoked ? <Badge>revoked</Badge> : <Button size="sm" variant="danger" onClick={() => confirm(`Revoke ${k.name}? Agents using it will lose access immediately.`) && action.run(() => del(`/keys/${encodeURIComponent(k.key)}`))}>Revoke</Button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card pad={false}>
          <div className="p-5 pb-2"><CardTitle><span className="inline-flex items-center gap-1.5"><FolderLock className="size-4 text-muted" />Projects</span></CardTitle></div>
          <Table head={["Project", "Owning team", "Access"]}>
            {data.projects.map((p: any) => (
              <tr key={p.id}>
                <Td><div className="text-sm text-ink">{p.name}</div><div className="text-[11px] text-muted">{p.description}</div></Td>
                <Td className="text-xs">{p.team_name}</Td>
                <Td>{p.restricted ? <Badge tone="critical"><Lock className="size-3" />Restricted</Badge> : <Badge tone="good"><CheckCircle2 className="size-3" />Open to org</Badge>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card pad={false}>
          <div className="p-5 pb-2"><CardTitle><span className="inline-flex items-center gap-1.5"><Users className="size-4 text-muted" />Workspaces &amp; teams</span></CardTitle></div>
          <Table head={["Workspace", "Kind", "Scope"]}>
            {data.workspaces.map((w: any) => (
              <tr key={w.id}>
                <Td className="text-sm">{w.name}</Td>
                <Td><Badge tone={w.kind === "org" ? "accent" : "neutral"}>{w.kind}</Badge></Td>
                <Td className="text-xs text-ink-2">{w.kind === "team" ? `${data.teams.find((t: any) => t.id === w.team_id)?.members ?? 0} members` : w.kind === "personal" ? data.users.find((u: any) => u.id === w.owner_id)?.name : "everyone"}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <CreateKeyModal open={createOpen} onClose={() => setCreateOpen(false)} projects={data.projects} onCreated={(k) => { setNewKey(k); setCreateOpen(false); reload(); }} />
      <Modal open={!!newKey} onClose={() => setNewKey(null)} title="Agent key created" footer={<Button variant="primary" onClick={() => setNewKey(null)}>Done</Button>}>
        <Callout tone="warning">Copy it now — treat it like a password. Use it as <code>CONTEXTLOOP_API_KEY</code> for MCP or the CLI.</Callout>
        <div className="mt-3"><CodeBlock code={newKey ?? ""} /></div>
      </Modal>
    </div>
  );
}

function CreateKeyModal({ open, onClose, projects, onCreated }: { open: boolean; onClose: () => void; projects: any[]; onCreated: (k: string) => void }) {
  const [name, setName] = useState("Claude Code · my laptop");
  const [scopes, setScopes] = useState<string[]>(["knowledge:read", "skills:read", "traces:write"]);
  const [vis, setVis] = useState("team");
  const [projs, setProjs] = useState<string[]>([]);
  const create = useAction(async () => (await post("/keys", { name, scopes, maxVisibility: vis, allowedProjects: projs })).key as string);
  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const submit = async (e?: FormEvent) => { e?.preventDefault(); const k = await create.run(); if (k) onCreated(k); };
  return (
    <Modal open={open} onClose={onClose} title="New agent key" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={create.busy} onClick={() => submit()}>Create key</Button></>}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <label className="block"><div className="mb-1 text-xs font-medium text-ink-2">Name</div><Input value={name} onChange={(e) => setName(e.target.value)} className="w-full" /></label>
        <div>
          <div className="mb-1.5 text-xs font-medium text-ink-2">Scopes</div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_SCOPES.map((s) => (
              <button type="button" key={s} onClick={() => toggle(scopes, setScopes, s)} className={cx("rounded-md border px-2 py-1 text-xs", scopes.includes(s) ? "border-accent bg-accent-soft text-ink" : "border-line-strong text-ink-2")}>{s}</button>
            ))}
          </div>
        </div>
        <label className="block">
          <div className="mb-1 text-xs font-medium text-ink-2">Max visibility the agent may read</div>
          <Select value={vis} onChange={(e) => setVis(e.target.value)} className="w-full">
            <option value="org">org — only org-wide knowledge</option>
            <option value="team">team — org + my teams</option>
            <option value="private">private — everything I can see (elevated; includes restricted projects)</option>
          </Select>
        </label>
        <div>
          <div className="mb-1.5 text-xs font-medium text-ink-2">Allowed projects <span className="font-normal text-muted">(none selected = all I can access)</span></div>
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p) => (
              <button type="button" key={p.id} onClick={() => toggle(projs, setProjs, p.id)} className={cx("rounded-md border px-2 py-1 text-xs", projs.includes(p.id) ? "border-accent bg-accent-soft text-ink" : "border-line-strong text-ink-2")}>{p.name}</button>
            ))}
          </div>
        </div>
        <ErrorBox error={create.error} />
      </form>
    </Modal>
  );
}

function AccessSimulator() {
  const [q, setQ] = useState("Project Falcon acquisition price");
  const [res, setRes] = useState<any[] | null>(null);
  const sim = useAction(async (query: string) => setRes(await post("/permissions/simulate", { query })));
  return (
    <Card>
      <CardTitle sub="Runs the same retrieval as every human and every agent key, live — the restricted Falcon deal must only surface for leadership and elevated agents">
        <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4 text-accent" />Access simulator</span>
      </CardTitle>
      <form onSubmit={(e) => { e.preventDefault(); sim.run(q); }} className="mb-4 flex flex-wrap gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} className="min-w-64 flex-1" placeholder="Query to test" />
        {["Project Falcon acquisition price", "Ben moving teams", "Acme Retail holiday campaign"].map((s) => (
          <Button key={s} type="button" size="sm" variant="ghost" onClick={() => { setQ(s); sim.run(s); }}>{s}</Button>
        ))}
        <Button type="submit" variant="primary" busy={sim.busy}>Simulate</Button>
      </form>
      <ErrorBox error={sim.error} />
      {!res ? <div className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">Run a query to see who — and which agent — can retrieve it.</div> : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {res.map((r) => {
            const sensitive = /falcon|lumen|private|scratch/i;
            const leaks = r.hits?.filter((h: any) => sensitive.test(h.title)) ?? [];
            return (
              <div key={r.label} className={cx("rounded-lg border p-3", !r.allowed ? "border-line bg-surface-2/50" : leaks.length ? "border-warning/50 bg-warning-soft/40" : "border-line")}>
                <div className="flex items-center gap-2">
                  {r.kind === "agent" ? <Bot className="size-4 text-muted" /> : <User className="size-4 text-muted" />}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{r.label.replace(/^🤖\s*/, "")}</span>
                  {r.role && <Badge className="capitalize">{r.role}</Badge>}
                </div>
                {!r.allowed ? (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-critical"><ShieldX className="size-3.5" />Blocked — {r.reason}</div>
                ) : (
                  <>
                    <div className="mt-1 text-[11px] text-muted">{r.docs} documents visible</div>
                    <div className="mt-2 space-y-1">
                      {!r.hits.length && <div className="text-xs text-muted">No results.</div>}
                      {r.hits.slice(0, 3).map((h: any, i: number) => {
                        const s = sensitive.test(h.title);
                        return (
                          <div key={i} className="flex items-center gap-1.5 text-xs">
                            {s ? <Lock className="size-3 shrink-0 text-warning-ink" /> : <span className="size-2 shrink-0 rounded-full" style={{ background: SOURCE_META[h.sourceKind]?.color }} />}
                            <span className={cx("truncate", s ? "font-medium text-ink" : "text-ink-2")}>{h.title}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2 text-[11px]">
                      {leaks.length ? <span className="inline-flex items-center gap-1 text-warning-ink"><Lock className="size-3" />Sees restricted/private content (authorized)</span> : <span className="inline-flex items-center gap-1 text-good-ink"><CheckCircle2 className="size-3" />No restricted content returned</span>}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {res && <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted"><XCircle className="size-3" />Each simulation is recorded in the audit log.</div>}
    </Card>
  );
}
