# ContextLoop AI

**Self-improving organizational intelligence & shared AI memory.**

ContextLoop captures what a team produces with AI (ChatGPT conversations, Claude Code sessions, Codex runs, meeting transcripts, documents, agent traces), turns it into a typed, trustworthy ontology, makes it queryable by people *and* agents, and closes the loop by improving the agents' skills from their own execution history.

```
Capture → Store → Understand → Retrieve → Improve → Share
```

The product promise in one moment: **an agent keeps failing → the platform finds the pattern → drafts a fix grounded in what the org already knows → the evaluation catches a hidden regression → the fix is refined → a human approves it → it syncs to Claude Code and Codex → subsequent executions measurably succeed.** That loop runs for real in this repo. Nothing in it is mocked UI. See [docs/EVALUATION.md](docs/EVALUATION.md):

| `api-integration` skill | v1 (original) | v2 (approved) |
|---|---|---|
| Replay of historical failures + regression/control cases | 16% | **100%** |
| Live production-mix executions (n=60) | 58% | **100%** |

---

## Quick start

Requires **Node ≥ 22.13** (uses the built-in `node:sqlite`). No database, Docker or API key needed.

```bash
npm run setup      # installs server + web deps, seeds the demo org
npm run dev        # API on :8787, web UI on http://localhost:5173
```

Optional: `export ANTHROPIC_API_KEY=…` before `npm run dev` switches extraction, answers, skill rewriting and skill→policy compilation to Claude (`claude-opus-5-5`). Without a key, a deterministic engine runs everything offline, so the demo is fully reproducible.

| Command | What it does |
|---|---|
| `npm run dev` | API (watch mode) + Vite UI |
| `npm run seed` | Reset to the demo dataset |
| `npm run eval:report` | Run the full improvement loop in an isolated DB and write `docs/EVALUATION.md` |
| `npm run mcp:smoke` | Spawn the MCP server over stdio and exercise every tool under two agent keys |
| `npm run cli -- <cmd>` | CLI: `ask`, `search`, `import`, `watch`, `skills pull`, `report`, `whoami` |
| `docker compose up` | Single-container deployment (API + built UI), data on a volume |

## What's in the demo

A fictional software company, **Northwind Labs**, uses ChatGPT, Claude Code and Codex to build a payment platform (**Project Alpha**). The seed pushes 12 real-format files through the actual ingestion pipeline and records ~300 agent executions. The 56 `api-integration` runs are **real executions** of the v1 skill against a fault-injecting payment sandbox, so their failures are genuine and replayable.

Live-demo files for upload are in [`sample-data/demo/`](sample-data/demo): two meeting transcripts with conflicting deadlines, a Claude Code session, a ChatGPT export, a Codex rollout and an agent-trace batch. The step-by-step script is in [docs/DEMO.md](docs/DEMO.md).

## Feature map

| Area | What's implemented |
|---|---|
| **Ingestion** | Format detection + parsers for ChatGPT `conversations.json` (walks the branch tree, keeps the active thread), Claude Code `.jsonl` (tool calls/results, tokens, cwd, branch), Codex rollout `.jsonl` (function calls, exit codes), WebVTT/speaker transcripts, Markdown/TXT/JSON/PDF, agent-trace JSON. Raw bytes stored content-addressed in the lake first; exact + near-duplicate detection (SHA-256 + 5-shingle Jaccard); automatic metadata; per-import stage tracking. CLI watcher daemon for `~/.claude/projects` / `~/.codex/sessions`. |
| **Ontology** | Typed entities (person, project, customer, technology, issue, decision, task), relations, and **claims with provenance**. Single-valued predicates (deadline, owner, status) are reconciled: agreement → current; disagreement → an open conflict with a scored, explainable proposal (source authority × recency × explicitness, speaker authority). Human review supersedes, never deletes. Full history. Admin-tunable source authority. |
| **Retrieval** | In-memory hybrid index: BM25 + local 512-d feature-hashing embeddings fused with RRF; filters by project/source/date; permission-filtered *before* ranking. Typical query: 1–5 ms. RAG answers cite every claim; **ontology-first facts** (e.g. "When does Alpha launch?" → reconciled deadline + conflict state); conversation memory resolves follow-ups; related entities. |
| **Observability** | Traces with step timelines, tool calls, tokens, latency, cost; failure-signature normalization; recurring-failure clustering; repeated-workflow mining (candidate new skills); per-skill/agent/version analytics. |
| **Self-improving skills** | Registry + immutable versions; failure-driven proposals grounded in org knowledge; **executable evaluation** (historical failures replayed against a real HTTP sandbox, plus regression and control cases); refine-from-eval; human approval; rollback; sync to Claude Code (`.claude/skills/*/SKILL.md`) and Codex (`.codex/skills` + `AGENTS.md`); live verification by version. |
| **MCP** | stdio MCP server: `ask_organization`, `search_knowledge`, `get_project_context`, `get_entity_details`, `list_skills`, `get_skill`, `report_agent_execution`, `propose_skill_improvement`, `whoami`, plus skills as MCP resources. |
| **Permissions** | Personal/team/org workspaces; admin/member/viewer; private/team/org visibility; restricted projects; **agent keys with scopes, max visibility and project allow-lists**. Effective access = *user ∩ agent policy*, enforced in retrieval, graph, entities, conflicts and MCP. Access simulator; full audit log including denials. |

