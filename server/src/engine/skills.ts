/**
 * Self-improving skills: registry + versions, failure-driven improvement proposals,
 * new-skill proposals from repeated workflows, human approval, rollback, and sync to
 * Claude Code / Codex skill directories.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { all, get, getSetting, json, now, ROOT, run, uid, type Row } from "../db.js";
import { structured } from "../llm.js";
import { recordTrace, recurringFailures, repeatedWorkflows, skillStats, type FailureCluster } from "./traces.js";
import { compilePolicy, executeTask, sampleScenario } from "../eval/harness.js";
import { search } from "./search.js";
import { resolvePrincipal, type Principal } from "../auth.js";

export function listSkills() {
  return all("SELECT s.*, u.name owner_name FROM skills s LEFT JOIN users u ON u.id = s.owner_id ORDER BY s.name").map((s) => ({
    ...s,
    harnesses: json(s.harnesses, []),
    stats: skillStats(s.id),
    pending: get("SELECT COUNT(*) n FROM proposals WHERE skill_id = ? AND status IN ('pending','evaluated')", s.id)!.n,
    versions: get("SELECT COUNT(*) n FROM skill_versions WHERE skill_id = ?", s.id)!.n,
  }));
}

export function getSkill(idOrSlug: string) {
  const s = get("SELECT * FROM skills WHERE id = ? OR slug = ?", idOrSlug, idOrSlug);
  if (!s) return null;
  const versions = all("SELECT v.*, u.name author FROM skill_versions v LEFT JOIN users u ON u.id = v.created_by WHERE skill_id = ? ORDER BY version DESC", s.id);
  const active = versions.find((v) => v.version === s.active_version);
  return { ...s, harnesses: json(s.harnesses, []), versions, content: active?.content ?? "", stats: skillStats(s.id) };
}

export function createSkill(o: { slug: string; name: string; description: string; category: string; content: string; ownerId: string; harnesses?: string[] }) {
  const id = uid("skl");
  run("INSERT INTO skills(id, slug, name, description, category, active_version, owner_id, harnesses, created_at) VALUES (?,?,?,?,?,1,?,?,?)", id, o.slug, o.name, o.description, o.category, o.ownerId, JSON.stringify(o.harnesses ?? ["claude-code", "codex"]), now());
  run("INSERT INTO skill_versions(id, skill_id, version, content, changelog, created_by, created_at) VALUES (?,?,?,?,?,?,?)", uid("skv"), id, 1, o.content, "Initial version", o.ownerId, now());
  return id;
}

// ---------- diff ----------
export function lineDiff(a: string, b: string): { op: "eq" | "add" | "del"; text: string }[] {
  const A = a.split("\n"), B = b.split("\n");
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: "eq" | "add" | "del"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push({ op: "eq", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "del", text: A[i++] });
    else out.push({ op: "add", text: B[j++] });
  }
  while (i < A.length) out.push({ op: "del", text: A[i++] });
  while (j < B.length) out.push({ op: "add", text: B[j++] });
  return out;
}

// ---------- proposal generation ----------
const REMEDIATIONS: Record<string, { steps: string[]; rationale: string }> = {
  timeout: {
    steps: [
      "Configure a client timeout of 800 ms on every outbound request; never wait indefinitely.",
      "Retry transient errors (timeouts, 5xx, 429) up to 3 times; never retry 4xx validation errors.",
      "Use exponential backoff starting at 200 ms with jitter between retries.",
    ],
    rationale: "requests hung during upstream latency spikes and the agent had no timeout or retry, so the task deadline expired",
  },
  upstream_error: {
    steps: ["Retry transient errors (timeouts, 5xx, 429) up to 3 times; never retry 4xx validation errors.", "Use exponential backoff starting at 200 ms with jitter between retries."],
    rationale: "transient 503 responses were treated as final failures",
  },
  rate_limited: {
    steps: ["Honor the Retry-After header on 429 responses before retrying."],
    rationale: "the agent retried immediately into an active rate limit",
  },
  duplicate_charge: {
    steps: ["Send an Idempotency-Key header with every write request and reuse it on retries so a retry can never double-charge."],
    rationale: "retries after a slow-but-committed request created duplicate charges",
  },
  validation_error: {
    steps: ["Fail fast on 4xx validation errors: do not retry, surface the provider's message."],
    rationale: "non-retryable errors were retried",
  },
  lock_timeout: {
    steps: ["Set `lock_timeout = '5s'` and `statement_timeout` before DDL.", "Use `CREATE INDEX CONCURRENTLY` and split column backfills into batches of 10k rows.", "Run migrations outside peak traffic windows and verify with `EXPLAIN` first."],
    rationale: "ALTER TABLE statements waited on long-held locks during peak traffic",
  },
  schema_drift: {
    steps: ["Diff the live schema against the migration's expected baseline before applying.", "Abort with a clear message when drift is detected instead of applying partial changes."],
    rationale: "migrations assumed a schema that had drifted in production",
  },
};

const LlmProposal = z.object({
  title: z.string(),
  issue: z.string().describe("Short name of the detected issue"),
  analysis: z.string().describe("2-4 sentences: what failed, how often, root cause from the traces"),
  proposed_content: z.string().describe("The complete revised SKILL.md, keeping the frontmatter and structure, with the version bumped"),
  changelog: z.string(),
});

function bumpVersion(content: string, version: number) {
  return content.match(/^version:.*$/m) ? content.replace(/^version:.*$/m, `version: ${version}`) : content;
}

function insertSteps(content: string, steps: string[]): string {
  const lines = content.split("\n");
  const existing = new Set(lines.map((l) => l.trim().toLowerCase()));
  const fresh = steps.filter((s) => !existing.has(`- ${s}`.toLowerCase()) && !content.includes(s));
  if (!fresh.length) return content;
  // Put reliability rules right after the "## Steps" heading (or append a section).
  const idx = lines.findIndex((l) => /^##\s+(steps|instructions|procedure)/i.test(l));
  if (idx === -1) return `${content.trimEnd()}\n\n## Reliability rules\n${fresh.map((s) => `- ${s}`).join("\n")}\n`;
  let end = idx + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  const body = lines.slice(idx + 1, end).filter((l) => l.trim());
  // Rewrite vague original steps.
  const rewritten = body.map((l) => l.replace(/^- Report errors\.?$/i, "- Log the final failure with attempt count and last error, then report it to the caller."));
  const ordered = [rewritten[0], ...fresh.map((s) => `- ${s}`), ...rewritten.slice(1)].filter(Boolean) as string[];
  return [...lines.slice(0, idx + 1), ...ordered, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function proposeImprovement(skillId: string, actorId: string): Promise<string | null> {
  const skill = getSkill(skillId);
  if (!skill) throw new Error("Skill not found");
  const clusters = recurringFailures(2).filter((c) => c.skillId === skillId);
  if (!clusters.length) return null;
  const stats = skillStats(skillId);
  const totalFailures = clusters.reduce((a, c) => a + c.count, 0);
  const evidence = clusters.flatMap((c) => c.sampleTraceIds.slice(0, 4));
  const nextVersion = Math.max(...skill.versions.map((v: Row) => v.version)) + 1;
  const sampleTraces = all(`SELECT task, error_type, error_message, steps FROM traces WHERE id IN (${evidence.map(() => "?").join(",")})`, ...evidence);

  let title: string, issue: string, analysis: string, content: string, changelog: string, generator: string;
  const llm = await structured({
    system: "You improve reusable AI agent skills (SKILL.md files) based on evidence from failed executions. Make minimal, targeted, testable edits that address the observed root causes. Keep the frontmatter.",
    prompt: `Current skill (v${skill.active_version}):\n<skill>\n${skill.content}\n</skill>\n\nRecurring failure clusters:\n${clusters.map((c) => `- ${c.signature} — ${c.count} failures (${Math.round(c.share * 100)}% of runs)`).join("\n")}\n\nSample failed traces:\n${sampleTraces.map((t) => `- ${t.task}: ${t.error_type}: ${t.error_message}\n  steps: ${json<any[]>(t.steps, []).map((s) => `${s.type}:${s.name ?? ""}(${s.status ?? ""})`).join(" → ")}`).join("\n")}\n\nWrite the improved skill as version ${nextVersion}.`,
    schema: LlmProposal,
    effort: "medium",
  });
  if (llm) {
    ({ title, issue, analysis, changelog } = llm);
    content = bumpVersion(llm.proposed_content, nextVersion);
    generator = "claude";
  } else {
    const types = [...new Set(clusters.map((c) => c.errorType))];
    const steps = [...new Set(types.flatMap((t) => REMEDIATIONS[t]?.steps ?? []))];
    content = bumpVersion(insertSteps(skill.content, steps), nextVersion);
    const top = clusters[0];
    issue = top.errorType === "timeout" ? "Repeated timeouts" : top.signature.split(":")[0];
    title = `${skill.name}: fix ${clusters.length} recurring failure pattern${clusters.length > 1 ? "s" : ""}`;
    analysis =
      `${top.windowFailures} of the last ${top.windowRuns} executions failed with "${top.signature}". ` +
      `Across all history, ${totalFailures} failures fall into ${clusters.length} recurring cluster(s): ` +
      clusters.map((c) => `${c.errorType} ×${c.count}`).join(", ") + ". " +
      `Root cause: ${types.map((t) => REMEDIATIONS[t]?.rationale).filter(Boolean).join("; ")}. The current skill gives no guidance for any of these cases.`;
    changelog = `v${nextVersion}: ${types.map((t) => REMEDIATIONS[t] ? t.replace("_", " ") : null).filter(Boolean).join(", ")} handling`;
    generator = "rules";
  }
  const id = uid("prp");
  run(
    `INSERT INTO proposals(id, kind, skill_id, base_version, title, issue, analysis, proposed_content, evidence, stats, status, generator, created_at, created_by)
     VALUES (?, 'improve', ?,?,?,?,?,?,?,?, 'pending', ?,?,?)`,
    id, skillId, skill.active_version, title, issue, analysis, content, JSON.stringify({ clusters, traceIds: evidence, changelog, knowledge: relatedKnowledge(`${skill.name} ${clusters.map((c) => c.errorType.replace("_", " ")).join(" ")} failure fix`, actorId) }),
    JSON.stringify({ historicalRate: stats.rate, recentRate: stats.recentRate, runs: stats.runs, failures: totalFailures }), generator, now(), actorId,
  );
  return id;
}

function relatedKnowledge(query: string, userId: string) {
  const p = resolvePrincipal({ userId });
  if (!p) return [];
  return search(query, p, { limit: 3, sources: ["document", "meeting", "claude_code"] }).hits.map((h) => ({ docId: h.docId, title: h.title, sourceKind: h.sourceKind, snippet: h.text.slice(0, 260) }));
}

const REMEDIATION_QUERIES: Record<string, string> = {
  duplicate_charge: "idempotency key retry duplicate charge",
  timeout: "client timeout retry exponential backoff",
  rate_limited: "Retry-After rate limit 429",
  upstream_error: "retry transient 5xx errors",
  validation_error: "never retry 4xx validation errors",
};

/** Revise a proposal using the failures its own evaluation exposed, grounded in org knowledge. */
export async function refineProposal(proposalId: string, evalRun: { results: any[] }, actor: Principal) {
  const p = getProposal(proposalId);
  if (!p || p.kind !== "improve") throw new Error("Only improvement proposals can be refined");
  const failing = evalRun.results.filter((r) => r.candidate.status === "failure");
  if (!failing.length) return { changed: false, reason: "Candidate already passes every case" };
  const types = [...new Set(failing.map((r) => r.candidate.error_type as string))];
  // Ground the fix in what the organization already knows.
  const knowledge = types.flatMap((t) => (REMEDIATION_QUERIES[t] ? search(REMEDIATION_QUERIES[t], actor, { limit: 2, sources: ["document", "meeting"] }).hits : []))
    .filter((h, i, a) => a.findIndex((x) => x.docId === h.docId) === i)
    .slice(0, 3)
    .map((h) => ({ docId: h.docId, title: h.title, sourceKind: h.sourceKind, snippet: h.text.slice(0, 260) }));

  let content: string | null = null;
  let generator = "rules";
  const llm = await structured({
    system: "You revise an AI agent skill (SKILL.md) so it passes failing evaluation cases. Make the minimal edit. Keep frontmatter and version.",
    prompt: `<skill>\n${p.proposed_content}\n</skill>\n\nFailing evaluation cases:\n${failing.map((r) => `- ${r.case.label}: ${r.candidate.error_type}: ${r.candidate.error_message}`).join("\n")}\n\nRelevant organizational knowledge:\n${knowledge.map((k) => `- ${k.title}: ${k.snippet}`).join("\n")}`,
    schema: z.object({ proposed_content: z.string() }),
    effort: "medium",
  });
  if (llm) { content = llm.proposed_content; generator = "claude"; }
  else content = insertSteps(p.proposed_content, [...new Set(types.flatMap((t) => REMEDIATIONS[t]?.steps ?? []))]);
  if (content === p.proposed_content) return { changed: false, reason: "No remediation known for: " + types.join(", ") };

  const revisions = [...(p.evidence.revisions ?? []), { at: now(), reason: failing.map((r) => `${r.case.label} → ${r.candidate.outcome}`).join("; "), errorTypes: types, knowledge, generator }];
  const evidence = { ...p.evidence, revisions, knowledge: [...(p.evidence.knowledge ?? []), ...knowledge], changelog: `${p.evidence.changelog ?? p.title}; ${types.map((t) => t.replace("_", " ")).join(", ")} safety` };
  run("UPDATE proposals SET proposed_content = ?, evidence = ?, status = 'pending', eval_run_id = NULL WHERE id = ?", content, JSON.stringify(evidence), proposalId);
  return { changed: true, errorTypes: types, knowledge };
}

