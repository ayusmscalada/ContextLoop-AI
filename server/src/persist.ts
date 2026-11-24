/**
 * Snapshot persistence for serverless hosts.
 *
 * The whole platform state (ontology, traces, skills, chat, audit AND raw uploads) lives in
 * one SQLite file. On Vercel the filesystem is ephemeral, so:
 *   - cold start  → restoreSnapshot(): download the latest snapshot from Vercel Blob into /tmp
 *   - after every successful write request → saveSnapshot(): checkpoint WAL, upload the file
 *
 * Backends (first configured wins):
 *   BLOB_READ_WRITE_TOKEN     Vercel Blob (added automatically when a Blob store is connected)
 *   CONTEXTLOOP_SNAPSHOT_DIR  local directory (useful for testing the flow without Vercel)
 * With neither, persistence is off and the app behaves exactly as before.
 *
 * Note: this module must not import ./db.js at the top level — restore has to run before
 * the database file is opened.
 */
import fs from "node:fs";
import path from "node:path";
import { get, put } from "@vercel/blob";

const KEY = () => process.env.CONTEXTLOOP_BLOB_KEY ?? "contextloop/contextloop.db";
const blobToken = () => (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim();
const snapshotDir = () => (process.env.CONTEXTLOOP_SNAPSHOT_DIR ?? "").trim();

export type Backend = "vercel-blob" | "local-dir" | "off";
export const backend = (): Backend => (blobToken() ? "vercel-blob" : snapshotDir() ? "local-dir" : "off");

const state = {
  restoredFrom: null as null | "snapshot" | "empty",
  restoredAt: null as string | null,
  lastSavedAt: null as string | null,
  saves: 0,
  lastBytes: 0,
  lastError: null as string | null,
};
export const persistenceInfo = () => ({ backend: backend(), key: KEY(), ...state });

// Blob stores are created as private or public; try one and fall back to the other (same approach as the Portfolio project).
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

/** Download the latest snapshot to `dbPath` (if one exists). Call before opening the database. */
export async function restoreSnapshot(dbPath: string): Promise<boolean> {
  const b = backend();
  if (b === "off") return false;
  try {
    let buf: Buffer | null = null;
    if (b === "vercel-blob") {
      const res = await withAccess((a) => get(KEY(), { access: a, useCache: false }));
      if (res && res.statusCode === 200) buf = Buffer.from(await new Response(res.stream).arrayBuffer());
    } else {
      const f = path.join(snapshotDir(), path.basename(KEY()));
      if (fs.existsSync(f)) buf = fs.readFileSync(f);
    }
    state.restoredAt = new Date().toISOString();
    if (!buf) {
      state.restoredFrom = "empty";
      return false;
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(dbPath + s, { force: true });
    fs.writeFileSync(dbPath, buf);
    state.restoredFrom = "snapshot";
    state.lastBytes = buf.length;
    return true;
  } catch (e: any) {
    // Never block startup on storage: fall back to a fresh seed and report the problem in Settings.
    state.lastError = `restore failed: ${e?.message ?? e}`;
    console.error("[persist]", state.lastError);
    return false;
  }
}

let chain: Promise<void> = Promise.resolve();
/** Upload the current database. Calls are serialized so snapshots never interleave. */
export function saveSnapshot(): Promise<void> {
  if (backend() === "off") return Promise.resolve();
  chain = chain.then(doSave, doSave);
  return chain;
}

async function doSave() {
  try {
    const { db, DB_PATH } = await import("./db.js");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // fold the WAL into the main file before copying it
    const buf = fs.readFileSync(DB_PATH);
    if (backend() === "vercel-blob") {
      await withAccess((a) => put(KEY(), buf, { access: a, contentType: "application/vnd.sqlite3", addRandomSuffix: false, allowOverwrite: true }));
    } else {
      fs.mkdirSync(snapshotDir(), { recursive: true });
      const target = path.join(snapshotDir(), path.basename(KEY()));
      fs.writeFileSync(target + ".tmp", buf);
      fs.renameSync(target + ".tmp", target);
    }
    state.saves++;
    state.lastBytes = buf.length;
    state.lastSavedAt = new Date().toISOString();
    state.lastError = null;
  } catch (e: any) {
    state.lastError = `save failed: ${e?.message ?? e}`;
    console.error("[persist]", state.lastError);
  }
}
