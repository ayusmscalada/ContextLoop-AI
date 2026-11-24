import { useEffect, useState } from "react";
import { AlertTriangle, Cpu, Database, FolderSync, Plus, RotateCcw, Save, Trash2, WifiOff } from "lucide-react";
import { post, put, useAction, useApi } from "../lib/api";
import { dateTime, num } from "../lib/format";
import { Badge, Button, Callout, Card, CardTitle, ErrorBox, Input, KV, Modal, PageHeader, Select, Spinner, Toggle } from "../components/ui";

export default function Settings() {
  const { data, error, reload } = useApi<any>("/settings");
  const [targets, setTargets] = useState<{ harness: string; dir: string }[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetDone, setResetDone] = useState<any>(null);
  useEffect(() => { if (data) setTargets(data.syncTargets.map((t: any) => ({ ...t }))); }, [data]);

  const save = useAction(async (body: any, msg: string) => { await put("/settings", body); setSaved(msg); setTimeout(() => setSaved(null), 2500); reload(); });
  const reset = useAction(async () => { const r = await post("/admin/reset"); setResetDone(r.counts); setResetOpen(false); reload(); });

  if (!data) return <div><PageHeader title="Settings" /><ErrorBox error={error} />{!error && <Spinner />}</div>;
  const llm = data.llm;
  const idx = data.storage.index;

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Platform configuration for the AI engine, skill synchronization and storage." />
      <ErrorBox error={save.error || reset.error} />
      {saved && <Callout tone="good">{saved}</Callout>}
      {resetDone && <Callout tone="good">Demo data re-seeded: {resetDone.docs} documents, {resetDone.ents} entities, {resetDone.traces} traces.</Callout>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle sub="Used for extraction, answers, skill rewriting and skill→policy compilation" right={llm.enabled ? <Badge tone="good"><Cpu className="size-3" />Claude active</Badge> : <Badge><WifiOff className="size-3" />Offline engine</Badge>}>
            <span className="inline-flex items-center gap-1.5"><Cpu className="size-4 text-muted" />AI model</span>
          </CardTitle>
          <KV items={[
            ["Model", <code className="text-xs">{llm.model}</code>],
            ["API credentials", llm.configured ? <Badge tone="good">ANTHROPIC_API_KEY detected</Badge> : <Badge tone="warning"><AlertTriangle className="size-3" />Not configured</Badge>],
            ["Calls", `${num(llm.stats.calls)} (${num(llm.stats.failures)} failed)`],
            ["Tokens", `${num(llm.stats.inputTokens)} in · ${num(llm.stats.outputTokens)} out`],
            ["Last error", llm.lastError ? <span className="text-xs text-critical">{llm.lastError}</span> : "—"],
          ]} />
          <div className="mt-4 flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
            <Toggle checked={llm.toggle} onChange={(v) => save.run({ llmEnabled: v }, v ? "Claude enabled" : "Claude disabled — deterministic engine only")} label="Use Claude when credentials are available" />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Without <code className="rounded bg-code px-1">ANTHROPIC_API_KEY</code>, a deterministic engine runs everything offline: pattern + gazetteer extraction, extractive answers with citations, remediation-library skill rewrites and a rule-based skill→policy compiler. Every Claude call falls back to it automatically on error.
          </p>
        </Card>

        <Card>
          <CardTitle sub="Where approved skills are written after every approval or rollback"><span className="inline-flex items-center gap-1.5"><FolderSync className="size-4 text-muted" />Skill sync targets</span></CardTitle>
          <div className="space-y-2">
            {targets.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select value={t.harness} onChange={(e) => setTargets(targets.map((x, j) => (j === i ? { ...x, harness: e.target.value } : x)))} className="w-36 text-xs">
                  <option value="claude-code">claude-code</option><option value="codex">codex</option>
                </Select>
                <Input value={t.dir} onChange={(e) => setTargets(targets.map((x, j) => (j === i ? { ...x, dir: e.target.value } : x)))} className="flex-1 font-mono text-xs" />
                <button onClick={() => setTargets(targets.filter((_, j) => j !== i))} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-critical" aria-label="Remove target"><Trash2 className="size-4" /></button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setTargets([...targets, { harness: "claude-code", dir: "~/.claude/skills" }])}>Add target</Button>
            <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} busy={save.busy} onClick={() => save.run({ syncTargets: targets }, "Sync targets saved — applied on next approval or sync")}>Save targets</Button>
          </div>
          <p className="mt-3 text-xs text-muted">Relative paths resolve from the repo root; <code className="rounded bg-code px-1">~</code> expands to your home directory (e.g. <code className="rounded bg-code px-1">~/.claude/skills</code>, <code className="rounded bg-code px-1">~/.codex/skills</code>).</p>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle sub="Raw files are stored byte-exact and content-addressed; nothing is summarized away"><span className="inline-flex items-center gap-1.5"><Database className="size-4 text-muted" />Storage &amp; index</span></CardTitle>
          <KV items={[
            ["Data directory", <code className="text-xs">{data.storage.dataDir}</code>],
            ["Raw data lake", <code className="text-xs">{data.storage.lake}</code>],
            ["Database", <code className="text-xs">SQLite (node:sqlite, WAL)</code>],
            ["Indexed chunks", num(idx.chunks)],
            ["Indexed documents", num(idx.docs)],
            ["Vocabulary", `${num(idx.terms)} terms`],
            ["Index built", `${dateTime(idx.builtAt)} in ${idx.buildMs} ms`],
            ["Queries served", `${num(idx.queries)} · avg ${idx.queries ? (idx.totalQueryMs / idx.queries).toFixed(2) : "—"} ms`],
          ]} />
        </Card>

        <Card className="border-critical/30">
          <CardTitle sub="Restores the reproducible Northwind Labs demo organization"><span className="inline-flex items-center gap-1.5 text-critical"><RotateCcw className="size-4" />Reset demo data</span></CardTitle>
          <p className="text-sm text-ink-2">Deletes all documents, knowledge, traces, skills versions, proposals and audit history, then re-runs the seed (corpus through the real pipeline + real api-integration executions). Takes a few seconds. Admins only.</p>
          <Button className="mt-4" variant="danger" icon={<RotateCcw className="size-3.5" />} onClick={() => setResetOpen(true)}>Reset demo data…</Button>
        </Card>
      </div>

      <Modal open={resetOpen} onClose={() => setResetOpen(false)} title="Reset all demo data?" footer={<><Button onClick={() => setResetOpen(false)}>Cancel</Button><Button variant="danger" busy={reset.busy} onClick={() => reset.run()}>Yes, reset everything</Button></>}>
        <Callout tone="critical" icon={<AlertTriangle className="size-4 text-critical" />}>This permanently deletes everything imported, every approved skill version and the audit log, then re-seeds the demo organization.</Callout>
      </Modal>
    </div>
  );
}