export function proposeNewSkills(actorId: string): string[] {
  const ids: string[] = [];
  for (const wf of repeatedWorkflows()) {
    const exists = get("SELECT id FROM proposals WHERE kind = 'new_skill' AND title = ? AND status IN ('pending','evaluated','approved')", `New skill: ${wf.sequence}`);
    if (exists) continue;
    const name = wf.steps.includes("git.diff") || wf.steps.some((s) => s.includes("changelog")) ? "Release Notes & PR Prep" : `Workflow: ${wf.steps.slice(0, 2).join(" + ")}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const content = `---\nname: ${slug}\ndescription: ${name} — mined from ${wf.support} repeated agent sessions that performed the same steps by hand.\nversion: 1\n---\n\n# ${name}\n\n## When to use\nUse when asked to: ${wf.exampleTasks.slice(0, 3).map((t) => `"${t}"`).join(", ")}.\n\n## Steps\n${wf.steps.map((s, i) => `${i + 1}. Run \`${s}\` and check its output before continuing.`).join("\n")}\n${wf.steps.length + 1}. Summarize what changed and link the PR.\n`;
    const id = uid("prp");
    run(
      `INSERT INTO proposals(id, kind, title, issue, analysis, proposed_content, proposed_name, evidence, stats, status, generator, created_at, created_by)
       VALUES (?, 'new_skill', ?,?,?,?,?,?,?, 'pending', 'rules', ?, ?)`,
      id, `New skill: ${wf.sequence}`, "Repeated manual workflow",
      `${wf.support} successful sessions performed the same ${wf.steps.length}-step tool sequence without any skill guiding them (${wf.sequence}). Capturing it as a skill makes it consistent and measurable.`,
      content, name, JSON.stringify({ traceIds: wf.traceIds, sequence: wf.steps, exampleTasks: wf.exampleTasks }), JSON.stringify({ support: wf.support }), now(), actorId,
    );
    ids.push(id);
  }
  return ids;
}

