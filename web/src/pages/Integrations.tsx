import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Cable, FolderSync, KeyRound, ShieldCheck, Terminal, Wrench } from "lucide-react";
import { useApi } from "../lib/api";
import { ago } from "../lib/format";
import { Badge, Callout, Card, CardTitle, CodeBlock, Empty, PageHeader, Select, Spinner, StatusBadge, Table, Tabs, Td } from "../components/ui";

const TOOLS: { name: string; sig: string; desc: string; scope: string }[] = [
  { name: "ask_organization", sig: "(question, project?)", desc: "Evidence-backed answer from organizational memory with numbered citations.", scope: "knowledge:read" },
  { name: "search_knowledge", sig: "(query, project?, sources?, limit?)", desc: "Hybrid keyword + semantic search over every captured source.", scope: "knowledge:read" },
  { name: "get_project_context", sig: "(project_id)", desc: "Authoritative project state: owner, deadline, status, open conflicts, decisions, people, issues, technologies.", scope: "knowledge:read" },
  { name: "get_entity_details", sig: "(entity)", desc: "A person, project, customer, technology, issue or decision with relations, claims, conflicts and history.", scope: "knowledge:read" },
  { name: "list_skills", sig: "()", desc: "The team's shared, versioned skills with live success rates.", scope: "skills:read" },
  { name: "get_skill", sig: "(skill_name)", desc: "The active, human-approved version of a skill (SKILL.md) to follow.", scope: "skills:read" },
  { name: "report_agent_execution", sig: "(agent, task, status, skill?, …)", desc: "Report the outcome of a task so skills are measured and failures mined.", scope: "traces:write" },
  { name: "propose_skill_improvement", sig: "(skill_id)", desc: "Ask ContextLoop to draft a reviewable improvement from recent failures.", scope: "skills:propose" },
  { name: "whoami", sig: "()", desc: "Which user and access policy this agent is acting under.", scope: "—" },
];

