import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Plug, Database, Network, Sparkles, Bot, BookOpen, FlaskConical, Cable, Users, ScrollText, Settings, Moon, Sun, ChevronDown, Cpu, WifiOff,
} from "lucide-react";
import { getUserId, setUserId, useApi } from "../lib/api";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Overview", sub: "Organizational intelligence", icon: LayoutDashboard },
  { to: "/sources", label: "Data Sources", sub: "Connect & import", icon: Plug },
  { to: "/lake", label: "Data Lake", sub: "Raw sessions & traces", icon: Database },
  { to: "/graph", label: "Knowledge Graph", sub: "Entities & ontology", icon: Network },
  { to: "/search", label: "AI Search", sub: "Organizational memory", icon: Sparkles },
  { to: "/agents", label: "AI Agents", sub: "Traces & monitoring", icon: Bot },
  { to: "/skills", label: "Skill Library", sub: "Reusable capabilities", icon: BookOpen },
  { to: "/lab", label: "Improvement Lab", sub: "Self-improving skills", icon: FlaskConical, core: true },
  { to: "/integrations", label: "Integrations", sub: "MCP, CLI & agents", icon: Cable },
  { to: "/team", label: "Team & Permissions", sub: "Access control", icon: Users },
  { to: "/audit", label: "Audit Logs", sub: "Security history", icon: ScrollText },
  { to: "/settings", label: "Settings", sub: "Configuration", icon: Settings },
];

function useTheme() {
  const [theme, setTheme] = useState<string | null>(() => {
    try { return localStorage.getItem("contextloop.theme"); } catch { return null; }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try { theme ? localStorage.setItem("contextloop.theme", theme) : localStorage.removeItem("contextloop.theme"); } catch {}
  }, [theme]);
  const isDark = theme ? theme === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return { isDark, toggle: () => setTheme(isDark ? "light" : "dark") };
}

const initials = (n: string) => n.split(" ").map((x) => x[0]).join("").slice(0, 2);

export default function Layout() {
  const { data: me } = useApi<any>("/me");
  const { isDark, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const current = me?.users?.find((u: any) => u.id === getUserId()) ?? me?.users?.[0];

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col bg-sidebar text-white/80 max-md:hidden">
        <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
          <div className="grid size-8 place-items-center rounded-lg bg-[#6250d6]">
            <svg viewBox="0 0 32 32" className="size-5"><path d="M10 16a6 6 0 1 1 6 6" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" /><circle cx="16" cy="22" r="2.5" fill="white" /></svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-white">ContextLoop AI</div>
            <div className="text-[11px] text-white/50">Organizational Intelligence</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => cx("group flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition", isActive ? "bg-sidebar-2 text-white" : "hover:bg-sidebar-2/60 hover:text-white")}>
              <n.icon className="size-4 shrink-0 opacity-80" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-medium">
                  {n.label}
                  {n.core && <span className="rounded bg-[#6250d6] px-1 text-[9px] font-semibold uppercase tracking-wide text-white">Core</span>}
                </div>
                <div className="truncate text-[11px] text-white/40">{n.sub}</div>
              </div>
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-3 text-[11px] text-white/45">
          {me?.llm?.enabled ? (
            <span className="inline-flex items-center gap-1.5"><Cpu className="size-3" /> Claude · {me.llm.model}</span>
          ) : (
            <span className="inline-flex items-center gap-1.5" title="Set ANTHROPIC_API_KEY to enable Claude-powered extraction, answers and skill rewriting"><WifiOff className="size-3" /> Offline mode (deterministic engine)</span>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-6">
          <div className="text-xs text-muted">Northwind Labs · demo organization</div>
          <div className="flex items-center gap-2">
            <button onClick={toggle} className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Toggle theme">{isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
            <div className="relative">
              <button onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5 hover:bg-surface-2">
                {current && <span className="grid size-6 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ background: current.color }}>{initials(current.name)}</span>}
                <div className="text-left leading-tight">
                  <div className="text-xs font-medium text-ink">{current?.name ?? "…"}</div>
                  <div className="text-[10px] capitalize text-muted">{current?.role} · {current?.teams}</div>
                </div>
                <ChevronDown className="size-3.5 text-muted" />
              </button>
              {open && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                  <div className="absolute right-0 z-50 mt-1 w-72 rounded-xl border border-line bg-surface p-1.5 shadow-xl">
                    <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Act as (demo identity switch)</div>
                    {me?.users?.map((u: any) => (
                      <button key={u.id} onClick={() => { setUserId(u.id); setOpen(false); }} className={cx("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2", u.id === current?.id && "bg-accent-soft")}>
                        <span className="grid size-7 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ background: u.color }}>{initials(u.name)}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-ink">{u.name}</div>
                          <div className="truncate text-[11px] text-muted">{u.title} · <span className="capitalize">{u.role}</span> · {u.teams}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] px-6 py-6 max-sm:px-4">
            <Outlet key={current?.id} />
          </div>
        </main>
      </div>
    </div>
  );
}