export function listProposals(status?: string) {
  const rows = status ? all("SELECT p.*, s.name skill_name, s.slug skill_slug FROM proposals p LEFT JOIN skills s ON s.id = p.skill_id WHERE p.status = ? ORDER BY created_at DESC", status) : all("SELECT p.*, s.name skill_name, s.slug skill_slug FROM proposals p LEFT JOIN skills s ON s.id = p.skill_id ORDER BY created_at DESC");
  return rows.map((p) => ({ ...p, evidence: json(p.evidence, {}), stats: json(p.stats, {}) }));
}

export function getProposal(id: string) {
  const p = get("SELECT p.*, s.name skill_name, s.slug skill_slug FROM proposals p LEFT JOIN skills s ON s.id = p.skill_id WHERE p.id = ?", id);
  if (!p) return null;
  const base = p.skill_id ? get("SELECT content FROM skill_versions WHERE skill_id = ? AND version = ?", p.skill_id, p.base_version)?.content ?? "" : "";
  return { ...p, evidence: json(p.evidence, {}), stats: json(p.stats, {}), base_content: base, diff: lineDiff(base, p.proposed_content) };
}

export function decideProposal(id: string, decision: "approve" | "reject", actorId: string, note?: string) {
  const p = getProposal(id);
  if (!p) throw new Error("Proposal not found");
  if (!["pending", "evaluated"].includes(p.status)) throw new Error(`Proposal already ${p.status}`);
  const ts = now();
  if (decision === "reject") {
    run("UPDATE proposals SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?", actorId, ts, note ?? null, id);
    return { status: "rejected" };
  }
  let skillId = p.skill_id;
  let version = 1;
  if (p.kind === "new_skill") {
    const slug = p.proposed_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    skillId = createSkill({ slug, name: p.proposed_name, description: p.analysis, category: "workflow", content: p.proposed_content, ownerId: actorId });
  } else {
    version = (get("SELECT MAX(version) v FROM skill_versions WHERE skill_id = ?", skillId)!.v ?? 0) + 1;
    run("INSERT INTO skill_versions(id, skill_id, version, content, changelog, created_by, created_at, proposal_id) VALUES (?,?,?,?,?,?,?,?)", uid("skv"), skillId, version, p.proposed_content, p.evidence?.changelog ?? p.title, actorId, ts, id);
    run("UPDATE skills SET active_version = ? WHERE id = ?", version, skillId);
  }
  run("UPDATE proposals SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?", actorId, ts, note ?? null, id);
  const synced = syncSkills();
  return { status: "approved", skillId, version, synced };
}

