/**
 * Vercel entry: one serverless function handles every /api route (see api/index.ts + vercel.json).
 *
 *   cold start → restore the SQLite snapshot from Vercel Blob into /tmp (or seed the demo org
 *                on the very first boot) → build the search index
 *   request    → if another instance saved a newer snapshot, reload it (always before writes)
 *              → Hono app → after a successful write, save the snapshot back to Blob
 *
 * Requests are serialized per instance so a snapshot reload never swaps the database out
 * from under an in-flight request. (Demo-scale trade-off; production moves to Postgres.)
 */
import os from "node:os";
import path from "node:path";
import { refreshIfStale, restoreSnapshot, saveSnapshot } from "./persist.js";

// Must be set before ./db.js is imported (it opens the database at import time).
const DATA_DIR = (process.env.CONTEXTLOOP_DATA_DIR ??= path.join(os.tmpdir(), "contextloop")); // /tmp on Vercel
const DB_FILE = path.join(DATA_DIR, "contextloop.db");
process.env.CONTEXTLOOP_SYNC_ROOT ??= DATA_DIR; // skill sync writes land in a writable dir

type App = { fetch: (req: Request) => Response | Promise<Response> };
let ready: Promise<App> | null = null;

async function init(): Promise<App> {
  const t0 = Date.now();
  const restored = await restoreSnapshot(DB_FILE);
  const { app, prepare } = await import("./app.js");
  const { seeded } = await prepare();
  if (seeded) await saveSnapshot(); // first boot: persist the demo org so later instances start from it
  console.log(`[contextloop] ready in ${Date.now() - t0} ms (${restored ? "restored snapshot" : seeded ? "seeded demo org" : "existing data"})`);
  return app;
}

/** A newer snapshot was downloaded over the local file: reopen it and rebuild in-memory state. */
async function reloadFromSnapshot() {
  const { reopenDatabase } = await import("./db.js");
  const { invalidateProjectCache, invalidateVisibility } = await import("./auth.js");
  const { buildIndex } = await import("./engine/search.js");
  reopenDatabase();
  invalidateProjectCache();
  invalidateVisibility();
  buildIndex();
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let queue: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

/** Handles one /api request. vercel.json rewrites /api/<route> to /api/index?route=<route>. */
export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = url.searchParams.get("route");
  const isWrite = WRITE_METHODS.has(request.method);
  // Read the body up front so the request can be safely rebuilt for the original path.
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  if (route !== null) {
    url.searchParams.delete("route");
    url.pathname = `/api/${route.replace(/^\/+/, "")}`;
  }
  const rebuilt = new Request(url, { method: request.method, headers: request.headers, body });

  return serialized(async () => {
    try {
      const app = await (ready ??= init());
      let closed = false;
      const closeDb = async () => {
        closed = true;
        (await import("./db.js")).closeDatabase();
      };
      const refreshed = await refreshIfStale(DB_FILE, { force: isWrite, beforeReplace: closeDb });
      if (refreshed || closed) await reloadFromSnapshot(); // reopen even if the swap failed after closing
      const response = await app.fetch(rebuilt);
      if (isWrite && response.status < 400) await saveSnapshot();
      return response;
    } catch (e: any) {
      ready = null; // retry initialisation on the next request
      console.error("[contextloop] request failed", e);
      return Response.json({ error: `Server error: ${e?.message ?? e}` }, { status: 500 });
    }
  });
}
