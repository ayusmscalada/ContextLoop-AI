/** Shared chart primitives (Recharts). Palette + marks follow the dataviz method:
 *  fixed categorical order, thin marks, 4px rounded data-ends, recessive grid, hover tooltip by default. */
import type { ReactNode } from "react";

export const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];

export const axisProps = { tickLine: false, axisLine: { stroke: "var(--axis)" }, tick: { fill: "var(--muted)", fontSize: 11 } } as const;
export const gridProps = { stroke: "var(--grid)", strokeDasharray: "0", vertical: false } as const;

/** Tooltip content styled with text tokens (values never wear series color). */
export function ChartTooltip({ active, payload, label, format, labelFormat }: { active?: boolean; payload?: any[]; label?: any; format?: (v: any, name: string) => ReactNode; labelFormat?: (l: any) => ReactNode }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      {label != null && <div className="mb-1 font-medium text-ink">{labelFormat ? labelFormat(label) : label}</div>}
      {payload.map((p) => (
        <div key={p.dataKey ?? p.name} className="flex items-center gap-2 text-ink-2">
          <span className="size-2 rounded-sm" style={{ background: p.color ?? p.fill }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-4 font-medium text-ink tabular">{format ? format(p.value, p.name) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Legend rendered as HTML (identity never color-alone). */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