export default function Integrations() {
  const team = useApi<any>("/team");
  const skills = useApi<any>("/skills");
  const activity = useApi<any>("/audit?actorType=agent&limit=25");
  const keys = (team.data?.keys ?? []).filter((k: any) => !k.revoked);
  const [keySel, setKeySel] = useState("");
  const key = keys.find((k: any) => k.key === keySel) ?? keys[0];
  const [harness, setHarness] = useState<"claude" | "codex" | "json">("claude");

  // Derive the repo root from a sync target (…/sync/<harness>/…) so snippets are copy-paste ready.
  const repo = useMemo(() => {
    const dir: string | undefined = skills.data?.targets?.[0]?.dir;
    const i = dir ? dir.replace(/\\/g, "/").lastIndexOf("/sync/") : -1;
    return i > 0 ? dir!.replace(/\\/g, "/").slice(0, i) : "<path-to-contextloop>";
  }, [skills.data]);
  const k = key?.key ?? "<agent-key>";
  const url = "http://localhost:8787";
  const mcpPath = `${repo}/server/src/mcp.ts`;

  const snippets = {
    claude: `# Register ContextLoop with Claude Code (user scope)\nclaude mcp add contextloop \\\n  --env CONTEXTLOOP_API_KEY=${k} \\\n  --env CONTEXTLOOP_URL=${url} \\\n  -- npx tsx "${mcpPath}"\n\n# Then, inside Claude Code:\n#   > Why did the Project Alpha payment integration fail? Check ContextLoop.\n#   > Use the api-integration skill from ContextLoop to add a PayFlow refund call.`,
    json: JSON.stringify({ mcpServers: { contextloop: { command: "npx", args: ["tsx", mcpPath], env: { CONTEXTLOOP_API_KEY: k, CONTEXTLOOP_URL: url } } } }, null, 2),
    codex: `# ~/.codex/config.toml\n[mcp_servers.contextloop]\ncommand = "npx"\nargs = ["tsx", "${mcpPath}"]\nenv = { CONTEXTLOOP_API_KEY = "${k}", CONTEXTLOOP_URL = "${url}" }`,
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Integrations"
        subtitle="ContextLoop is not another standalone app: any MCP-capable agent (Claude Code, Codex, Cursor…) can query organizational memory, pull approved skills and report executions back — under the same permissions as its human."
      />

      <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardTitle sub="stdio MCP server · server/src/mcp.ts" right={<Badge tone="good"><ShieldCheck className="size-3" />Permission-enforced</Badge>}>
            <span className="inline-flex items-center gap-1.5"><Cable className="size-4 text-muted" />Connect an agent over MCP</span>
          </CardTitle>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <KeyRound className="size-4 text-muted" />
            <span className="text-ink-2">Agent key</span>
            {team.loading && !team.data ? <span className="text-xs text-muted">loading…</span> : (
              <Select value={key?.key ?? ""} onChange={(e) => setKeySel(e.target.value)} className="h-8 min-w-60 text-xs">
                {keys.map((x: any) => <option key={x.key} value={x.key}>{x.name} — {x.user_name}</option>)}
              </Select>
            )}
            {key && <span className="text-xs text-muted">scopes: {key.scopes.join(", ")} · max visibility <b className="text-ink">{key.max_visibility}</b></span>}
          </div>
          {!keys.length && team.data && <Callout tone="warning">You have no agent keys yet — create one in <Link className="text-accent underline" to="/team">Team &amp; Permissions</Link>.</Callout>}
          <Tabs tabs={[{ id: "claude", label: "Claude Code" }, { id: "json", label: ".mcp.json" }, { id: "codex", label: "Codex" }]} value={harness} onChange={setHarness} />
          <CodeBlock lang={harness === "codex" ? "toml" : harness === "json" ? "json" : "bash"} code={snippets[harness]} />
          <p className="mt-3 text-xs text-muted">
            Verify end-to-end without a harness: <code className="rounded bg-code px-1">npm run mcp:smoke</code> spawns the MCP server over stdio exactly like Claude Code does, lists tools and calls them under two different agent keys to show permission enforcement.
          </p>
        </Card>

        <Card pad={false}>
          <div className="p-5 pb-2"><CardTitle sub="Exposed to every connected agent"><span className="inline-flex items-center gap-1.5"><Wrench className="size-4 text-muted" />MCP tools</span></CardTitle></div>
          <div className="divide-y divide-line">
            {TOOLS.map((t) => (
              <div key={t.name} className="px-5 py-2.5">
                <div className="flex items-center gap-2">
                  <code className="text-xs font-semibold text-ink">{t.name}</code>
                  <code className="truncate text-[11px] text-muted">{t.sig}</code>
                  <Badge className="ml-auto">{t.scope}</Badge>
                </div>
                <div className="mt-0.5 text-xs text-ink-2">{t.desc}</div>
              </div>
            ))}
            <div className="px-5 py-2.5 text-xs text-ink-2"><b className="text-ink">Resources:</b> every skill is also exposed as <code className="rounded bg-code px-1">contextloop://skills/&lt;slug&gt;</code>.</div>
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle sub="ctxloop — same API, same permissions"><span className="inline-flex items-center gap-1.5"><Terminal className="size-4 text-muted" />CLI &amp; background daemon</span></CardTitle>
          <CodeBlock lang="bash" code={`export CONTEXTLOOP_API_KEY=${k}\n\nnpm run cli -- ask "Why did the payment integration fail?"\nnpm run cli -- search "payflow timeout" --mode hybrid\nnpm run cli -- import ./meeting-notes.txt --visibility team\nnpm run cli -- report ./trace.json          # report agent executions\nnpm run cli -- skills pull --dir ~/.claude/skills\n\n# Background capture daemon: watches folders and imports new or changed sessions\nnpm run cli -- watch ~/.claude/projects ~/.codex/sessions`} />
        </Card>

        <Card>
          <CardTitle sub="Approved skills are written here on every approval or rollback"><span className="inline-flex items-center gap-1.5"><FolderSync className="size-4 text-muted" />Skill synchronization</span></CardTitle>
          {skills.loading && !skills.data ? <Spinner /> : (
            <div className="space-y-2.5">
              {skills.data?.targets?.map((t: any) => (
                <div key={t.harness} className="rounded-lg border border-line p-3">
                  <div className="flex items-center gap-2"><Badge tone="accent">{t.harness}</Badge><span className="text-xs text-muted">{skills.data.skills.filter((s: any) => s.harnesses.includes(t.harness)).length} skills</span></div>
                  <div className="mt-1.5 break-all font-mono text-[11px] text-ink-2">{t.dir}</div>
                </div>
              ))}
              <p className="text-xs text-muted">Codex also gets an <code className="rounded bg-code px-1">AGENTS.md</code> index. Point targets at <code className="rounded bg-code px-1">~/.claude/skills</code> in <Link to="/settings" className="text-accent hover:underline">Settings</Link> to sync straight into your harness.</p>
            </div>
          )}
        </Card>
      </div>

      <Card pad={false}>
        <div className="p-5 pb-2"><CardTitle sub="Every MCP/CLI call is audited with the agent and the human it acts for" right={<Link to="/audit" className="text-xs text-accent hover:underline">Full audit log →</Link>}><span className="inline-flex items-center gap-1.5"><Bot className="size-4 text-muted" />Recent agent activity</span></CardTitle></div>
        {activity.loading && !activity.data ? <Spinner /> : !activity.data?.rows.length ? (
          <Empty title="No agent activity yet" icon={<Bot className="size-6" />}>Connect Claude Code or Codex with the snippet above, or run <code>npm run mcp:smoke</code>.</Empty>
        ) : (
          <Table head={["Outcome", "Agent", "Action", "Resource", "Detail", "When"]}>
            {activity.data.rows.map((r: any) => (
              <tr key={r.id} className={r.outcome === "denied" ? "bg-critical-soft/50" : ""}>
                <Td><StatusBadge status={r.outcome} /></Td>
                <Td className="whitespace-nowrap text-xs">{r.actor_name}</Td>
                <Td className="font-mono text-xs">{r.action}</Td>
                <Td className="max-w-[220px] truncate text-xs text-ink-2">{r.resource}</Td>
                <Td className="max-w-[320px] truncate text-xs text-ink-2">{r.detail}</Td>
                <Td className="whitespace-nowrap text-xs text-muted">{ago(r.at)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
