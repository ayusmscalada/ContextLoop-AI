/**
 * ctxloop — ContextLoop CLI + background capture daemon.
 *
 *   ctxloop whoami
 *   ctxloop ask "Why did the Project Alpha payment integration fail?"
 *   ctxloop search "idempotency key" [--project prj_alpha] [--mode hybrid|keyword|semantic]
 *   ctxloop import <files...> [--visibility org|team|private] [--team t_engineering] [--project prj_alpha]
 *   ctxloop watch <dir...> [--settle 4]          # capture daemon: uploads new/changed sessions
 *   ctxloop skills list | show <slug> | pull [--harness claude-code|codex] [--dir ~/.claude/skills]
 *   ctxloop report <trace.json>
 *
 * Env: CONTEXTLOOP_URL (default http://localhost:8787), CONTEXTLOOP_API_KEY (agent key).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const BASE = (process.env.CONTEXTLOOP_URL ?? "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.CONTEXTLOOP_API_KEY ?? "clk_demo_alice_claude";
const usingDemoKey = !process.env.CONTEXTLOOP_API_KEY;

const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` };

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function api<T = any>(p: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${p}`, { ...init, headers: { authorization: `Bearer ${KEY}`, ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  } catch {
    throw new Error(`Cannot reach ContextLoop at ${BASE} — is the server running? (npm run dev)`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p));
const INGESTIBLE = /\.(jsonl|ndjson|json|md|markdown|txt|vtt|pdf)$/i;

async function uploadFiles(files: string[], flags: Record<string, string | true>, origin = "cli") {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([fs.readFileSync(f)]), path.basename(f));
  if (flags.visibility) form.append("visibility", String(flags.visibility));
  if (flags.team) form.append("teamId", String(flags.team));
  if (flags.project) form.append("projectId", String(flags.project));
  if (flags.source) form.append("sourceHint", String(flags.source));
  form.append("origin", origin);
  return api<{ results: any[] }>("/api/import", { method: "POST", body: form });
}

function printImport(results: any[]) {
  for (const r of results) {
    if (r.error) { console.log(`${c.red("✗")} ${r.filename}: ${r.error}`); continue; }
    for (const d of r.documents) {
      if (d.duplicateOf) console.log(`${c.yellow("≡")} ${d.title} ${c.dim(`duplicate of ${d.duplicateOf} (similarity ${d.similarity})`)}`);
      else console.log(`${c.green("✓")} ${d.title} ${c.dim(`[${r.detected}] ${d.chunks} chunks · ${d.extraction?.entities ?? 0} entities · ${d.extraction?.claims ?? 0} claims${d.extraction?.conflicts?.length ? ` · ${c.yellow(d.extraction.conflicts.length + " conflict(s)")}` : ""}${d.traces ? ` · ${d.traces} traces` : ""}`)}`);
    }
  }
}

async function watch(dirs: string[], flags: Record<string, string | true>) {
  const settleMs = Number(flags.settle ?? 4) * 1000;
  const stateFile = path.join(os.homedir(), ".contextloop-watcher.json");
  const state: Record<string, string> = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  const timers = new Map<string, NodeJS.Timeout>();
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));

  const consider = (file: string) => {
    if (!INGESTIBLE.test(file)) return;
    clearTimeout(timers.get(file));
    // Wait until the file stops changing (sessions are appended to while the agent runs).
    timers.set(file, setTimeout(async () => {
      timers.delete(file);
      if (!fs.existsSync(file)) return;
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (state[file] === hash) return;
      try {
        const r = await uploadFiles([file], flags, "watcher");
        state[file] = hash;
        save();
        process.stdout.write(`${c.dim(new Date().toLocaleTimeString())} `);
        printImport(r.results);
      } catch (e: any) {
        console.log(`${c.red("✗")} ${file}: ${e.message}`);
      }
    }, settleMs));
  };

  const walk = (d: string, out: string[] = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith(".git") && e.name !== "node_modules") walk(p, out);
      else if (e.isFile()) out.push(p);
    }
    return out;
  };

  for (const raw of dirs) {
    const dir = expand(raw);
    if (!fs.existsSync(dir)) { console.log(c.red(`Directory not found: ${dir}`)); continue; }
    const initial = walk(dir).filter((f) => INGESTIBLE.test(f));
    console.log(`${c.cyan("◉")} watching ${c.bold(dir)} ${c.dim(`(${initial.length} existing files; new/changed files upload after ${settleMs / 1000}s of quiet)`)}`);
    if (flags.backfill) initial.forEach(consider);
    else for (const f of initial) state[f] ??= crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    fs.watch(dir, { recursive: true }, (_evt, name) => name && consider(path.join(dir, name.toString())));
  }
  save();
  console.log(c.dim(`Sending to ${BASE}. Ctrl+C to stop.${flags.backfill ? "" : " (use --backfill to also import existing files)"}`));
  await new Promise(() => {});
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (usingDemoKey && cmd && cmd !== "help") console.error(c.dim(`(using demo key ${KEY}; set CONTEXTLOOP_API_KEY to use your own)`));

  switch (cmd) {
    case "whoami": {
      const r = await api("/api/me");
      const p = r.principal;
      console.log(`${c.bold(p.agent?.name ?? p.user.name)} acting for ${p.user.name} (${p.user.role})`);
      if (p.agent) console.log(c.dim(`scopes: ${p.agent.scopes.join(", ")} · max visibility: ${p.agent.maxVisibility}`));
      console.log(c.dim(`LLM: ${r.llm.enabled ? r.llm.model : "offline mode"}`));
      break;
    }
    case "ask": {
      const q = pos.join(" ");
      if (!q) throw new Error('Usage: ctxloop ask "<question>"');
      const r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: q, filters: flags.project ? { projectId: flags.project } : undefined }) });
      console.log(r.answer.replace(/\*\*(.+?)\*\*/g, (_: string, m: string) => c.bold(m)).replace(/\[(\d+)\]/g, (_: string, n: string) => c.cyan(`[${n}]`)));
      console.log(`\n${c.dim("Sources")}`);
      for (const ci of r.citations) console.log(`  ${c.cyan(`[${ci.n}]`)} ${ci.title} ${c.dim(`· ${ci.sourceKind} · ${ci.occurredAt?.slice(0, 10) ?? ""}`)}`);
      console.log(c.dim(`\n${r.mode} · retrieval ${r.retrievalMs} ms · total ${r.totalMs} ms`));
      break;
    }
    case "search": {
      const qs = new URLSearchParams({ q: pos.join(" "), limit: String(flags.limit ?? 8) });
      if (flags.project) qs.set("project", String(flags.project));
      if (flags.mode) qs.set("mode", String(flags.mode));
      if (flags.sources) qs.set("sources", String(flags.sources));
      const r = await api(`/api/search?${qs}`);
      console.log(c.dim(`${r.hits.length} results in ${r.ms} ms (${r.candidates} candidates, ${r.index.chunks} chunks indexed)\n`));
      r.hits.forEach((h: any, i: number) => {
        console.log(`${c.bold(`${i + 1}. ${h.title}`)} ${c.dim(`· ${h.sourceKind} · ${h.occurredAt?.slice(0, 10) ?? ""} · bm25 ${h.bm25} · sem ${h.semantic}`)}`);
        console.log(`   ${h.text.replace(/\s+/g, " ").slice(0, 220)}…\n`);
      });
      break;
    }
    case "import": {
      const files = pos.map(expand).flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(p, f)).filter((f) => INGESTIBLE.test(f)) : [p]));
      if (!files.length) throw new Error("Usage: ctxloop import <files or dirs...>");
      printImport((await uploadFiles(files, flags)).results);
      break;
    }
    case "watch":
      if (!pos.length) throw new Error("Usage: ctxloop watch <dir...>   e.g. ctxloop watch ~/.claude/projects ~/.codex/sessions");
      await watch(pos, flags);
      break;
    case "skills": {
      const sub = pos[0] ?? "list";
      if (sub === "list") {
        const r = await api("/api/skills");
        for (const s of r.skills) console.log(`${c.bold(s.slug.padEnd(22))} v${s.active_version}  ${s.stats.rate == null ? "  n/a" : `${Math.round(s.stats.rate * 100)}%`.padStart(4)} ${c.dim(`${s.stats.runs} runs · ${s.description}`)}`);
      } else if (sub === "show") {
        const s = await api(`/api/skills/${pos[1]}`);
        console.log(s.content);
      } else if (sub === "pull") {
        const harness = String(flags.harness ?? "claude-code");
        const dir = expand(String(flags.dir ?? (harness === "codex" ? "~/.codex/skills" : "./.claude/skills")));
        const r = await api("/api/skills");
        for (const s of r.skills) {
          const full = await api(`/api/skills/${s.slug}`);
          fs.mkdirSync(path.join(dir, s.slug), { recursive: true });
          fs.writeFileSync(path.join(dir, s.slug, "SKILL.md"), full.content);
          console.log(`${c.green("✓")} ${s.slug} v${s.active_version} → ${path.join(dir, s.slug, "SKILL.md")}`);
        }
      } else throw new Error("Usage: ctxloop skills list | show <slug> | pull [--harness claude-code|codex] [--dir <path>]");
      break;
    }
    case "report": {
      const data = JSON.parse(fs.readFileSync(expand(pos[0]), "utf8"));
      const r = await api("/api/traces", { method: "POST", body: JSON.stringify(data.executions ?? data) });
      console.log(`${c.green("✓")} recorded ${r.ids.length} execution(s)`);
      break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").match(/\/\*\*([\s\S]*?)\*\//)![1].replace(/^ \* ?/gm, "").trim());
  }
}

main().catch((e) => {
  console.error(c.red(`Error: ${e.message}`));
  process.exit(1);
});
