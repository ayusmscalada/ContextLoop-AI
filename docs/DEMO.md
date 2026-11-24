# Demo script (≈ 5 minutes)

Setup: `npm run seed && npm run dev`, open http://localhost:5173 as **Alice (admin)**. Keep `sample-data/demo/` open in a file browser and a terminal in the repo.

## 1. Overview (20 s)
The learning-loop strip: sessions captured, entities, skills, agent success rate, pending suggestions. "This is the shared context layer: everything the team does with AI, in one place."

## 2. Capture + store (40 s): Data Sources
Drag `1-alpha-planning-2026-10-02.txt`, `3-claude-code-session-webhooks.jsonl` and `4-chatgpt-export-conversations.json` into the uploader. Each is detected (transcript / Claude Code JSONL / ChatGPT export), stored raw, chunked and extracted. Drag `1-alpha-planning…` again: **duplicate blocked (similarity 1.0)**. Open one in **Data Lake** to show the byte-exact raw file next to the normalized chunks and auto-extracted metadata.

## 3. Understand + resolve conflicts (50 s): Knowledge Graph
Upload `2-alpha-sprint-review-2026-10-20.txt`. The import result shows **1 conflict detected**. Open **Knowledge Graph → Conflicts**: Nov 15 vs Dec 6, both sources side by side, scores (authority, recency, explicitness) and the rationale. Approve Dec 6. On the graph, click **Project Alpha** to see the deadline now current with history, plus owner, people, decisions and issues, each linked to evidence.

## 4. Retrieve (40 s): AI Search
Ask *"Why did the Project Alpha payment integration fail, and how did we resolve it?"*. The answer cites engineering meeting #018, Claude Code session #024 and Codex execution #042 (click a citation). Follow up with *"When does it launch?"*: conversation memory, and the answer comes **from the ontology** with its review state. Note the latency (single-digit ms retrieval).

## 5. Detect recurring failures (30 s): AI Agents
Per-skill success rates: API Integration is the outlier. In **Recurring failures**: *timeout: agent exceeded … (no client timeout configured)*. Click into one trace: step timeline, a single attempt hanging for 2.5 s.

## 6. Improve (90 s): Improvement Lab ← the key moment
**Analyze traces** → proposal for API Integration: analysis, evidence clusters, related org knowledge, diff (timeout, transient-only retries, backoff, Retry-After).
**Run evaluation**: historical failures replayed against the sandbox. v1 ≈ 16% → proposal ≈ 80–95%, but **the eval catches "Timeout after commit → customer charged 2 times"**. Retries without idempotency double-charge.
**Refine proposal from evaluation**: it adds an Idempotency-Key step, grounded in the Engineering Handbook. **Re-run evaluation → 100%.**
Switch to **Ben (member)** and try to approve: blocked (approval is admin-only). Switch back and **Approve**: v2 activated, synced to Claude Code + Codex.
**Run 20 live executions**: v1 ~60% vs v2 100% in the version comparison.

## 7. Share via MCP (40 s)
In a terminal: `claude` in the repo (the project `.mcp.json` registers ContextLoop with Ben's key):
> "Using contextloop, why did the Alpha payment integration fail and what's our retry standard? Then get the api-integration skill."

It answers with citations and pulls **v2** of the skill. Ask about **Project Falcon**: nothing (Ben's agent can't see leadership-restricted data). Show **Team & Permissions → Access simulator** with the same query across humans and agent keys, and **Audit Logs** with the MCP calls and denials.

(Without Claude Code at hand: `npm run mcp:smoke` shows the same over real stdio MCP.)
