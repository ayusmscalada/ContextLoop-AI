import { all, get, json, now, run, type Row } from "./db.js";

export type Role = "admin" | "member" | "viewer";
export type Visibility = "private" | "team" | "org";

export interface Principal {
  kind: "user" | "agent";
  user: { id: string; name: string; role: Role; email: string };
  teamIds: string[];
  agent?: { key: string; name: string; scopes: string[]; maxVisibility: Visibility; allowedProjects: string[] | null };
}

export class Forbidden extends Error {
  status = 403;
}

/** Resolve the caller. Agents authenticate with `Authorization: Bearer clk_...`;
 *  the web demo identifies a human with `X-User-Id` (stand-in for a real session/SSO). */
export function resolvePrincipal(headers: { authorization?: string | null; userId?: string | null }): Principal | null {
  const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) {
    const key = get("SELECT * FROM api_keys WHERE key = ? AND revoked = 0", bearer);
    if (!key) return null;
    const user = get("SELECT * FROM users WHERE id = ?", key.user_id);
    if (!user) return null;
    run("UPDATE api_keys SET last_used_at = ? WHERE key = ?", now(), bearer);
    return {
      kind: "agent",
      user: pickUser(user),
      teamIds: teamsOf(user.id),
      agent: {
        key: bearer,
        name: key.name,
        scopes: json<string[]>(key.scopes, []),
        maxVisibility: key.max_visibility as Visibility,
        allowedProjects: json<string[] | null>(key.allowed_projects, null),
      },
    };
  }
  const uidHeader = headers.userId ?? "u_alice";
  const user = get("SELECT * FROM users WHERE id = ?", uidHeader);
  if (!user) return null;
  return { kind: "user", user: pickUser(user), teamIds: teamsOf(user.id) };
}

const pickUser = (u: Row) => ({ id: u.id, name: u.name, role: u.role as Role, email: u.email });
const teamsOf = (userId: string) =>
  all<{ team_id: string }>("SELECT team_id FROM team_members WHERE user_id = ?", userId).map((r) => r.team_id);

const visRank: Record<Visibility, number> = { org: 0, team: 1, private: 2 };

let projectCache: Map<string, Row> | null = null;
export const invalidateProjectCache = () => (projectCache = null);
function project(id: string | null | undefined) {
  if (!id) return undefined;
  if (!projectCache) projectCache = new Map(all("SELECT * FROM projects").map((p) => [p.id, p]));
  return projectCache.get(id);
}

/** Core policy: may this principal read this document?
 *  Effective access = the human's access ∩ the agent key's policy. */
export function canReadDoc(p: Principal, doc: Pick<Row, "visibility" | "owner_id" | "team_id" | "project_id">): boolean {
  const isAdmin = p.user.role === "admin";
  // Human layer
  if (doc.visibility === "private" && doc.owner_id !== p.user.id) return false;
  if (doc.visibility === "team" && !isAdmin && !(doc.team_id && p.teamIds.includes(doc.team_id))) return false;
  const proj = project(doc.project_id);
  if (proj?.restricted && !isAdmin && !(proj.team_id && p.teamIds.includes(proj.team_id))) return false;
  // Agent policy layer
  if (p.agent) {
    if (visRank[doc.visibility as Visibility] > visRank[p.agent.maxVisibility]) return false;
    if (proj?.restricted && p.agent.maxVisibility !== "private") return false; // restricted projects need an explicitly elevated agent
    if (p.agent.allowedProjects && doc.project_id && !p.agent.allowedProjects.includes(doc.project_id)) return false;
  }
  return true;
}

/** Ids of all documents visible to the principal (cached briefly per principal). */
const visCache = new Map<string, { at: number; ids: Set<string> }>();
export function visibleDocIds(p: Principal): Set<string> {
  const ck = `${p.user.id}|${p.agent?.key ?? ""}`;
  const hit = visCache.get(ck);
  if (hit && Date.now() - hit.at < 1500) return hit.ids;
  const docs = all("SELECT id, visibility, owner_id, team_id, project_id FROM documents WHERE duplicate_of IS NULL");
  const ids = new Set(docs.filter((d) => canReadDoc(p, d)).map((d) => d.id));
  visCache.set(ck, { at: Date.now(), ids });
  return ids;
}
export const invalidateVisibility = () => visCache.clear();

export function canSeeProject(p: Principal, projectId: string | null | undefined): boolean {
  const proj = project(projectId);
  if (!proj) return true;
  if (!proj.restricted) return !p.agent?.allowedProjects || p.agent.allowedProjects.includes(proj.id);
  return canReadDoc(p, { visibility: "org", owner_id: null, team_id: null, project_id: proj.id });
}

const ACTION_RULES: Record<string, { roles: Role[]; scope?: string }> = {
  "knowledge.read": { roles: ["admin", "member", "viewer"], scope: "knowledge:read" },
  "data.import": { roles: ["admin", "member"], scope: "data:write" },
  "knowledge.resolve": { roles: ["admin", "member"] },
  "skills.read": { roles: ["admin", "member", "viewer"], scope: "skills:read" },
  "skills.propose": { roles: ["admin", "member"], scope: "skills:propose" },
  "skills.approve": { roles: ["admin"] },
  "skills.evaluate": { roles: ["admin", "member"] },
  "traces.write": { roles: ["admin", "member"], scope: "traces:write" },
  "traces.read": { roles: ["admin", "member", "viewer"], scope: "traces:read" },
  "admin.manage": { roles: ["admin"] },
  "settings.write": { roles: ["admin"] },
};

export function can(p: Principal, action: string): boolean {
  const rule = ACTION_RULES[action];
  if (!rule) return false;
  if (!rule.roles.includes(p.user.role)) return false;
  if (p.agent) return !!rule.scope && p.agent.scopes.includes(rule.scope);
  return true;
}

export function requirePermission(p: Principal, action: string, resource = "") {
  if (!can(p, action)) {
    audit(p, action, resource, `Denied: ${p.agent ? `agent scope/role` : `role '${p.user.role}'`} lacks '${action}'`, "denied");
    throw new Forbidden(`'${actorName(p)}' is not permitted to perform ${action}`);
  }
}

export const actorName = (p: Principal) => (p.agent ? `${p.agent.name} (for ${p.user.name})` : p.user.name);

export function audit(p: Principal | null, action: string, resource: string, detail = "", outcome: "allowed" | "denied" = "allowed") {
  run(
    "INSERT INTO audit_logs(at, actor_type, actor_id, actor_name, action, resource, detail, outcome) VALUES (?,?,?,?,?,?,?,?)",
    now(),
    p ? p.kind : "system",
    p ? (p.agent ? p.agent.key.slice(0, 12) + "…" : p.user.id) : "system",
    p ? actorName(p) : "System",
    action,
    resource,
    detail,
    outcome,
  );
}
