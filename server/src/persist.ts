/**
 * Snapshot persistence for serverless hosts.
 *
 * The whole platform state (ontology, traces, skills, chat, audit AND raw uploads) lives in
 * one SQLite file. On Vercel the filesystem is ephemeral and several function instances may
 * run at once, so:
 *   - cold start          → restoreSnapshot(): download the latest snapshot into /tmp
 *   - before each request → refreshIfStale(): cheap version check (etag); if another instance
 *                           saved something newer, download it (forced before every write)
 *   - after each write    → saveSnapshot(): checkpoint WAL, upload, remember the new version
 *
 * Backends (first configured wins):
 *   BLOB_READ_WRITE_TOKEN     Vercel Blob (added when a Blob store is connected to the project)
 *   CONTEXTLOOP_SNAPSHOT_DIR  local directory (to test the same flow without Vercel)
 * With neither, persistence is off: each instance keeps its own data in /tmp.
 *
 * This module must not import ./db.js at the top level — restore runs before the DB is opened.
 */
import fs from "node:fs";
import path from "node:path";
import { get, head, put } from "@vercel/blob";

const KEY = () => process.env.CONTEXTLOOP_BLOB_KEY ?? "contextloop/contextloop.db";
const blobToken = () => (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim();
const snapshotDir = () => (process.env.CONTEXTLOOP_SNAPSHOT_DIR ?? "").trim();
const localFile = () => path.join(snapshotDir(), path.basename(KEY()));

export type Backend = "vercel-blob" | "local-dir" | "off";
export const backend = (): Backend => (blobToken() ? "vercel-blob" : snapshotDir() ? "local-dir" : "off");

const state = {
  restoredFrom: null as null | "snapshot" | "empty",
  restoredAt: null as string | null,
  version: null as string | null, // etag (Blob) or mtime+size (local) of the snapshot this instance holds
  lastSavedAt: null as string | null,
  lastCheckedAt: 0,
  saves: 0,
  refreshes: 0,
  lastBytes: 0,
  lastError: null as string | null,
};
export const persistenceInfo = () => ({
  backend: backend(),
  key: KEY(),
  onVercel: !!process.env.VERCEL,
  restoredFrom: state.restoredFrom,
  restoredAt: state.restoredAt,
  lastSavedAt: state.lastSavedAt,
  saves: state.saves,
  refreshes: state.refreshes,
  lastBytes: state.lastBytes,
  lastError: state.lastError,
});

// Blob stores are private or public; try one and fall back to the other (same approach as the Portfolio project).
let access: "private" | "public" = (process.env.CONTEXTLOOP_BLOB_ACCESS as any) === "public" ? "public" : "private";
const isAccessError = (e: any) => /access|private|public/i.test(String(e?.message ?? ""));
async function withAccess<T>(fn: (a: "private" | "public") => Promise<T>): Promise<T> {
  try {
    return await fn(access);
  } catch (e) {
    if (!isAccessError(e)) throw e;
    access = access === "private" ? "public" : "private";
    return await fn(access);
  }
}
const isNotFound = (e: any) => /not.?found|does not exist|404/i.test(`${e?.name ?? ""} ${e?.message ?? ""}`);

/** Current remote version, or null if no snapshot exists yet. */
async function remoteVersion(): Promise<string | null> {
  if (backend() === "vercel-blob") {
    try {
      const h = await head(KEY());
      return h.etag || h.uploadedAt.toISOString();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  if (!fs.existsSync(localFile())) return null;
  const st = fs.statSync(localFile());
  return `${st.mtimeMs}:${st.size}`;
}

/** Download the snapshot into dbPath. Returns false if none exists. */
async function download(dbPath: string, beforeReplace?: () => void | Promise<void>): Promise<boolean> {
  let buf: Buffer | null = null;
  let version: string | null = null;
  if (backend() === "vercel-blob") {
    const res = await withAccess((a) => get(KEY(), { access: a, useCache: false }));
    if (res && res.statusCode === 200) {
      buf = Buffer.from(await new Response(res.stream).arrayBuffer());
      version = res.blob.etag || res.blob.uploadedAt.toISOString();
    }
  } else if (fs.existsSync(localFile())) {
    buf = fs.readFileSync(localFile());
    version = await remoteVersion();
  }
  if (!buf) return false;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath + ".download", buf);
  await beforeReplace?.(); // close the open connection first: never swap a SQLite file under a live handle
  for (const s of ["-wal", "-shm"]) fs.rmSync(dbPath + s, { force: true });
  fs.renameSync(dbPath + ".download", dbPath);
  state.version = version;
  state.lastBytes = buf.length;
  return true;
}

/** Cold start: download the latest snapshot (if any) before the database is opened. */
export async function restoreSnapshot(dbPath: string): Promise<boolean> {
  if (backend() === "off") return false;
  try {
    const ok = await download(dbPath);
    state.restoredAt = new Date().toISOString();
    state.restoredFrom = ok ? "snapshot" : "empty";
    state.lastCheckedAt = Date.now();
    return ok;
  } catch (e: any) {
    // Never block startup on storage: fall back to a fresh seed and report the problem.
    state.lastError = `restore failed: ${e?.message ?? e}`;
    console.error("[persist]", state.lastError);
    return false;
  }
}

/**
 * Warm instance: has another instance saved a newer snapshot? If so, download it over the
 * local file and return true (the caller must reopen the database). Reads are throttled;
 * writes pass force=true so they never build on a stale copy.
 */
export async function refreshIfStale(dbPath: string, opts: { force?: boolean; maxAgeMs?: number; beforeReplace?: () => void | Promise<void> } = {}): Promise<boolean> {
  if (backend() === "off") return false;
  if (!opts.force && Date.now() - state.lastCheckedAt < (opts.maxAgeMs ?? 3000)) return false;
  try {
    const remote = await remoteVersion();
    state.lastCheckedAt = Date.now();
    if (!remote || remote === state.version) return false;
    const ok = await download(dbPath, opts.beforeReplace);
    if (ok) state.refreshes++;
    return ok;
  } catch (e: any) {
    state.lastError = `refresh failed: ${e?.message ?? e}`;
    console.error("[persist]", state.lastError);
    return false;
  }
}

/** Upload the current database and remember the new version. */
export async function saveSnapshot(): Promise<void> {
  if (backend() === "off") return;
  try {
    const { db, DB_PATH } = await import("./db.js");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // fold the WAL into the main file before copying it
    const buf = fs.readFileSync(DB_PATH);
    if (backend() === "vercel-blob") {
      const r = await withAccess((a) => put(KEY(), buf, { access: a, contentType: "application/vnd.sqlite3", addRandomSuffix: false, allowOverwrite: true }));
      state.version = r.etag || null;
    } else {
      fs.mkdirSync(snapshotDir(), { recursive: true });
      fs.writeFileSync(localFile() + ".tmp", buf);
      fs.renameSync(localFile() + ".tmp", localFile());
      state.version = await remoteVersion();
    }
    state.saves++;
    state.lastBytes = buf.length;
    state.lastSavedAt = new Date().toISOString();
    state.lastCheckedAt = Date.now();
    state.lastError = null;
  } catch (e: any) {
    state.lastError = `save failed: ${e?.message ?? e}`;
    console.error("[persist]", state.lastError);
  }
}
