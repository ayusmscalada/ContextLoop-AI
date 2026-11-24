import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Copy, FileUp, FolderSync, Loader2, Terminal, UploadCloud, X } from "lucide-react";
import { getUserId, useApi } from "../lib/api";
import { SOURCE_META, ago, bytes, dateTime } from "../lib/format";
import { Badge, Button, Callout, Card, CardTitle, ErrorBox, PageHeader, Select, SourceBadge, Spinner, StatusBadge, Table, Td, cx } from "../components/ui";

const ACCEPT = ".json,.jsonl,.ndjson,.txt,.md,.vtt,.pdf,.eml,.mbox";

export default function Sources() {
  const { data, error, loading, reload } = useApi<any>("/sources");
  const { data: team } = useApi<any>("/team");
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [opts, setOpts] = useState({ visibility: "org", teamId: "t_engineering", projectId: "", sourceHint: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<any[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    // Copy NOW: a FileList is live, and the input is reset right after this call, which empties it.
    const picked = Array.from(list);
    setFiles((f) => [...f, ...picked.filter((n) => !f.some((x) => x.name === n.name && x.size === n.size))]);
  };

  const upload = async () => {
    if (busy) return; // an import is already running
    if (!files.length) {
      input.current?.click(); // nothing selected yet: open the file picker
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      fd.append("visibility", opts.visibility);
      if (opts.visibility === "team") fd.append("teamId", opts.teamId);
      if (opts.projectId) fd.append("projectId", opts.projectId);
      if (opts.sourceHint) fd.append("sourceHint", opts.sourceHint);
      const res = await fetch("/api/import", { method: "POST", headers: { "x-user-id": getUserId() }, body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status})`);
      if (!Array.isArray(body.results)) throw new Error(`Unexpected response from the server (${res.status}). The files were not imported.`);
      setResults(body.results);
      setFiles([]);
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Data sources"
        subtitle="Cross-provider capture: raw data first, no lossy summarization. Every file is stored byte-exact in the lake, then parsed, deduplicated, chunked, and mined for knowledge."
      />

      <PersistenceWarning />

      {/* Connectors */}
      {loading && !data ? <Spinner /> : <ErrorBox error={error} />}
      {data && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.sources.map((s: any) => (
            <Card key={s.id} className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-9 place-items-center rounded-lg text-[11px] font-bold text-white" style={{ background: SOURCE_META[s.kind]?.color }}>{SOURCE_META[s.kind]?.short}</span>
                  <div>
                    <div className="text-sm font-semibold text-ink">{s.name}</div>
                    <div className="text-xs text-muted">{s.config?.method}</div>
                  </div>
                </div>
                <Badge tone="good"><CheckCircle2 className="size-3" />Connected</Badge>
              </div>
              <p className="text-xs text-ink-2">{s.description}</p>
              <div className="mt-auto flex items-center justify-between border-t border-line pt-2 text-xs">
                <Link to={`/lake?source=${s.kind}`} className="text-ink hover:text-accent"><span className="tabular font-semibold">{s.items}</span> <span className="text-muted">items in lake</span></Link>
                <span className="text-muted">synced {ago(s.last_sync_at)}</span>
              </div>
              {s.config?.path && <code className="truncate rounded bg-code px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{s.config.path}</code>}
            </Card>
          ))}
        </div>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-5">
        {/* Upload */}
        <Card className="lg:col-span-3">
          <CardTitle sub="ChatGPT exports, Claude Code / Codex session logs, agent traces, meeting transcripts, Gmail / Outlook email (.eml, .mbox), GitHub PR / push JSON, Markdown, TXT, PDF. Format is auto-detected.">Import data</CardTitle>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
            onClick={() => input.current?.click()}
            className={cx("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition", drag ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent hover:bg-surface-2")}
          >
            <UploadCloud className="size-7 text-muted" />
            <div className="text-sm font-medium text-ink">Drop files here or click to browse</div>
            <div className="text-xs text-muted">{ACCEPT.replace(/\./g, "").split(",").join(" · ")}</div>
            <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </div>

          {files.length > 0 && (
            <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
              {files.map((f) => (
                <li key={f.name + f.size} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <FileUp className="size-3.5 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-ink">{f.name}</span>
                  <span className="text-xs text-muted">{bytes(f.size)}</span>
                  <button onClick={() => setFiles(files.filter((x) => x !== f))} className="text-muted hover:text-critical" aria-label="Remove"><X className="size-3.5" /></button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Visibility">
              <Select value={opts.visibility} onChange={(e) => setOpts({ ...opts, visibility: e.target.value })} className="w-full">
                <option value="org">Organization</option>
                <option value="team">Team</option>
                <option value="private">Private (only me)</option>
              </Select>
            </Field>
            <Field label="Team">
              <Select value={opts.teamId} disabled={opts.visibility !== "team"} onChange={(e) => setOpts({ ...opts, teamId: e.target.value })} className="w-full">
                <option value="t_engineering">Engineering</option>
                <option value="t_sales">Sales</option>
                <option value="t_leadership">Leadership</option>
              </Select>
            </Field>
            <Field label="Project">
              <Select value={opts.projectId} onChange={(e) => setOpts({ ...opts, projectId: e.target.value })} className="w-full">
                <option value="">Auto-detect</option>
                {team?.projects?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Source type">
              <Select value={opts.sourceHint} onChange={(e) => setOpts({ ...opts, sourceHint: e.target.value })} className="w-full">
                <option value="">Auto-detect</option>
                <option value="chatgpt">ChatGPT</option>
                <option value="claude_code">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="meeting">Meeting</option>
                <option value="document">Document</option>
                <option value="email">Email (Gmail / Outlook)</option>
                <option value="github">GitHub</option>
              </Select>
            </Field>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" icon={busy ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />} onClick={upload}>
              {busy ? "Importing…" : files.length ? `Import ${files.length} file${files.length > 1 ? "s" : ""}` : "Choose files to import"}
            </Button>
            {busy && <span className="text-xs text-muted">Storing raw → parsing → deduplicating → extracting → indexing…</span>}
          </div>
          <div className="mt-3"><ErrorBox error={err} /></div>
        </Card>

        {/* How to */}
        <Card className="lg:col-span-2">
          <CardTitle>Other ways to capture</CardTitle>
          <div className="space-y-4 text-sm text-ink-2">
            <div>
              <div className="mb-1 flex items-center gap-1.5 font-medium text-ink"><FileUp className="size-4" />Sample files for the demo</div>
              <p className="text-xs">Ready-made exports live in <code className="rounded bg-code px-1 font-mono">sample-data/demo</code>: two Project Alpha meetings with conflicting deadlines, a Claude Code session, a ChatGPT export, a Codex rollout, agent traces, an Outlook email and a GitHub pull-request webhook payload.</p>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1.5 font-medium text-ink"><FolderSync className="size-4" />Background watcher daemon</div>
              <p className="mb-1.5 text-xs">Watches local session folders and streams new files in as they're written.</p>
              <CopyLine text="npm run cli -- watch ~/.claude/projects" />
              <CopyLine text="npm run cli -- watch ~/.codex/sessions" />
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1.5 font-medium text-ink"><Terminal className="size-4" />CLI one-off import</div>
              <CopyLine text="npm run cli -- import ./conversations.json" />
            </div>
          </div>
        </Card>
      </div>

      <LiveConnectors onSynced={(r) => { setResults(r); reload(); }} />

      {results && <ImportResults results={results} onClose={() => setResults(null)} />}

      {/* History */}
      <Card pad={false}>
        <div className="px-5 pt-5"><CardTitle sub="Every import with its processing stage and results">Import history</CardTitle></div>
        <Table head={["File", "Source", "Status", "Docs", "Dupes", "Chunks", "Entities", "Claims", "Conflicts", "By", "When"]}>
          {data?.imports?.map((i: any) => (
            <tr key={i.id} className="hover:bg-surface-2/50">
              <Td className="max-w-[260px]"><div className="truncate font-medium text-ink" title={i.filename}>{i.filename}</div>{i.error && <div className="truncate text-xs text-critical">{i.error}</div>}</Td>
              <Td>{i.source_kind ? i.source_kind.split(",").map((k: string) => <SourceBadge key={k} kind={k} className="mr-2" />) : "—"}</Td>
              <Td>{i.status === "processing" ? <span className="text-xs text-muted">{i.stage}</span> : <StatusBadge status={i.status} />}</Td>
              <Td className="tabular">{i.stats?.documents ?? "—"}</Td>
              <Td className="tabular">{i.stats?.duplicates || "—"}</Td>
              <Td className="tabular">{i.stats?.chunks ?? "—"}</Td>
              <Td className="tabular">{i.stats?.entities ?? "—"}</Td>
              <Td className="tabular">{i.stats?.claims ?? "—"}</Td>
              <Td>{i.stats?.conflicts?.length ? <Link to="/graph?tab=conflicts"><Badge tone="warning"><AlertTriangle className="size-3" />{i.stats.conflicts.length}</Badge></Link> : <span className="text-muted">—</span>}</Td>
              <Td className="whitespace-nowrap text-xs text-ink-2">{i.user_name}<div className="text-muted">{i.origin}</div></Td>
              <Td className="whitespace-nowrap text-xs text-muted">{dateTime(i.started_at)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function ImportResults({ results, onClose }: { results: any[]; onClose: () => void }) {
  return (
    <Card className="mb-6">
      <CardTitle sub="What the pipeline did with each file" right={<Button size="sm" variant="ghost" onClick={onClose} icon={<X className="size-3.5" />}>Dismiss</Button>}>Processing results</CardTitle>
      <div className="space-y-3">
        {results.map((r, i) =>
          r.error ? (
            <Callout key={i} tone="critical">{r.filename}: {r.error}</Callout>
          ) : (
            <div key={r.importId} className="rounded-lg border border-line p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                Detected format <Badge tone="accent">{r.detected}</Badge>
              </div>
              <div className="space-y-2">
                {r.documents.map((d: any) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <SourceBadge kind={d.sourceKind} />
                    <Link to={`/lake/${d.id}`} className="min-w-0 max-w-md truncate font-medium text-ink hover:text-accent">{d.title}</Link>
                    {d.duplicateOf ? (
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <StatusBadge status="duplicate" />
                        <span className="text-muted">{Math.round((d.similarity ?? 1) * 100)}% similar to</span>
                        <Link to={`/lake/${d.duplicateOf}`} className="text-accent hover:underline">original</Link>
                        <span className="text-muted">— not re-indexed</span>
                      </span>
                    ) : (
                      <span className="flex flex-wrap gap-1.5 text-xs">
                        <Badge>{d.chunks} chunks</Badge>
                        {d.extraction && <Badge>{d.extraction.entities} entities</Badge>}
                        {d.extraction && <Badge>{d.extraction.relations} relations</Badge>}
                        {d.extraction && <Badge>{d.extraction.claims} claims</Badge>}
                        {d.extraction?.conflicts?.length > 0 && (
                          <Link to="/graph?tab=conflicts"><Badge tone="warning"><AlertTriangle className="size-3" />{d.extraction.conflicts.length} conflict detected →</Badge></Link>
                        )}
                        {d.traces > 0 && <Badge tone="accent">{d.traces} traces recorded</Badge>}
                        {d.superseded > 0 && <Badge tone="accent">replaces previous version</Badge>}
                        {d.extraction?.llm && <Badge tone="accent">Claude extraction</Badge>}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
    </Card>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
    {children}
  </label>
);

function CopyLine({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1000); }} className="mb-1 flex w-full items-center gap-2 rounded-md bg-code px-2 py-1 text-left font-mono text-[11px] text-ink hover:bg-surface-2">
      <span className="text-muted">$</span>
      <span className="flex-1 truncate">{text}</span>
      {ok ? <CheckCircle2 className="size-3 text-good-ink" /> : <Copy className="size-3 text-muted" />}
    </button>
  );
}

/** GitHub repo sync + webhook endpoints for GitHub and inbound email. */
function LiveConnectors({ onSynced }: { onSynced: (results: any[]) => void }) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const sync = async () => {
    if (busy) return;
    if (!repo.trim()) {
      setErr("Enter a repository first, for example owner/repo or https://github.com/owner/repo");
      return;
    }
    setBusy(true);
    setErr(null);
    setSummary(null);
    try {
      const res = await fetch("/api/sources/github/sync", { method: "POST", headers: { "content-type": "application/json", "x-user-id": getUserId() }, body: JSON.stringify({ repo, limit: 10 }) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? "Sync failed");
      setSummary(`Synced ${r.repo}: ${r.pullRequests} pull requests and ${r.commits} commits${r.rateRemaining ? ` (GitHub API calls left: ${r.rateRemaining})` : ""}.`);
      onSynced(r.results);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2">
      <Card>
        <CardTitle sub="Pull requests, reviews, comments and pushes. Later events (synchronize, merged) supersede the earlier version of a PR.">GitHub</CardTitle>
        <div className="text-xs font-medium text-ink">Sync a repository now</div>
        <div className="mt-1.5 flex gap-2">
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && repo && sync()}
            placeholder="owner/repo or https://github.com/owner/repo"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
          />
          <Button variant="primary" icon={busy ? <Loader2 className="size-4 animate-spin" /> : undefined} onClick={sync}>{busy ? "Syncing…" : "Sync"}</Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted">Public repos work without a token. Set <code className="font-mono">GITHUB_TOKEN</code> on the server for private repos and higher rate limits.</p>
        {summary && <div className="mt-2"><Callout tone="good" icon={<CheckCircle2 className="size-4 text-good-ink" />}>{summary}</Callout></div>}
        <div className="mt-2"><ErrorBox error={err} /></div>
        <div className="mt-4 text-xs font-medium text-ink">Live webhook (Repo → Settings → Webhooks)</div>
        <p className="mb-1.5 text-[11px] text-muted">
          Content type <code className="font-mono">application/json</code>; events: pushes, pull requests, pull request reviews, issue comments. Set the same secret as <code className="font-mono">GITHUB_WEBHOOK_SECRET</code> so payloads are signature-verified.
        </p>
        <CopyLine text={`${origin}/api/webhooks/github?project=prj_alpha`} />
      </Card>
      <Card>
        <CardTitle sub="Threads are reassembled from replies, quoted history is stripped, and senders and recipients become people in the ontology.">Gmail & Outlook</CardTitle>
        <div className="space-y-3 text-xs text-ink-2">
          <div>
            <div className="font-medium text-ink">Import exports</div>
            <p>
              Gmail: <span className="text-ink">Google Takeout → Mail</span> gives an <code className="font-mono">.mbox</code>; a single message is <span className="text-ink">⋮ → Download message</span> (.eml). Outlook: drag a message to the desktop or{" "}
              <span className="text-ink">File → Save as</span> (.eml). Drop the files in the importer above.
            </p>
          </div>
          <div>
            <div className="font-medium text-ink">Forward mail continuously</div>
            <p className="mb-1.5">
              Point a forwarding rule or an inbound-mail service (Cloudflare Email Workers, SendGrid Inbound Parse, Mailgun routes) at this endpoint. It accepts raw RFC 822 messages. Protect it with <code className="font-mono">EMAIL_INGEST_TOKEN</code>.
            </p>
            <CopyLine text={`${origin}/api/webhooks/email?token=<EMAIL_INGEST_TOKEN>&owner=u_carol&visibility=team&team=t_sales`} />
          </div>
          <p className="text-[11px] text-muted">Direct Gmail / Microsoft Graph sync needs an OAuth app registered with Google or Microsoft; the export and forwarding paths work without one.</p>
        </div>
      </Card>
    </div>
  );
}

/** On Vercel, data only survives across instances when a Blob store is connected. Say so plainly. */
function PersistenceWarning() {
  const { data: me } = useApi<any>("/me");
  const p = me?.persistence;
  if (!p) return null;
  if (p.onVercel && p.backend === "off") {
    return (
      <div className="mb-5">
        <Callout tone="warning" icon={<AlertTriangle className="size-4 text-warning-ink" />}>
          <div className="font-medium">Imports are not being saved: this deployment has no Vercel Blob token.</div>
          <div className="mt-0.5 text-ink-2">
            Vercel adds <code className="font-mono">BLOB_READ_WRITE_TOKEN</code> when a Blob store is connected, but only to <b>new</b> deployments. Connect the store (Storage → your Blob store → Connect Project), then redeploy.
          </div>
        </Callout>
      </div>
    );
  }
  if (p.lastError) {
    return (
      <div className="mb-5">
        <Callout tone="critical" icon={<AlertTriangle className="size-4 text-critical" />}>
          <div className="font-medium">Saving to storage failed</div>
          <div className="mt-0.5 font-mono text-xs text-ink-2">{p.lastError}</div>
        </Callout>
      </div>
    );
  }
  return null;
}
