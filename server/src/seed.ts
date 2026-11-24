/**
 * Seeds a reproducible demo organization. Documents go through the real ingestion
 * pipeline; api-integration traces come from real executions of the v1 skill against
 * the PayFlow sandbox, so every failure in the dataset is genuine and replayable.
 */
import fs from "node:fs";
import path from "node:path";
import { all, now, ROOT, resetDatabase, run, uid } from "./db.ts";
import { audit, invalidateProjectCache, invalidateVisibility, resolvePrincipal } from "./auth.ts";
import { ensureDefaultAuthority, upsertEntity } from "./engine/ontology.ts";
import { ingestBuffer } from "./ingest/pipeline.ts";
import { createSkill, proposeImprovement, proposeNewSkills, syncSkills } from "./engine/skills.ts";
import { recordTrace } from "./engine/traces.ts";
import { compilePolicy, executeTask, sampleScenario } from "./eval/harness.ts";
import { buildIndex } from "./engine/search.ts";

const NOW = new Date("2026-11-24T09:00:00Z").getTime();
const daysAgo = (d: number, jitterH = 20) => new Date(NOW - d * 864e5 - Math.random() * jitterH * 36e5).toISOString();
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const rnd = (a: number, b: number) => Math.round(a + Math.random() * (b - a));

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(opts: { quiet?: boolean } = {}) {
  const realRandom = Math.random;
  Math.random = mulberry32(20261124); // reproducible sample dataset
  try {
    return await seedInner(opts);
  } finally {
    Math.random = realRandom;
  }
}

