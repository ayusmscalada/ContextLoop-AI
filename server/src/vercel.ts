/**
 * Vercel entry: one serverless function handles every /api route (see api/index.ts + vercel.json).
 *
 *   cold start → restore the SQLite snapshot from Vercel Blob into /tmp (or seed the demo org
 *                on the very first boot) → build the search index
 *   request    → Hono app → after a successful write, save the snapshot back to Blob
 */
import os from "node:os";
import path from "node:path";
import { restoreSnapshot, saveSnapshot } from "./persist.js";

// Must be set before ./db.js is imported (it opens the database at import time).
const DATA_DIR = (process.env.CONTEXTLOOP_DATA_DIR ??= path.join(os.tmpdir(), "contextloop")); // /tmp on Vercel
process.env.CONTEXTLOOP_SYNC_ROOT ??= DATA_DIR; // skill sync writes land in a writable dir

type App = { fetch: (req: Request) => Response | Promise<Response> };
let ready: Promise<App> | null = null;

async function init(): Promise<App> {
  const t0 = Date.now();
  const restored = await restoreSnapshot(path.join(DATA_DIR, "contextloop.db"));
  const { app, prepare } = await import("./app.js");
  const { seeded } = await prepare();
  if (seeded) await saveSnapshot(); // first boot: persist the demo org so later instances start from it
  console.log(`[contextloop] ready in ${Date.now() - t0} ms (${restored ? "restored snapshot" : seeded ? "seeded demo org" : "existing data"})`);
  return app;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Handles one /api request. vercel.json rewrites /api/<route> to /api/index?route=<route>. */
export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = url.searchParams.get("route");
  if (route !== null) {
    url.searchParams.delete("route");
    url.pathname = `/api/${route.replace(/^\/+/, "")}`;
    const hasBody = !["GET", "HEAD"].includes(request.method);
    request = new Request(url, { method: request.method, headers: request.headers, body: hasBody ? request.body : undefined, ...(hasBody ? { duplex: "half" } : {}) } as RequestInit);
  }
  try {
    const app = await (ready ??= init());
    const response = await app.fetch(request);
    if (WRITE_METHODS.has(request.method) && response.status < 400) await saveSnapshot();
    return response;
  } catch (e: any) {
    ready = null; // retry initialisation on the next request
    console.error("[contextloop] request failed", e);
    return Response.json({ error: `Server error: ${e?.message ?? e}` }, { status: 500 });
  }
}