export function rollbackSkill(skillId: string, version: number) {
  const v = get("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?", skillId, version);
  if (!v) throw new Error("Version not found");
  run("UPDATE skills SET active_version = ? WHERE id = ?", version, skillId);
  return { skillId, version, synced: syncSkills() };
}

// ---------- sync to harnesses ----------
export interface SyncTarget { harness: "claude-code" | "codex"; dir: string }
export function syncTargets(): SyncTarget[] {
  // Relative targets resolve against CONTEXTLOOP_SYNC_ROOT (a writable dir on serverless hosts), else the repo root.
  const base = process.env.CONTEXTLOOP_SYNC_ROOT ?? ROOT;
  const expand = (d: string) => (d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : path.isAbsolute(d) ? d : path.join(base, d));
  return getSetting<SyncTarget[]>("sync.targets", [
    { harness: "claude-code", dir: "sync/claude-code/.claude/skills" },
    { harness: "codex", dir: "sync/codex/.codex/skills" },
  ]).map((t) => ({ ...t, dir: expand(t.dir) }));
}

/** Write the active version of every skill to each harness's skill directory. */
export function syncSkills() {
  const out: { harness: string; dir: string; skills: number }[] = [];
  const skills = all("SELECT s.*, v.content FROM skills s JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.active_version");
  for (const t of syncTargets()) {
    let n = 0;
    for (const s of skills) {
      if (!json<string[]>(s.harnesses, []).includes(t.harness)) continue;
      const dir = path.join(t.dir, s.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), s.content);
      n++;
    }
    if (t.harness === "codex") {
      // Codex reads AGENTS.md at the project root; keep an index of shared skills there.
      const root = path.dirname(path.dirname(t.dir));
      const rel = path.relative(root, t.dir).replace(/\\/g, "/");
      const idx = skills.filter((s) => json<string[]>(s.harnesses, []).includes("codex")).map((s) => `- **${s.name}** (v${s.active_version}): ${s.description} — see \`${rel}/${s.slug}/SKILL.md\``).join("\n");
      fs.writeFileSync(path.join(root, "AGENTS.md"), `# Shared team skills (synced by ContextLoop AI)\n\n${idx}\n`);
    }
    out.push({ harness: t.harness, dir: t.dir, skills: n });
  }
  run("UPDATE skills SET synced_at = ?", now());
  return out;
}

