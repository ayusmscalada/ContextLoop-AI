/**
 * Ingestion pipeline: raw file → data lake (immutable, byte-exact) → parse → dedupe →
 * chunk → extract knowledge → index. Each import is tracked with stage + stats.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { all, get, json, now, putRaw, run, tx, uid } from "../db.js";
import { audit, invalidateVisibility, type Principal } from "../auth.js";
import { chunkSegments, parseFile, segmentsToText, type SourceKind, type TraceInput } from "./parsers.js";
import { extractDocument, type ExtractionStats } from "../engine/extract.js";
import { indexDocument } from "../engine/search.js";
import { recordTrace } from "../engine/traces.js";

export interface IngestOptions {
  filename: string;
  sourceHint?: SourceKind;
  visibility?: "private" | "team" | "org";
  teamId?: string | null;
  projectId?: string | null;
  occurredAt?: string;
  origin?: string; // upload | cli | watcher | mcp | seed
  useLlm?: boolean;
}

const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const normalizeForHash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function shingles(text: string, k = 5): Set<number> {
  const w = text.toLowerCase().split(/\W+/).filter(Boolean);
  const out = new Set<number>();
  for (let i = 0; i + k <= w.length; i++) out.add(parseInt(sha(w.slice(i, i + k).join(" ")).slice(0, 8), 16));
  return out;
}
function jaccard(a: Set<number>, b: Set<number>) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface IngestResult {
  importId: string;
  detected: string;
  documents: { id: string; title: string; sourceKind: string; duplicateOf?: string; similarity?: number; chunks: number; extraction?: ExtractionStats; traces?: number; superseded?: number }[];
}

export async function ingestBuffer(buf: Buffer, p: Principal, o: IngestOptions): Promise<IngestResult> {
  const importId = uid("imp");
  const started = now();
  run("INSERT INTO imports(id, filename, status, stage, started_at, user_id, origin) VALUES (?,?,?,?,?,?,?)", importId, o.filename, "processing", "storing raw", started, p.user.id, o.origin ?? "upload");
  const stage = (s: string) => run("UPDATE imports SET stage = ? WHERE id = ?", s, importId);
  try {
    // 1. Raw first: byte-exact copy in the content-addressed object store (raw/<yyyy-mm>/<sha>.<ext>).
    const rawHash = sha(buf);
    const relRaw = `raw/${started.slice(0, 7)}/${rawHash.slice(0, 16)}${path.extname(o.filename) || ".bin"}`;
    putRaw(relRaw, buf);

    stage("parsing");
    const { docs: parsed, detected } = await parseFile(buf, o.filename, o.sourceHint);
    const result: IngestResult = { importId, detected, documents: [] };

    for (const pd of parsed) {
      const text = segmentsToText(pd.segments);
      if (!text.trim()) continue;
      stage(`deduplicating "${pd.title.slice(0, 40)}"`);
      const contentHash = sha(normalizeForHash(text));
      const exact = get("SELECT id FROM documents WHERE content_hash = ? AND duplicate_of IS NULL", contentHash);
      let duplicateOf: string | undefined = exact?.id;
      let similarity: number | undefined = exact ? 1 : undefined;
      // Versioned sources (a PR that later merges, an email thread with new replies) carry an
      // external_id: the new version supersedes the old one instead of being flagged a near-duplicate.
      const externalId: string | undefined = pd.metadata.external_id;
      if (!duplicateOf && !externalId && text.length > 400) {
        const sh = shingles(text);
        for (const d of all("SELECT id, text FROM documents WHERE source_kind = ? AND duplicate_of IS NULL", pd.sourceKind)) {
          const j = jaccard(sh, shingles(d.text));
          if (j >= 0.85) { duplicateOf = d.id; similarity = +j.toFixed(3); break; }
        }
      }
      const docId = uid("doc");
      const metadata: Record<string, any> = { ...pd.metadata, detected_format: detected, word_count: text.split(/\s+/).length, raw_sha256: rawHash };
      const chunks = duplicateOf ? [] : chunkSegments(pd.segments);
      let projectId = o.projectId ?? null;
      if (!projectId && pd.metadata.project_hint) projectId = get("SELECT id FROM projects WHERE lower(name) = lower(?)", pd.metadata.project_hint)?.id ?? null;
      tx(() => {
        run(
          `INSERT INTO documents(id, source_kind, title, filename, mime, content_hash, raw_path, text, metadata, project_id, owner_id, visibility, team_id, occurred_at, ingested_at, size_bytes, duplicate_of)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          docId, pd.sourceKind, pd.title, o.filename, metadata.format ?? null, contentHash, relRaw, text, JSON.stringify(metadata), projectId, p.user.id,
          o.visibility ?? "org", o.visibility === "team" ? o.teamId ?? null : null, o.occurredAt ?? pd.occurredAt ?? started, now(), buf.length, duplicateOf ?? null,
        );
        chunks.forEach((c, i) => run("INSERT INTO chunks(id, doc_id, idx, text, speaker) VALUES (?,?,?,?,?)", `${docId}_c${i}`, docId, i, c.text, c.speaker ?? null));
      });
      if (duplicateOf) {
        result.documents.push({ id: docId, title: pd.title, sourceKind: pd.sourceKind, duplicateOf, similarity, chunks: 0 });
        continue;
      }
      stage(`extracting knowledge from "${pd.title.slice(0, 40)}"`);
      const extraction = await extractDocument(docId, { useLlm: o.useLlm });
      stage("indexing");
      indexDocument(docId);
      let traceCount = 0;
      if (pd.traces?.length) {
        stage("recording agent traces");
        for (const t of pd.traces) { recordTrace(t as TraceInput, { origin: o.origin ?? "import", userId: p.user.id }); traceCount++; }
      }
      let superseded = 0;
      if (externalId) {
        superseded = Number(run("UPDATE documents SET duplicate_of = ? WHERE id != ? AND duplicate_of IS NULL AND json_extract(metadata, '$.external_id') = ?", docId, docId, externalId).changes);
      }
      result.documents.push({ id: docId, title: pd.title, sourceKind: pd.sourceKind, chunks: chunks.length, extraction, traces: traceCount || undefined, superseded: superseded || undefined });
    }
    invalidateVisibility();
    const stats = {
      documents: result.documents.filter((d) => !d.duplicateOf).length,
      duplicates: result.documents.filter((d) => d.duplicateOf).length,
      chunks: result.documents.reduce((a, d) => a + d.chunks, 0),
      entities: result.documents.reduce((a, d) => a + (d.extraction?.entities ?? 0), 0),
      claims: result.documents.reduce((a, d) => a + (d.extraction?.claims ?? 0), 0),
      conflicts: [...new Set(result.documents.flatMap((d) => d.extraction?.conflicts ?? []))],
      traces: result.documents.reduce((a, d) => a + (d.traces ?? 0), 0),
      llm: result.documents.some((d) => d.extraction?.llm),
    };
    const kinds = [...new Set(result.documents.map((d) => d.sourceKind))];
    run("UPDATE imports SET status = ?, stage = 'done', finished_at = ?, source_kind = ?, doc_ids = ?, stats = ? WHERE id = ?", stats.documents ? "completed" : stats.duplicates ? "duplicate" : "empty", now(), kinds.join(","), JSON.stringify(result.documents.map((d) => d.id)), JSON.stringify(stats), importId);
    for (const k of kinds) run("UPDATE sources SET last_sync_at = ? WHERE kind = ?", now(), k);
    audit(p, "data.import", o.filename, `${detected}: ${stats.documents} new doc(s), ${stats.duplicates} duplicate(s), ${stats.conflicts.length} conflict(s)`);
    return result;
  } catch (e: any) {
    run("UPDATE imports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", e?.message ?? String(e), now(), importId);
    throw e;
  }
}

export const listImports = (limit = 50) => all("SELECT i.*, u.name AS user_name FROM imports i LEFT JOIN users u ON u.id = i.user_id ORDER BY started_at DESC LIMIT ?", limit).map((i) => ({ ...i, stats: json(i.stats, null), doc_ids: json(i.doc_ids, []) }));