async function seedInner(opts: { quiet?: boolean }) {
  const log = (...a: any[]) => !opts.quiet && console.log(...a);
  const t0 = Date.now();
  resetDatabase();
  ensureDefaultAuthority();

  // ---------- org ----------
  const users = [
    ["u_alice", "Alice Morgan", "alice@northwind.example", "admin", "CTO", "#6366f1"],
    ["u_ben", "Ben Okafor", "ben@northwind.example", "member", "Senior Engineer", "#0ea5e9"],
    ["u_priya", "Priya Patel", "priya@northwind.example", "member", "Product Manager", "#10b981"],
    ["u_carol", "Carol Diaz", "carol@northwind.example", "viewer", "Account Executive", "#f59e0b"],
    ["u_david", "David Kim", "david@northwind.example", "member", "CFO", "#ef4444"],
  ];
  for (const u of users) run("INSERT INTO users(id, name, email, role, title, color) VALUES (?,?,?,?,?,?)", ...u);
  const teams = [["t_leadership", "Leadership", "Exec team"], ["t_engineering", "Engineering", "Product engineering"], ["t_sales", "Sales", "Customer-facing team"]];
  for (const t of teams) run("INSERT INTO teams(id, name, description) VALUES (?,?,?)", ...t);
  const membership: [string, string][] = [["t_leadership", "u_alice"], ["t_leadership", "u_david"], ["t_engineering", "u_alice"], ["t_engineering", "u_ben"], ["t_engineering", "u_priya"], ["t_sales", "u_carol"], ["t_sales", "u_priya"]];
  for (const [t, u] of membership) run("INSERT INTO team_members(team_id, user_id) VALUES (?,?)", t, u);
  for (const u of users) run("INSERT INTO workspaces(id, name, kind, owner_id) VALUES (?,?, 'personal', ?)", `ws_${u[0]}`, `${u[1].split(" ")[0]}'s workspace`, u[0]);
  for (const t of teams) run("INSERT INTO workspaces(id, name, kind, team_id) VALUES (?,?, 'team', ?)", `ws_${t[0]}`, `${t[1]} workspace`, t[0]);
  run("INSERT INTO workspaces(id, name, kind) VALUES ('ws_org', 'Northwind Labs', 'org')");

  // People / customers known to the ontology (gazetteer seeds; aliases enable first-name resolution)
  for (const [name, title] of [["Alice Morgan", "CTO"], ["Ben Okafor", "Senior Engineer"], ["Priya Patel", "Product Manager"], ["Carol Diaz", "Account Executive"], ["David Kim", "CFO"], ["Maya Chen", "Engineering Lead, Payments"], ["Sam Rivera", "Data Engineer"]])
    upsertEntity("person", name, { aliases: [name.split(" ")[0]], description: title });
  for (const c of ["Acme Retail", "Globex Logistics", "Lumen Pay"]) upsertEntity("customer", c);
  const projects = [
    ["prj_alpha", "Project Alpha", "Payment processing platform", "t_engineering", 0],
    ["prj_beacon", "Project Beacon", "Mobile wallet on top of Alpha", "t_engineering", 0],
    ["prj_falcon", "Project Falcon", "Confidential acquisition (leadership only)", "t_leadership", 1],
  ] as const;
  for (const [id, name, desc, team, restricted] of projects) {
    const eid = upsertEntity("project", name, { description: desc });
    run("INSERT INTO projects(id, name, description, team_id, restricted, entity_id) VALUES (?,?,?,?,?,?)", id, name, desc, team, restricted, eid);
  }
  invalidateProjectCache();

  // Agent API keys (MCP / CLI). Effective access = user's access ∩ key policy.
  const keys = [
    ["clk_demo_alice_claude", "Claude Code · Alice", "u_alice", ["knowledge:read", "skills:read", "skills:propose", "traces:write", "traces:read", "data:write"], "private", null],
    ["clk_demo_ben_claude", "Claude Code · Ben", "u_ben", ["knowledge:read", "skills:read", "skills:propose", "traces:write", "traces:read"], "team", null],
    ["clk_demo_ben_codex", "Codex · Ben", "u_ben", ["knowledge:read", "skills:read", "traces:write"], "team", null],
    ["clk_demo_carol_chatgpt", "ChatGPT connector · Carol", "u_carol", ["knowledge:read"], "org", JSON.stringify(["prj_alpha"])],
  ] as const;
  for (const [k, name, user, scopes, vis, projectsAllowed] of keys)
    run("INSERT INTO api_keys(key, name, user_id, scopes, max_visibility, allowed_projects, created_at) VALUES (?,?,?,?,?,?,?)", k, name, user, JSON.stringify(scopes), vis, projectsAllowed, daysAgo(40));

  const sources = [
    ["src_chatgpt", "chatgpt", "ChatGPT", "conversations.json exports (Settings → Data controls → Export)", { method: "export import" }],
    ["src_claude", "claude_code", "Claude Code", "Session transcripts from ~/.claude/projects/**/*.jsonl", { method: "local watcher", path: "~/.claude/projects" }],
    ["src_codex", "codex", "Codex", "Rollout logs from ~/.codex/sessions/**/*.jsonl", { method: "local watcher", path: "~/.codex/sessions" }],
    ["src_meetings", "meeting", "Meeting recorder", "Transcripts (.txt, .vtt, .md) from Zoom/Meet recorders", { method: "upload / webhook" }],
    ["src_docs", "document", "Documents & notes", "Markdown, TXT, JSON and PDF documents", { method: "upload / CLI" }],
    ["src_traces", "agent_trace", "Agent traces", "Execution traces reported over MCP, CLI or JSON import", { method: "MCP report_agent_execution" }],
  ] as const;
  for (const [id, kind, name, desc, cfg] of sources) run("INSERT INTO sources(id, kind, name, description, status, config) VALUES (?,?,?,?, 'connected', ?)", id, kind, name, desc, JSON.stringify(cfg));

  // ---------- skills ----------
  const skill = (slug: string, name: string, desc: string, cat: string, steps: string[], owner = "u_alice") =>
    createSkill({ slug, name, description: desc, category: cat, ownerId: owner, content: `---\nname: ${slug}\ndescription: ${desc}\nversion: 1\n---\n\n# ${name}\n\n## When to use\n${desc}\n\n## Steps\n${steps.map((s) => `- ${s}`).join("\n")}\n` });
  const skills = {
    codegen: skill("code-generation", "Code Generation", "Implement features and fixes from a ticket or prompt.", "engineering", ["Read the relevant files before editing.", "Make the smallest change that satisfies the request.", "Run the test suite and fix failures before finishing."]),
    review: skill("code-review", "Code Review", "Review a diff for correctness, security and style.", "engineering", ["Read the full diff and the files it touches.", "Flag correctness bugs before style issues.", "Summarize findings with file:line references."]),
    migration: skill("database-migration", "Database Migration", "Write and apply PostgreSQL schema migrations.", "data", ["Write the migration as a reversible up/down pair.", "Apply the migration to the target database.", "Verify the schema after applying."], "u_ben"),
    api: skill("api-integration", "API Integration", "Integrate with and call external HTTP APIs (payments, shipping, CRM) from agent tasks.", "integration", ["Read the API reference and build the request payload.", "Send the API request.", "Handle the response and map it to our domain model.", "Report errors."], "u_priya"),
    docs: skill("documentation", "Documentation", "Write and update technical documentation.", "engineering", ["Read the code being documented.", "Update the docs and examples.", "Check that every link resolves."]),
  };
  const ids = Object.fromEntries(all("SELECT id, slug FROM skills").map((s) => [s.slug, s.id]));
  void skills;

  // ---------- corpus through the real pipeline ----------
  const corpus = path.join(ROOT, "sample-data", "corpus");
  const plan: Record<string, { user: string; visibility: "org" | "team" | "private"; team?: string; project?: string }> = {
    "2026-09-22-project-alpha-architecture.md": { user: "u_priya", visibility: "org", project: "prj_alpha" },
    "2026-10-01-beacon-plan.md": { user: "u_priya", visibility: "org", project: "prj_beacon" },
    "chatgpt-conversations.json": { user: "u_ben", visibility: "team", team: "t_engineering" },
    "2026-10-08-engineering-meeting-018-alpha-incident.txt": { user: "u_alice", visibility: "org", project: "prj_alpha" },
    "claude-code-session-024-payflow-timeout.jsonl": { user: "u_ben", visibility: "team", team: "t_engineering", project: "prj_alpha" },
    "codex-execution-042-integration-test.jsonl": { user: "u_ben", visibility: "team", team: "t_engineering", project: "prj_alpha" },
    "2026-10-16-eng-handbook-external-api-standard.md": { user: "u_alice", visibility: "org" },
    "2026-11-02-db-migration-postmortem.md": { user: "u_ben", visibility: "org", project: "prj_alpha" },
    "2026-11-05-leadership-falcon.txt": { user: "u_alice", visibility: "team", team: "t_leadership", project: "prj_falcon" },
    "2026-11-10-acme-account-checkin.txt": { user: "u_carol", visibility: "team", team: "t_sales", project: "prj_alpha" },
    "2026-11-12-beacon-weekly-sync.txt": { user: "u_priya", visibility: "team", team: "t_engineering", project: "prj_beacon" },
    "ben-private-notes.md": { user: "u_ben", visibility: "private" },
  };
  for (const [file, o] of Object.entries(plan)) {
    const p = resolvePrincipal({ userId: o.user })!;
    const r = await ingestBuffer(fs.readFileSync(path.join(corpus, file)), p, { filename: file, visibility: o.visibility, teamId: o.team, projectId: o.project, origin: "seed", useLlm: process.env.SEED_WITH_LLM === "1" });
    log(`  ingested ${file} → ${r.documents.map((d) => `${d.title} [${d.extraction?.entities ?? 0} entities]`).join(", ")}`);
  }
  // Backdate import history to the document dates for a realistic timeline.
  for (const d of all("SELECT id, occurred_at FROM documents")) run("UPDATE documents SET ingested_at = ? WHERE id = ?", d.occurred_at, d.id);
  for (const i of all("SELECT i.id, d.occurred_at FROM imports i JOIN documents d ON i.doc_ids LIKE '%' || d.id || '%'")) run("UPDATE imports SET started_at = ?, finished_at = ? WHERE id = ?", i.occurred_at, i.occurred_at, i.id);

  // ---------- traces ----------
  const H = ["claude-code", "codex"];
  const synth = (o: { agent: string; skill?: string; n: number; rate: number; tasks: string[]; steps: () => any[]; failures: [string, () => string, number][]; project?: string }) => {
    for (let i = 0; i < o.n; i++) {
      const ok = Math.random() < o.rate;
      let errType: string | null = null, errMsg: string | null = null;
      const steps = o.steps();
      if (!ok) {
        const total = o.failures.reduce((a, f) => a + f[2], 0);
        let r = Math.random() * total;
        const f = o.failures.find((x) => (r -= x[2]) <= 0) ?? o.failures[0];
        errType = f[0];
        errMsg = f[1]();
        steps.push({ type: "error", name: errType, output: { message: errMsg }, status: "error" });
      }
      steps.push({ type: "result", name: ok ? "success" : "failure", status: ok ? "ok" : "error" });
      const tin = rnd(1500, 9000), tout = rnd(300, 2500);
      recordTrace({ agent: o.agent, harness: pick(H), skill: o.skill, task: pick(o.tasks), status: ok ? "success" : "failure", error_type: errType, error_message: errMsg, tokens_in: tin, tokens_out: tout, latency_ms: rnd(4000, 60000), steps, project: o.project ?? pick(["prj_alpha", "prj_alpha", "prj_beacon"]) }, { origin: "seed", userId: pick(["u_ben", "u_priya", "u_alice"]), startedAt: daysAgo(rnd(0, 29)) });
    }
  };
  const tc = (name: string, status = "ok", ms = rnd(80, 2400)) => ({ type: "tool_call", name, status, latency_ms: ms });
  synth({ agent: "coder-agent", skill: "code-generation", n: 92, rate: 0.94, tasks: ["Add pagination to /v1/orders", "Implement refund endpoint", "Fix currency rounding in ledger", "Add Beacon wallet balance API", "Refactor checkout validators"], steps: () => [{ type: "plan", name: "read ticket" }, tc("Read"), tc("Grep"), tc("Edit"), tc("Bash: npm test")], failures: [["test_failure", () => `${rnd(1, 6)} tests failed after generation in tests/${pick(["orders", "ledger", "checkout"])}`, 1]] });
  synth({ agent: "review-agent", skill: "code-review", n: 52, rate: 0.92, tasks: ["Review PR #" + rnd(400, 520), "Security review of webhook handler", "Review ledger migration PR"], steps: () => [tc("git.diff"), tc("Read"), tc("Grep"), { type: "output", name: "review comments" }], failures: [["context_overflow", () => `diff exceeded ${rnd(150, 400)}k tokens`, 1]] });
  synth({ agent: "migration-agent", skill: "database-migration", n: 46, rate: 0.76, tasks: ["Add settlement_status column to orders", "Create index on payments(customer_id)", "Backfill ledger entry types", "Split addresses table"], steps: () => [tc("Read"), tc("Write: migration.sql"), tc("psql: apply", "ok", rnd(500, 9000)), tc("psql: verify")], failures: [["lock_timeout", () => `canceling statement due to lock timeout on relation "orders" after ${rnd(30, 400)}s`, 7], ["schema_drift", () => `column "${pick(["settlement_status", "currency", "region"])}" of relation "orders" already exists`, 3]], project: "prj_alpha" });
  synth({ agent: "docs-agent", skill: "documentation", n: 31, rate: 0.9, tasks: ["Document the PayFlow integration", "Update Beacon API reference", "Write runbook for settlement failures"], steps: () => [tc("Read"), tc("Edit: docs"), tc("linkcheck")], failures: [["stale_reference", () => `linked file docs/${pick(["payflow", "ledger"])}/${pick(["setup", "errors"])}.md not found`, 1]] });
  // Unskilled sessions: one hidden repeated workflow (release notes / PR prep) among ad-hoc work.
  for (let i = 0; i < 27; i++) {
    const release = i < 9;
    const steps: any[] = release
      ? [tc("git.diff"), tc("changelog.read"), tc("changelog.update"), tc("tests.run"), tc("gh.pr_create")]
      : [tc(pick(["Read", "Grep", "Bash"])), tc(pick(["Edit", "WebFetch", "Read"])), tc(pick(["Bash: npm test", "Grep", "Write"]))];
    steps.push({ type: "result", name: "success", status: "ok" });
    recordTrace({ agent: "general-agent", harness: pick(H), task: release ? pick(["Prepare release notes for v2." + i, "Open release PR for charge-service", "Write changelog and PR for webhook fixes"]) : pick(["Investigate flaky CI", "Answer question about ledger schema", "Rename config keys", "Bump dependencies"]), status: "success", tokens_in: rnd(2000, 7000), tokens_out: rnd(400, 1800), latency_ms: rnd(8000, 50000), steps }, { origin: "seed", userId: pick(["u_ben", "u_priya"]), startedAt: daysAgo(rnd(0, 29)) });
  }
  // api-integration: real executions of v1 against the PayFlow sandbox, production traffic mix.
  log("  running 56 real api-integration executions (skill v1) against the PayFlow sandbox…");
  const v1 = all("SELECT content FROM skill_versions WHERE skill_id = ? AND version = 1", ids["api-integration"])[0].content;
  const { policy } = await compilePolicy(v1);
  const results = await Promise.all(Array.from({ length: 56 }, async () => {
    const scenario = sampleScenario();
    const recoverAfter = Math.random() < 0.7 ? 1 : 2;
    return { scenario, recoverAfter, r: await executeTask(policy, scenario, { recoverAfter }) };
  }));
  results.forEach(({ scenario, recoverAfter, r }, i) => {
    recordTrace({ agent: "payments-agent", harness: pick(H), skill: "api-integration", skill_version: 1, task: `${pick(["Charge", "Capture", "Refund"])} order #${47000 + i * 17} via PayFlow API`, status: r.status, error_type: r.error_type, error_message: r.error_message, latency_ms: r.latency_ms, tokens_in: rnd(2200, 4200), tokens_out: rnd(400, 900), steps: r.steps, project: "prj_alpha", ...({ fault: { scenario, recoverAfter } } as any) }, { origin: "seed", userId: "u_ben", startedAt: daysAgo(Math.floor((56 - i) * 0.45)) });
  });

  // ---------- pre-computed analysis so the Lab isn't empty ----------
  await proposeImprovement(ids["database-migration"], "u_ben");
  proposeNewSkills("u_alice");
  syncSkills();
  invalidateVisibility();
  buildIndex();
  audit(null, "system.seed", "demo-org", `Seeded in ${Date.now() - t0} ms`);
  const counts = all("SELECT (SELECT COUNT(*) FROM documents) docs, (SELECT COUNT(*) FROM entities) ents, (SELECT COUNT(*) FROM relations) rels, (SELECT COUNT(*) FROM traces) traces, (SELECT COUNT(*) FROM conflicts WHERE status='open') conflicts")[0];
  log(`Seed complete in ${Date.now() - t0} ms:`, counts);
  return counts;
}

if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) {
  seed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
void uid; void now;
