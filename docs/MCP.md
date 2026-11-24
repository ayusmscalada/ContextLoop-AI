# MCP integration guide

ContextLoop ships a stdio MCP server (`server/src/mcp.ts`). It is a thin client over the REST API that authenticates with an **agent key**, so an agent sees exactly what its user may see, narrowed by the key's policy, and every call lands in the audit log.

## Tools

| Tool | Purpose |
|---|---|
| `ask_organization(question, project?)` | Cited answer from organizational memory (ontology-first facts + sources) |
| `search_knowledge(query, project?, sources?, limit?)` | Hybrid search, returns passages with sources |
| `get_project_context(project_id)` | Reconciled project state: owner, deadline, status, open conflicts, decisions, people, issues, tech, recent sources |
| `get_entity_details(entity)` | Any entity by name or id: attributes, relations, claims with quotes, conflicts, evidence |
| `list_skills()` / `get_skill(skill_name)` | Shared, approved skill versions with success rates |
| `report_agent_execution(...)` | Report a task outcome; feeds skill analytics and failure mining |
| `propose_skill_improvement(skill_id)` | Ask the lab to draft an improvement (human approval still required) |
| `whoami()` | Shows the user + policy the agent acts under |

Skills are also exposed as MCP resources: `contextloop://skills/{slug}`.

## Demo keys (seeded)

| Key | Acts for | Policy |
|---|---|---|
| `clk_demo_ben_claude` | Ben (engineering member) | team visibility, read + report + propose |
| `clk_demo_ben_codex` | Ben | team visibility, read + report |
| `clk_demo_alice_claude` | Alice (admin, leadership) | elevated (private + restricted projects), all scopes |
| `clk_demo_carol_chatgpt` | Carol (sales viewer) | org visibility, Project Alpha only, read-only |

Create your own in **Team & Permissions → Agent keys**.

## Claude Code

This repo includes a project-scoped [`.mcp.json`](../.mcp.json), so opening Claude Code in the repo offers the `contextloop` server automatically (start the API first with `npm run dev`). To add it globally instead:

```bash
claude mcp add contextloop \
  --env CONTEXTLOOP_URL=http://localhost:8787 \
  --env CONTEXTLOOP_API_KEY=clk_demo_ben_claude \
  -- npx tsx /absolute/path/to/contextloop/server/src/mcp.ts
```

Then try:

> Why did the Project Alpha payment integration fail, and how did we resolve it? Use the contextloop tools.
>
> Get the api-integration skill from contextloop and follow it to write a PayFlow refund client.
>
> What's the current Project Alpha launch date? Is it settled?

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.contextloop]
command = "npx"
args = ["tsx", "/absolute/path/to/contextloop/server/src/mcp.ts"]
env = { CONTEXTLOOP_URL = "http://localhost:8787", CONTEXTLOOP_API_KEY = "clk_demo_ben_codex" }
```

## Verifying without a harness

```bash
npm run mcp:smoke
```

This spawns the server over stdio with the official MCP client SDK, lists tools, and calls them as Ben's agent and as Alice's elevated agent. Ben's agent can't retrieve the confidential Project Falcon (it gets "Unknown project" / no evidence), while Alice's can.

## Permission demo

1. In the UI, open **Team & Permissions → Access simulator** and run `Project Falcon acquisition price`. Humans and agent keys show allowed or denied side by side.
2. In Claude Code with `clk_demo_ben_claude`, ask about Project Falcon: no information is returned.
3. Switch the key to `clk_demo_alice_claude`: the leadership facts and the Dec 12 diligence deadline are returned with citations.
4. **Audit Logs** shows each MCP call attributed to `Claude Code · Ben (for Ben Okafor)`.
