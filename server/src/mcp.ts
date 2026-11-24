/**
 * ContextLoop MCP server (stdio). Gives any MCP-capable harness (Claude Code, Codex,
 * Cursor, …) access to organizational memory and shared skills.
 *
 * Auth: every call goes to the ContextLoop API with the agent's key, so the agent
 * gets exactly (user's access ∩ key policy) and every call lands in the audit log.
 *
 *   CONTEXTLOOP_URL      default http://localhost:8787
 *   CONTEXTLOOP_API_KEY  agent key, e.g. clk_demo_ben_claude
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.CONTEXTLOOP_URL ?? "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.CONTEXTLOOP_API_KEY ?? "";

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const safe = (fn: (a: any) => Promise<string>) => async (a: any) => {
  try {
    return text(await fn(a));
  } catch (e: any) {
    return { ...text(`Error: ${e.message}`), isError: true };
  }
};

const server = new McpServer({ name: "contextloop", version: "0.1.0" });

server.registerTool(
  "ask_organization",
  {
    title: "Ask organizational memory",
    description: "Answer a question from the organization's accumulated knowledge (meetings, AI sessions, docs, decisions) with numbered citations. Use for 'why did we…', 'what did we decide…', 'how did we fix…' questions about past work.",
    inputSchema: { question: z.string(), project: z.string().optional().describe("Project id, e.g. prj_alpha") },
  },
  safe(async ({ question, project }) => {
    const r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question, filters: project ? { projectId: project } : undefined }) });
    const cites = r.citations.map((c: any) => `[${c.n}] ${c.title} (${c.sourceKind}, ${c.occurredAt?.slice(0, 10) ?? "undated"})`).join("\n");
    return `${r.answer}\n\nSources:\n${cites || "(none you have access to)"}`;
  }),
);

server.registerTool(
  "search_knowledge",
  {
    title: "Search knowledge",
    description: "Hybrid keyword + semantic search over everything the team has captured. Returns matching passages with their source.",
    inputSchema: {
      query: z.string(),
      project: z.string().optional(),
      sources: z.array(z.enum(["chatgpt", "claude_code", "codex", "meeting", "document", "agent_trace", "email", "github"])).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
  },
  safe(async ({ query, project, sources, limit }) => {
    const qs = new URLSearchParams({ q: query, limit: String(limit ?? 6) });
    if (project) qs.set("project", project);
    if (sources?.length) qs.set("sources", sources.join(","));
    const r = await api(`/api/search?${qs}`);
    if (!r.hits.length) return "No matching knowledge you have access to.";
    return `${r.hits.length} results in ${r.ms} ms\n\n` + r.hits.map((h: any, i: number) => `${i + 1}. ${h.title} [${h.sourceKind}, ${h.occurredAt?.slice(0, 10) ?? ""}]\n${h.text.slice(0, 500)}`).join("\n\n");
  }),
);

server.registerTool(
  "get_project_context",
  {
    title: "Get project context",
    description: "Current authoritative state of a project: owner, deadline, status, open conflicts, decisions, people, issues, technologies and recent sources.",
    inputSchema: { project_id: z.string().describe("Project id or name, e.g. prj_alpha or 'Project Alpha'") },
  },
  safe(async ({ project_id }) => JSON.stringify(await api(`/api/context/project/${encodeURIComponent(project_id)}`), null, 2)),
);

server.registerTool(
  "get_entity_details",
  {
    title: "Get entity details",
    description: "Look up a person, project, customer, technology, issue or decision: attributes, relationships, claims with sources, conflicts and history.",
    inputSchema: { entity: z.string().describe("Entity id or name") },
  },
  safe(async ({ entity }) => {
    let id = entity;
    if (!entity.startsWith("ent_")) {
      const matches = await api<any[]>(`/api/entities?q=${encodeURIComponent(entity)}`);
      if (!matches.length) return `No entity named "${entity}" that you have access to.`;
      id = (matches.find((m) => m.name.toLowerCase() === entity.toLowerCase()) ?? matches[0]).id;
    }
    const e = await api(`/api/entities/${id}`);
    return JSON.stringify({
      name: e.name, type: e.type, description: e.description, attributes: e.attributes,
      relations: e.relations.map((r: any) => `${r.dir === "out" ? "→" : "←"} ${r.type} ${r.name} (${r.entityType})`),
      claims: e.claims.map((c: any) => ({ predicate: c.predicate, value: c.value, status: c.status, source: c.doc_title, quote: c.snippet })),
      openConflicts: e.conflicts.filter((c: any) => c.status === "open").map((c: any) => c.rationale),
      evidence: e.evidence.slice(0, 6).map((m: any) => `${m.title} (${m.source_kind})`),
    }, null, 2);
  }),
);

server.registerTool(
  "list_skills",
  { title: "List shared skills", description: "List the team's shared, versioned agent skills with their current success rates.", inputSchema: {} },
  safe(async () => {
    const r = await api("/api/skills");
    return r.skills.map((s: any) => `- ${s.slug} (v${s.active_version}) — ${s.description} — success ${s.stats.rate == null ? "n/a" : Math.round(s.stats.rate * 100) + "%"} over ${s.stats.runs} runs`).join("\n");
  }),
);

server.registerTool(
  "get_skill",
  {
    title: "Get skill",
    description: "Fetch the active, approved version of a shared skill (SKILL.md). Follow it when doing the task it describes.",
    inputSchema: { skill_name: z.string().describe("Skill slug, e.g. api-integration") },
  },
  safe(async ({ skill_name }) => {
    const s = await api(`/api/skills/${encodeURIComponent(skill_name)}`);
    return `<!-- ${s.name} v${s.active_version}, ${s.stats.runs} recorded runs -->\n${s.content}`;
  }),
);

server.registerTool(
  "report_agent_execution",
  {
    title: "Report agent execution",
    description: "Report the outcome of a task you just performed so the organization can measure skills and learn from failures. Call once at the end of a task that used a shared skill.",
    inputSchema: {
      agent: z.string().describe("Your agent name, e.g. claude-code"),
      task: z.string(),
      status: z.enum(["success", "failure"]),
      skill: z.string().optional().describe("Skill slug used"),
      skill_version: z.number().int().optional(),
      error_type: z.string().optional(),
      error_message: z.string().optional(),
      tokens_in: z.number().int().optional(),
      tokens_out: z.number().int().optional(),
      latency_ms: z.number().int().optional(),
      steps: z.array(z.object({ type: z.string(), name: z.string().optional(), status: z.string().optional() })).optional(),
      project: z.string().optional(),
    },
  },
  safe(async (t) => {
    const r = await api("/api/traces", { method: "POST", body: JSON.stringify({ harness: "mcp", ...t }) });
    return `Recorded execution ${r.ids[0]}.`;
  }),
);

server.registerTool(
  "propose_skill_improvement",
  {
    title: "Propose skill improvement",
    description: "Ask ContextLoop to analyze recent failures of a skill and draft a reviewable improvement. A human must approve it before it becomes active.",
    inputSchema: { skill_id: z.string().describe("Skill slug or id") },
  },
  safe(async ({ skill_id }) => {
    const s = await api(`/api/skills/${encodeURIComponent(skill_id)}`);
    const r = await api("/api/lab/analyze", { method: "POST", body: JSON.stringify({ skillId: s.id }) });
    return r.created.length ? `Drafted ${r.created.length} proposal(s): ${r.created.join(", ")}. A reviewer will evaluate and approve them in the Improvement Lab.` : "No new recurring failures to address (or a proposal is already pending).";
  }),
);

server.registerTool(
  "whoami",
  { title: "Who am I", description: "Show which user and access policy this agent is acting under.", inputSchema: {} },
  safe(async () => {
    const r = await api("/api/me");
    const p = r.principal;
    return `Acting as ${p.agent?.name ?? "user"} for ${p.user.name} (${p.user.role}); scopes: ${p.agent?.scopes?.join(", ") ?? "all"}; max visibility: ${p.agent?.maxVisibility ?? "n/a"}`;
  }),
);

// Skills as resources, so harnesses that browse resources can attach them directly.
server.registerResource(
  "skill",
  new ResourceTemplate("contextloop://skills/{slug}", {
    list: async () => {
      const r = await api("/api/skills");
      return { resources: r.skills.map((s: any) => ({ uri: `contextloop://skills/${s.slug}`, name: `${s.name} (v${s.active_version})`, mimeType: "text/markdown" })) };
    },
  }),
  { title: "Shared skill", description: "Active version of a shared team skill", mimeType: "text/markdown" },
  async (uri, { slug }) => {
    const s = await api(`/api/skills/${encodeURIComponent(String(slug))}`);
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: s.content }] };
  },
);

if (!KEY) console.error("[contextloop-mcp] CONTEXTLOOP_API_KEY is not set; calls will be rejected.");
await server.connect(new StdioServerTransport());
console.error(`[contextloop-mcp] connected to ${BASE}`);
