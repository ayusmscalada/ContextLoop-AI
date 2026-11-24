import { useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import { AlertTriangle, CheckCircle2, Check, Copy, Info, Loader2, X, XCircle } from "lucide-react";
import { ENTITY_META, SOURCE_META } from "../lib/format";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------- layout ----------
export function PageHeader({ title, subtitle, actions, badge }: { title: string; subtitle?: ReactNode; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <div className={cx("rounded-xl border border-line bg-surface", pad && "p-5", className)}>{children}</div>;
}

export function CardTitle({ children, sub, right, className }: { children: ReactNode; sub?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx("mb-4 flex items-start justify-between gap-3", className)}>
      <div>
        <h3 className="text-sm font-semibold text-ink">{children}</h3>
        {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Stat({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: "good" | "critical" | "warning" }) {
  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs font-medium text-ink-2">
        <span>{label}</span>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div className={cx("tabular text-[28px] font-semibold leading-tight tracking-tight", tone === "good" ? "text-good-ink" : tone === "critical" ? "text-critical" : "text-ink")}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </Card>
  );
}

// ---------- controls ----------
type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "good";
export function Button({ variant = "secondary", size = "md", busy, icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; busy?: boolean; icon?: ReactNode }) {
  const v: Record<BtnVariant, string> = {
    primary: "bg-accent text-white hover:opacity-90 border-transparent",
    secondary: "bg-surface text-ink border-line-strong hover:bg-surface-2",
    ghost: "bg-transparent text-ink-2 border-transparent hover:bg-surface-2 hover:text-ink",
    danger: "bg-surface text-critical border-critical/40 hover:bg-critical-soft",
    good: "bg-good text-white border-transparent hover:opacity-90",
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx("inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-50", size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm", v[variant], className)}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={cx("h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-accent", className)} />
);
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx("h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent", className)}>
    {children}
  </select>
);
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-2">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cx("relative h-5 w-9 rounded-full transition", checked ? "bg-accent" : "bg-line-strong")}>
        <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      {label}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={cx("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition", value === t.id ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink")}>
          {t.label}
          {t.count != null && <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-ink-2 tabular">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- badges ----------
type Tone = "neutral" | "accent" | "good" | "warning" | "serious" | "critical";
export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  const t: Record<Tone, string> = {
    neutral: "bg-surface-2 text-ink-2 border-line",
    accent: "bg-accent-soft text-accent border-transparent",
    good: "bg-good-soft text-good-ink border-transparent",
    warning: "bg-warning-soft text-warning-ink border-transparent",
    serious: "bg-serious-soft text-ink border-transparent",
    critical: "bg-critical-soft text-critical border-transparent",
  };
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium", t[tone], className)}>{children}</span>;
}

/** Status is never color alone: icon + label. */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [Tone, ReactNode, string]> = {
    success: ["good", <CheckCircle2 className="size-3" />, "Success"],
    completed: ["good", <CheckCircle2 className="size-3" />, "Completed"],
    approved: ["good", <CheckCircle2 className="size-3" />, "Approved"],
    resolved: ["good", <CheckCircle2 className="size-3" />, "Resolved"],
    auto_resolved: ["good", <CheckCircle2 className="size-3" />, "Sources agree"],
    current: ["good", <CheckCircle2 className="size-3" />, "Current"],
    allowed: ["good", <CheckCircle2 className="size-3" />, "Allowed"],
    failure: ["critical", <XCircle className="size-3" />, "Failure"],
    failed: ["critical", <XCircle className="size-3" />, "Failed"],
    denied: ["critical", <XCircle className="size-3" />, "Denied"],
    rejected: ["neutral", <X className="size-3" />, "Rejected"],
    superseded: ["neutral", <X className="size-3" />, "Superseded"],
    open: ["warning", <AlertTriangle className="size-3" />, "Needs review"],
    conflict: ["warning", <AlertTriangle className="size-3" />, "Conflict"],
    pending: ["warning", <AlertTriangle className="size-3" />, "Pending review"],
    evaluated: ["accent", <Info className="size-3" />, "Evaluated"],
    active: ["neutral", <Info className="size-3" />, "Candidate"],
    duplicate: ["neutral", <Copy className="size-3" />, "Duplicate"],
    processing: ["accent", <Loader2 className="size-3 animate-spin" />, "Processing"],
  };
  const [tone, icon, label] = map[status] ?? ["neutral", null, status];
  return <Badge tone={tone}>{icon}{label}</Badge>;
}

export function SourceBadge({ kind, className }: { kind: string; className?: string }) {
  const m = SOURCE_META[kind] ?? { label: kind, color: "var(--muted)" };
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-2", className)}>
      <span className="size-2 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

export function EntityBadge({ type, name, onClick }: { type: string; name?: string; onClick?: () => void }) {
  const m = ENTITY_META[type] ?? { label: type, color: "var(--muted)" };
  const El: any = onClick ? "button" : "span";
  return (
    <El onClick={onClick} className={cx("inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs text-ink", onClick && "hover:border-accent")}>
      <span className="size-2 shrink-0 rounded-sm" style={{ background: m.color }} />
      <span className="truncate">{name ?? m.label}</span>
    </El>
  );
}

// ---------- feedback ----------
export const Spinner = ({ label }: { label?: string }) => (
  <div className="flex items-center gap-2 p-6 text-sm text-muted">
    <Loader2 className="size-4 animate-spin" /> {label ?? "Loading…"}
  </div>
);
export const ErrorBox = ({ error }: { error: string | null | undefined }) =>
  error ? (
    <div className="flex items-start gap-2 rounded-lg border border-critical/30 bg-critical-soft px-3 py-2 text-sm text-critical">
      <XCircle className="mt-0.5 size-4 shrink-0" /> <span>{error}</span>
    </div>
  ) : null;
export const Empty = ({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) => (
  <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
    {icon && <div className="text-muted">{icon}</div>}
    <div className="text-sm font-medium text-ink">{title}</div>
    {children && <div className="max-w-md text-sm text-muted">{children}</div>}
  </div>
);
export function Callout({ tone = "accent", icon, children }: { tone?: "accent" | "good" | "warning" | "critical"; icon?: ReactNode; children: ReactNode }) {
  const t = { accent: "bg-accent-soft border-accent/20", good: "bg-good-soft border-good/30", warning: "bg-warning-soft border-warning/40", critical: "bg-critical-soft border-critical/30" }[tone];
  return <div className={cx("flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm text-ink", t)}>{icon && <span className="mt-0.5 shrink-0">{icon}</span>}<div className="min-w-0">{children}</div></div>;
}

/** Thin horizontal meter (value 0..1). */
export function Meter({ value, color = "var(--s1)", className }: { value: number | null | undefined; color?: string; className?: string }) {
  return (
    <div className={cx("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%`, background: color }} />
    </div>
  );
}

// ---------- overlays ----------
export function Drawer({ open, onClose, title, children, width = 640 }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: number }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative flex h-full w-full flex-col border-l border-line bg-surface shadow-2xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 text-sm font-semibold text-ink">{title}</div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close"><X className="size-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="text-sm font-semibold">{title}</div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2"><X className="size-4" /></button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- code / text ----------
export function CodeBlock({ code, lang, maxHeight = 360 }: { code: string; lang?: string; maxHeight?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative rounded-lg border border-line bg-code">
      {lang && <div className="border-b border-line px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-muted">{lang}</div>}
      <button
        onClick={() => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        className="absolute right-2 top-2 rounded-md border border-line bg-surface p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
        aria-label="Copy"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre className="overflow-auto p-3 font-mono text-xs leading-relaxed text-ink" style={{ maxHeight }}>{code}</pre>
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Tiny markdown renderer for answers: **bold**, `code`, bullet lists, paragraphs, [n] citations. */
export function Markdown({ text, onCite }: { text: string; onCite?: (n: number) => void }) {
  const inline = (s: string, key: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g).filter(Boolean).map((part, i) => {
      if (part.startsWith("**")) return <strong key={key + i}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("`")) return <code key={key + i}>{part.slice(1, -1)}</code>;
      const c = part.match(/^\[(\d+)\]$/);
      if (c) return (
        <button key={key + i} onClick={() => onCite?.(+c[1])} className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent-soft px-1 align-text-top text-[10px] font-semibold text-accent hover:bg-accent hover:text-white">{c[1]}</button>
      );
      return <span key={key + i}>{part}</span>;
    });
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`ul${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l, `li${blocks.length}-${i}`)}</li>)}</ul>);
    list = [];
  };
  text.split("\n").forEach((line) => {
    const m = line.match(/^\s*[-*]\s+(.*)/);
    if (m) list.push(m[1]);
    else {
      flush();
      if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line, `p${blocks.length}`)}</p>);
    }
  });
  flush();
  return <div className="md text-sm leading-relaxed text-ink">{blocks}</div>;
}

/** Line diff (from server `lineDiff`). */
export function DiffView({ diff, className }: { diff: { op: "eq" | "add" | "del"; text: string }[]; className?: string }) {
  return (
    <div className={cx("overflow-auto rounded-lg border border-line bg-code font-mono text-xs leading-relaxed", className)}>
      {diff.map((d, i) => (
        <div key={i} className={cx("flex whitespace-pre-wrap px-3", d.op === "add" && "bg-good-soft", d.op === "del" && "bg-critical-soft")}>
          <span className={cx("w-4 shrink-0 select-none", d.op === "add" ? "text-good-ink" : d.op === "del" ? "text-critical" : "text-muted")}>{d.op === "add" ? "+" : d.op === "del" ? "−" : " "}</span>
          <span className={cx(d.op === "del" && "text-ink-2 line-through decoration-critical/40")}>{d.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

/** Simple table. */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto", className)}>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            {head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className, ...p }: { children?: ReactNode; className?: string; colSpan?: number }) => <td {...p} className={cx("px-3 py-2.5 align-middle", className)}>{children}</td>;
