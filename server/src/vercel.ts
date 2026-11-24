/**
 * Vercel Function entry point (bundled by scripts/build-vercel.mjs into
 * .vercel/output/functions/api.func/index.mjs).
 *
 * Vercel's filesystem is read-only except /tmp, so:
 *  - the demo database is seeded at BUILD time and shipped in ./seed-data
 *  - on a cold start it is copied to /tmp/contextloop (milliseconds), and the
 *    instance then reads/writes there for its lifetime.
 * Environment must be set before db.ts is imported, hence the dynamic import.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const FN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = (process.env.CONTEXTLOOP_DATA_DIR ??= "/tmp/contextloop");
process.env.CONTEXTLOOP_ROOT ??= FN_DIR; // sample-data/ is bundled next to the function
process.env.CONTEXTLOOP_SYNC_ROOT ??= DATA_DIR; // skill sync writes must land in /tmp

function hydrateFromBuildSeed() {
  if (fs.existsSync(path.join(DATA_DIR, "contextloop.db"))) return; // warm instance
  const seedDir = path.join(FN_DIR, "seed-data");
  if (!fs.existsSync(seedDir)) return; // no build seed → app seeds itself on first request
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.cpSync(seedDir, DATA_DIR, { recursive: true });
}

type Listener = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
let ready: Promise<Listener> | null = null;

async function init(): Promise<Listener> {
  const t0 = Date.now();
  hydrateFromBuildSeed();
  const { app, prepare } = await import("./app.ts");
  await prepare();
  const { getRequestListener } = await import("@hono/node-server");
  console.log(`[contextloop] cold start ready in ${Date.now() - t0} ms`);
  return getRequestListener(app.fetch);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const listener = await (ready ??= init());
    return await listener(req, res);
  } catch (e: any) {
    ready = null; // retry initialisation on the next request
    console.error("[contextloop] init failed", e);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: `Server initialisation failed: ${e?.message ?? e}` }));
  }
}
