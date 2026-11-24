export const SOURCE_META: Record<string, { label: string; short: string; color: string }> = {
  chatgpt: { label: "ChatGPT", short: "GPT", color: "var(--s3)" },
  claude_code: { label: "Claude Code", short: "CC", color: "var(--s2)" },
  codex: { label: "Codex", short: "CX", color: "var(--s1)" },
  meeting: { label: "Meeting", short: "MT", color: "var(--s7)" },
  document: { label: "Document", short: "DOC", color: "var(--s5)" },
  agent_trace: { label: "Agent trace", short: "TR", color: "var(--s4)" },
  email: { label: "Email", short: "@", color: "var(--s6)" },
  github: { label: "GitHub", short: "GH", color: "var(--s8)" },
};
export const SOURCE_ORDER = ["chatgpt", "claude_code", "codex", "meeting", "document", "agent_trace", "email", "github"];

/** Entity types → fixed categorical slots (color follows the entity type, never rank). */
export const ENTITY_META: Record<string, { label: string; color: string }> = {
  project: { label: "Project", color: "var(--s1)" },
  person: { label: "Person", color: "var(--s2)" },
  customer: { label: "Customer", color: "var(--s3)" },
  technology: { label: "Technology", color: "var(--s4)" },
  issue: { label: "Issue", color: "var(--s8)" },
  decision: { label: "Decision", color: "var(--s7)" },
  task: { label: "Task", color: "var(--s5)" },
  team: { label: "Team", color: "var(--s6)" },
};
export const ENTITY_ORDER = ["project", "person", "customer", "technology", "issue", "decision", "task"];

/** Resolve a CSS var (e.g. "var(--s1)") to its computed color, for canvas libs like cytoscape. */
export function cssColor(v: string): string {
  const m = v.match(/var\((--[\w-]+)\)/);
  if (!m) return v;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || "#888";
}

export const pct = (v: number | null | undefined, digits = 0) => (v == null || isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`);
export const num = (v: number | null | undefined) => (v == null ? "—" : Intl.NumberFormat("en-US", { notation: v >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(v));
export const usd = (v: number | null | undefined) => (v == null ? "—" : `$${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString()}`);
export const ms = (v: number | null | undefined) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
export const bytes = (v: number | null | undefined) => {
  if (v == null) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
};
// Calendar dates (document dates, deadlines) are stored as UTC midnight — render them in UTC so they never shift a day.
export const date = (v?: string | null) => (v ? new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
export const dateTime = (v?: string | null) => (v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
export const fmtValue = (predicate: string, v: string) => (predicate === "deadline" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? date(v + "T12:00:00Z") : v);
export function ago(v?: string | null) {
  if (!v) return "—";
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return date(v);
}
