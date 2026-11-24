#!/usr/bin/env node
// Thin launcher so `npx ctxloop …` / `npm link` work without a build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.join(here, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const r = spawnSync(process.execPath, [tsx, path.join(here, "..", "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
