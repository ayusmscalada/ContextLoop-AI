/**
 * Ontology: typed entities + claims with provenance. Single-valued predicates
 * (deadline, owner, status, budget) are reconciled across sources: one value → current;
 * several → an open conflict with a scored, explainable proposal awaiting human review.
 */
import { all, get, json, now, run, uid, type Row } from "../db.ts";

export const ENTITY_TYPES = ["person", "project", "customer", "technology", "issue", "decision", "task", "team"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const SINGLE_VALUED = ["deadline", "owner", "status", "budget"] as const;

export const normKey = (s: string) => s.toLowerCase().replace(/^project\s+/, "project ").replace(/[^a-z0-9]+/g, " ").trim();

export function upsertEntity(type: EntityType, name: string, opts: { aliases?: string[]; description?: string; attributes?: Record<string, any> } = {}): string {
  const key = normKey(name);
  let e = get("SELECT * FROM entities WHERE type = ? AND key = ?", type, key);
  if (!e) {
    // alias match (e.g. "Maya" → "Maya Chen")
    const candidates = all("SELECT * FROM entities WHERE type = ?", type);
    e = candidates.find((c) => json<string[]>(c.aliases, []).some((a) => normKey(a) === key));
  }
  const ts = now();
  if (e) {
    const aliases = new Set(json<string[]>(e.aliases, []));
    let changed = false;
    for (const a of opts.aliases ?? []) if (!aliases.has(a) && normKey(a) !== e.key) { aliases.add(a); changed = true; }
    if (changed || (opts.description && !e.description)) {
      run("UPDATE entities SET aliases = ?, description = COALESCE(description, ?), updated_at = ? WHERE id = ?", JSON.stringify([...aliases]), opts.description ?? null, ts, e.id);
    }
    return e.id;
  }
  const id = uid("ent");
  run(
    "INSERT INTO entities(id, type, name, key, aliases, attributes, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, type, name.trim(), key, JSON.stringify(opts.aliases ?? []), JSON.stringify(opts.attributes ?? {}), opts.description ?? null, ts, ts,
  );
  run("INSERT INTO entity_history(id, entity_id, field, new_value, actor, note, at) VALUES (?,?,?,?,?,?,?)", uid("eh"), id, "created", name, "extractor", `Entity discovered (${type})`, ts);
  return id;
}

export function addMention(entityId: string, docId: string, chunkId: string | null, snippet: string) {
  run("INSERT OR IGNORE INTO mentions(entity_id, doc_id, chunk_id, snippet) VALUES (?,?,?,?)", entityId, docId, chunkId ?? "", snippet.slice(0, 400));
}

export function addRelation(src: string, dst: string, type: string, docId: string | null, confidence = 0.7, snippet = "") {
  if (src === dst) return;
  run("INSERT OR IGNORE INTO relations(id, src_id, dst_id, type, doc_id, confidence, snippet) VALUES (?,?,?,?,?,?,?)", uid("rel"), src, dst, type, docId, confidence, snippet.slice(0, 300));
}

export function sourceAuthority(kind: string): number {
  return get<{ weight: number }>("SELECT weight FROM source_authority WHERE source_kind = ?", kind)?.weight ?? 0.5;
}

export function addClaim(c: { entityId: string; predicate: string; value: string; docId: string; snippet: string; speaker?: string; observedAt?: string; confidence: number; sourceKind: string; meetingType?: string }) {
  const dup = get("SELECT id FROM claims WHERE entity_id = ? AND predicate = ? AND value = ? AND doc_id = ?", c.entityId, c.predicate, c.value, c.docId);
  if (dup) return dup.id as string;
  let authority = sourceAuthority(c.sourceKind);
  if (c.meetingType && /planning|steering|decision|leadership/i.test(c.meetingType)) authority = Math.min(1, authority + 0.05);
  // Speaker authority: the entity's recorded owner speaking about their own project.
  const ent = get("SELECT attributes FROM entities WHERE id = ?", c.entityId);
  const owner = json<Record<string, any>>(ent?.attributes, {}).owner?.value;
  if (owner && c.speaker && normKey(owner).startsWith(normKey(c.speaker).split(" ")[0])) authority = Math.min(1, authority + 0.05);
  const id = uid("clm");
  run(
    "INSERT INTO claims(id, entity_id, predicate, value, doc_id, snippet, speaker, observed_at, authority, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?)",
    id, c.entityId, c.predicate, c.value, c.docId, c.snippet.slice(0, 400), c.speaker ?? null, c.observedAt ?? now(), authority, c.confidence, now(),
  );
  return id;
}

function setAttribute(entityId: string, predicate: string, value: string, meta: Record<string, any>, actor: string, docId: string | null, note: string) {
  const e = get("SELECT attributes FROM entities WHERE id = ?", entityId)!;
  const attrs = json<Record<string, any>>(e.attributes, {});
  const old = attrs[predicate]?.value;
  attrs[predicate] = { value, ...meta };
  run("UPDATE entities SET attributes = ?, updated_at = ? WHERE id = ?", JSON.stringify(attrs), now(), entityId);
  if (old !== value || meta.status === "conflict") {
    run("INSERT INTO entity_history(id, entity_id, field, old_value, new_value, doc_id, actor, note, at) VALUES (?,?,?,?,?,?,?,?,?)", uid("eh"), entityId, predicate, old ?? null, value, docId, actor, note, now());
  }
}

interface Scored { claim: Row; score: number; parts: { authority: number; recency: number; explicitness: number } }

export function scoreClaims(claims: Row[]): Scored[] {
  const times = claims.map((c) => new Date(c.observed_at).getTime());
  const min = Math.min(...times), max = Math.max(...times);
  return claims
    .map((c, i) => {
      const recency = max === min ? 1 : (times[i] - min) / (max - min);
      const parts = { authority: c.authority ?? 0.5, recency, explicitness: c.confidence ?? 0.6 };
      return { claim: c, parts, score: +(parts.authority * 0.4 + parts.recency * 0.4 + parts.explicitness * 0.2).toFixed(3) };
    })
    .sort((a, b) => b.score - a.score);
}

const fmtVal = (predicate: string, v: string) => (predicate === "deadline" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : v);

/** Re-evaluate a predicate for an entity after new claims arrive. */
export function reconcile(entityId: string, predicate: string): { conflictId?: string } {
  const claims = all("SELECT c.*, d.title AS doc_title, d.source_kind FROM claims c LEFT JOIN documents d ON d.id = c.doc_id WHERE c.entity_id = ? AND c.predicate = ? AND c.status != 'rejected'", entityId, predicate);
  if (!claims.length) return {};
  if (!(SINGLE_VALUED as readonly string[]).includes(predicate)) {
    for (const c of claims) run("UPDATE claims SET status = 'current' WHERE id = ?", c.id);
    return {};
  }
  const resolved = get("SELECT * FROM conflicts WHERE entity_id = ? AND predicate = ? AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 1", entityId, predicate);
  const resolvedClaim = resolved ? claims.find((c) => c.id === resolved.resolved_claim_id) : undefined;
  // Claims observed after the last human resolution are "new information".
  const fresh = resolvedClaim ? claims.filter((c) => c.status === "active" && c.created_at > resolved!.resolved_at) : claims;
  const pool = resolvedClaim ? [resolvedClaim, ...fresh] : claims;
  const values = [...new Set(pool.map((c) => c.value))];

  if (values.length === 1) {
    const best = scoreClaims(pool)[0].claim;
    for (const c of pool) run("UPDATE claims SET status = 'current' WHERE id = ?", c.id);
    setAttribute(entityId, predicate, best.value, { status: "current", claim_id: best.id, sources: pool.length }, "ontology", best.doc_id, `Confirmed by ${pool.length} source(s)`);
    run("UPDATE conflicts SET status = 'auto_resolved', resolved_at = ?, rationale = COALESCE(rationale,'') || ' Sources now agree.' WHERE entity_id = ? AND predicate = ? AND status = 'open'", now(), entityId, predicate);
    return {};
  }

  const scored = scoreClaims(pool);
  const top = scored[0];
  const runner = scored.find((s) => s.claim.value !== top.claim.value)!;
  const ent = get("SELECT name FROM entities WHERE id = ?", entityId)!;
  const later = new Date(top.claim.observed_at) > new Date(runner.claim.observed_at);
  const days = Math.round(Math.abs(new Date(top.claim.observed_at).getTime() - new Date(runner.claim.observed_at).getTime()) / 864e5);
  const explicit = /moved|pushed|slipp|changed|revised|now|confirmed|new date|instead/i.test(top.claim.snippet ?? "");
  const rationale =
    `${values.length} conflicting values for ${ent.name} → ${predicate}. Proposing ${fmtVal(predicate, top.claim.value)} ` +
    `from "${top.claim.doc_title}" (${top.claim.source_kind}, authority ${top.parts.authority.toFixed(2)}${top.claim.speaker ? `, stated by ${top.claim.speaker}` : ""})` +
    `${later ? `, ${days} day(s) more recent than "${runner.claim.doc_title}"` : ""}${explicit ? ", and it uses explicit change language" : ""}. ` +
    `${fmtVal(predicate, runner.claim.value)} is kept as evidence and will be marked superseded on approval.`;

  let conflict = get("SELECT * FROM conflicts WHERE entity_id = ? AND predicate = ? AND status = 'open'", entityId, predicate);
  const scoresJson = JSON.stringify(scored.map((s) => ({ claim_id: s.claim.id, value: s.claim.value, score: s.score, ...s.parts })));
  if (conflict) {
    run("UPDATE conflicts SET proposed_claim_id = ?, rationale = ?, scores = ? WHERE id = ?", top.claim.id, rationale, scoresJson, conflict.id);
  } else {
    const id = uid("cfl");
    run("INSERT INTO conflicts(id, entity_id, predicate, status, proposed_claim_id, rationale, scores, created_at) VALUES (?,?,?, 'open', ?,?,?,?)", id, entityId, predicate, top.claim.id, rationale, scoresJson, now());
    conflict = { id };
  }
  for (const c of pool) run("UPDATE claims SET status = 'active' WHERE id = ?", c.id);
  setAttribute(entityId, predicate, top.claim.value, { status: "conflict", claim_id: top.claim.id, conflict_id: conflict.id, alternatives: values.length - 1 }, "ontology", top.claim.doc_id, `Conflict detected: ${values.map((v) => fmtVal(predicate, v)).join(" vs ")}`);
  return { conflictId: conflict.id };
}

export function resolveConflict(conflictId: string, claimId: string, actor: string, note?: string) {
  const conflict = get("SELECT * FROM conflicts WHERE id = ?", conflictId);
  if (!conflict) throw new Error("Conflict not found");
  const chosen = get("SELECT * FROM claims WHERE id = ?", claimId);
  if (!chosen || chosen.entity_id !== conflict.entity_id) throw new Error("Claim does not belong to this conflict");
  const claims = all("SELECT * FROM claims WHERE entity_id = ? AND predicate = ? AND status != 'rejected'", conflict.entity_id, conflict.predicate);
  for (const c of claims) run("UPDATE claims SET status = ? WHERE id = ?", c.value === chosen.value ? "current" : "superseded", c.id);
  const ts = now();
  run("UPDATE conflicts SET status = 'resolved', resolved_claim_id = ?, resolved_by = ?, resolved_at = ?, rationale = rationale || ? WHERE id = ?", claimId, actor, ts, note ? ` Reviewer note: ${note}` : "", conflictId);
  setAttribute(conflict.entity_id, conflict.predicate, chosen.value, { status: "current", claim_id: chosen.id, reviewed_by: actor, reviewed_at: ts }, actor, chosen.doc_id, `Conflict resolved by ${actor}${note ? `: ${note}` : ""}`);
}

export function ensureDefaultAuthority() {
  const defaults: [string, number, string][] = [
    ["meeting", 0.9, "Decisions made by people in meetings"],
    ["document", 0.85, "Specs, plans and written docs"],
    ["claude_code", 0.6, "Claude Code sessions (implementation detail, not decisions)"],
    ["codex", 0.6, "Codex sessions and execution logs"],
    ["agent_trace", 0.5, "Agent execution traces"],
    ["chatgpt", 0.45, "ChatGPT conversations (exploratory)"],
  ];
  for (const [k, w, n] of defaults) run("INSERT OR IGNORE INTO source_authority(source_kind, weight, note) VALUES (?,?,?)", k, w, n);
}
