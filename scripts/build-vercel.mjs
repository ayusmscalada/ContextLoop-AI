/**
 * Builds a Vercel deployment using the Build Output API v3 (https://vercel.com/docs/build-output-api/v3):
 *
 *   .vercel/output/
 *     config.json                 routing: /api/* → function, static files, SPA fallback
 *     static/                     built web UI (web/dist)
 *     functions/api.func/
 *       index.mjs                 bundled API (server/src/vercel.ts + all deps)
 *       .vc-config.json           Node runtime config
 *       seed-data/                demo database + raw lake, seeded at build time
 *       sample-data/corpus/       source files, so "Reset demo data" works at runtime
 *
 * Run by Vercel via `npm run vercel-build` (see vercel.json); also runnable locally.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".vercel", "output");
const FN = path.join(OUT, "functions", "api.func");
const SEED_DIR = path.join(ROOT, ".vercel", "build-seed");
const step = (s) => console.log(`\n▸ ${s}`);
const sh = (cmd, env = {}) => execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(SEED_DIR, { recursive: true, force: true });
fs.mkdirSync(FN, { recursive: true });

step("Building web UI");
sh("npm --prefix web run build");
fs.cpSync(path.join(ROOT, "web", "dist"), path.join(OUT, "static"), { recursive: true });

step("Seeding demo database (real ingestion + real skill executions)");
sh("npx tsx server/src/seed.ts", { CONTEXTLOOP_DATA_DIR: SEED_DIR, CONTEXTLOOP_SYNC_ROOT: SEED_DIR });
// Fold the WAL into the main file so the shipped database is a single self-contained file.
const db = new DatabaseSync(path.join(SEED_DIR, "contextloop.db"));
db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
db.close();
for (const f of ["contextloop.db-wal", "contextloop.db-shm"]) fs.rmSync(path.join(SEED_DIR, f), { force: true });
fs.cpSync(SEED_DIR, path.join(FN, "seed-data"), { recursive: true });
fs.cpSync(path.join(ROOT, "sample-data", "corpus"), path.join(FN, "sample-data", "corpus"), { recursive: true });

step("Bundling API function");
await esbuild.build({
  entryPoints: [path.join(ROOT, "server", "src", "vercel.ts")],
  outfile: path.join(FN, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __clCreateRequire } from 'node:module'; const require = __clCreateRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});

fs.writeFileSync(
  path.join(FN, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 60 }, null, 2),
);

fs.writeFileSync(
  path.join(OUT, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/api(?:/.*)?$", dest: "/api" },
        { src: "^/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
        { handle: "filesystem" },
        { src: "^/(.*)$", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
step(`Done: .vercel/output (function ${(size(FN) / 1e6).toFixed(1)} MB, static ${(size(path.join(OUT, "static")) / 1e6).toFixed(1)} MB)`);