// ---------- live executions (production-like traffic through the real executor) ----------
export async function runLiveExecutions(skillIdOrSlug: string, n: number, userId: string) {
  const skill = getSkill(skillIdOrSlug);
  if (!skill) throw new Error("Skill not found");
  const { policy, compiler } = await compilePolicy(skill.content);
  const harnesses = ["claude-code", "codex"];
  const results = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const scenario = sampleScenario();
      const r = await executeTask(policy, scenario, { recoverAfter: Math.random() < 0.7 ? 1 : 2 });
      const tokensIn = 2400 + Math.round(Math.random() * 1600) + r.attempts * 300;
      const tokensOut = 500 + Math.round(Math.random() * 400);
      return recordTrace(
        {
          agent: "payments-agent", harness: harnesses[i % 2], skill: skill.slug, skill_version: skill.active_version,
          task: `Charge order #${(48000 + Math.floor(Math.random() * 999)).toString()} via PayFlow API`, status: r.status,
          error_type: r.error_type, error_message: r.error_message, latency_ms: r.latency_ms, tokens_in: tokensIn, tokens_out: tokensOut,
          steps: r.steps, project: "prj_alpha", ...({ fault: { scenario, recoverAfter: 1, live: true } } as any),
        },
        { origin: "live", userId },
      );
    }),
  );
  const rows = all(`SELECT status FROM traces WHERE id IN (${results.map(() => "?").join(",")})`, ...results);
  return { executed: n, succeeded: rows.filter((r) => r.status === "success").length, version: skill.active_version, compiler, traceIds: results };
}

export type { FailureCluster };