## Architecture (short)

```
 sources ──► ingest (detect → raw lake → parse → dedupe → chunk)
                 │
                 ├──► extract (rules + optional Claude) ──► ontology: entities · relations · claims ──► reconcile/conflicts
                 └──► hybrid index (BM25 + hashed embeddings)
 agents ──► traces ──► failure clusters / workflow mining ──► proposals ──► eval harness ──► approve ──► versioned skills ──► sync
                                                                     ▲                                          │
 people (web UI) ─┐                                                  └── org knowledge grounds every proposal   ▼
 agents (MCP/CLI) ┴──► REST API ──► permission layer (user ∩ agent policy) ──► search · answers · context · skills
```

Details and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). MCP setup for Claude Code and Codex: [docs/MCP.md](docs/MCP.md).

**Stack:** TypeScript end to end. Node + Hono API, SQLite via `node:sqlite` (WAL), React + Vite + Tailwind v4 UI, Cytoscape for the graph, Recharts for charts, `@modelcontextprotocol/sdk` for MCP, `@anthropic-ai/sdk` for the optional Claude layer.

## Deliberate MVP trade-offs

The suggested stack was Python/FastAPI/Postgres/pgvector/Redis/Celery. I chose a zero-infrastructure TypeScript build so a reviewer can run the whole system with `npm run setup && npm run dev`, and so every layer shares one set of types. Each piece maps to a production component:

| MVP | Production path |
|---|---|
| SQLite (`node:sqlite`, WAL) | Postgres. Schema is relational and portable; claims/relations tables map 1:1 |
| In-memory BM25 + feature-hashing embeddings | pgvector / a hosted embedding model behind the same `embed()` + `search()` interface |
| Local lake folder, content-addressed | S3/MinIO with the same `raw/<yyyy-mm>/<sha>` layout |
| Synchronous ingest pipeline with stage tracking | Queue workers (stages are already isolated functions) |
| Demo identity switcher (`X-User-Id`) | SSO/OIDC session. Agent keys are already real bearer tokens |
| Eval harness for HTTP-integration skills | One harness per skill family (DB migrations → ephemeral Postgres replay, code skills → test suites) |

Not built (by design, for a one-week MVP): desktop app wrapper, SOC 2 controls, enterprise control plane, connectors that need OAuth (Slack, Gmail, Notion). The ingestion layer is format-driven, so each connector is a fetcher plus a parser.

## Repository layout

```
server/src/
  index.ts            REST API (Hono) + static UI
  db.ts  auth.ts      schema, permission model, audit
  ingest/             parsers.ts (formats) · pipeline.ts (lake → dedupe → chunk → extract → index)
  engine/             extract.ts · ontology.ts · search.ts · traces.ts · skills.ts
  eval/               mockApi.ts (PayFlow fault sandbox) · harness.ts (policy compiler, executor, evaluation)
  mcp.ts  cli.ts      agent-facing surfaces
  seed.ts  llm.ts     demo org · optional Claude layer
  scripts/            eval-report · mcp-smoke · gen-sample-data
web/src/              React UI (12 pages)
sample-data/          corpus (seeded) + demo (for live upload)
docs/                 ARCHITECTURE · MCP · DEMO · EVALUATION
```
