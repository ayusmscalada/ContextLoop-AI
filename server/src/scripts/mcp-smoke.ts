/**
 * MCP smoke test: spawns the ContextLoop MCP server over stdio exactly like Claude Code
 * or Codex would, lists tools, and calls them under two different agent keys to show
 * permission enforcement.   Usage: npm run mcp:smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { ROOT } from "../db.ts";

async function session(key: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "server", "src", "mcp.ts")],
    env: { ...process.env, CONTEXTLOOP_API_KEY: key, CONTEXTLOOP_URL: process.env.CONTEXTLOOP_URL ?? "http://localhost:8787" } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return r.content.map((c: any) => c.text).join("\n");
  };
  return { client, call };
}

const line = (t: string) => console.log(`\n\x1b[36m── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}\x1b[0m`);

const ben = await session("clk_demo_ben_claude");
line("tools/list");
console.log((await ben.client.listTools()).tools.map((t) => `• ${t.name}`).join("\n"));
line("whoami (Ben's Claude Code key)");
console.log(await ben.call("whoami"));
line("ask_organization: why did the payment integration fail?");
console.log(await ben.call("ask_organization", { question: "Why did the Project Alpha payment integration fail, and how did we resolve it?" }));
line("get_skill api-integration");
console.log(await ben.call("get_skill", { skill_name: "api-integration" }));
line("Ben's agent asks about the confidential Project Falcon");
console.log(await ben.call("ask_organization", { question: "What is Project Falcon and what is the acquisition price?" }));
console.log(await ben.call("get_project_context", { project_id: "prj_falcon" }));

const alice = await session("clk_demo_alice_claude");
line("Alice's elevated agent asks the same question");
console.log(await alice.call("ask_organization", { question: "What is Project Falcon and what is the acquisition price?" }));
line("report_agent_execution");
console.log(await ben.call("report_agent_execution", { agent: "claude-code", task: "Smoke test: charge order via PayFlow", status: "success", skill: "api-integration", latency_ms: 812 }));

await ben.client.close();
await alice.client.close();
process.exit(0);
