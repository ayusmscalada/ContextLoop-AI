import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUp, Brain, Clock, Cpu, Filter, Gauge, History, MessageSquarePlus, Search as SearchIcon, Sparkles, WifiOff, Zap } from "lucide-react";
import { api, post, useApi } from "../lib/api";
import { ago, date, num, SOURCE_META, SOURCE_ORDER } from "../lib/format";
import { Badge, Button, Card, CardTitle, cx, Empty, EntityBadge, ErrorBox, Input, Markdown, PageHeader, Select, SourceBadge, Spinner, Tabs } from "../components/ui";

const STARTERS = [
  "Why did the Project Alpha payment integration fail, and how did we resolve it?",
  "When does Project Alpha launch?",
  "How should agents run database migrations without lock contention?",
  "What is Project Falcon?",
];

interface Filters { projectId: string; sources: string[]; from: string; to: string }
const emptyFilters: Filters = { projectId: "", sources: [], from: "", to: "" };

interface Citation { n: number; docId: string; chunkId: string; title: string; sourceKind: string; occurredAt: string | null; snippet: string }
interface Msg { role: "user" | "assistant"; content: string; meta?: { citations: Citation[]; related: any[]; retrievalMs: number; totalMs: number; mode: string; retrievalQuery?: string } | null }

export default function Search() {
  const [tab, setTab] = useState<"assistant" | "search">("assistant");
  return (
    <div>
      <PageHeader
        title="AI Search"
        subtitle="Ask the organization's accumulated memory — meetings, AI sessions, documents and decisions — and get evidence-backed answers. Every result respects your permissions."
      />
      <Tabs
        tabs={[
          { id: "assistant", label: <span className="inline-flex items-center gap-1.5"><Sparkles className="size-3.5" />Assistant</span> },
          { id: "search", label: <span className="inline-flex items-center gap-1.5"><SearchIcon className="size-3.5" />Hybrid search</span> },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "assistant" ? <Assistant /> : <RawSearch />}
    </div>
  );
}

// ---------------------------------------------------------------- filters
function FilterBar({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const { data: team } = useApi<any>("/team");
  const toggleSource = (s: string) => onChange({ ...value, sources: value.sources.includes(s) ? value.sources.filter((x) => x !== s) : [...value.sources, s] });
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Filter className="size-3.5 text-muted" />
      <Select value={value.projectId} onChange={(e) => onChange({ ...value, projectId: e.target.value })} className="h-8 text-xs">
        <option value="">All projects</option>
        {team?.projects?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      {SOURCE_ORDER.map((s) => (
        <button key={s} onClick={() => toggleSource(s)} className={cx("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 transition", value.sources.includes(s) ? "border-accent bg-accent-soft text-ink" : "border-line-strong text-ink-2 hover:bg-surface-2")}>
          <span className="size-2 rounded-full" style={{ background: SOURCE_META[s].color }} />
          {SOURCE_META[s].label}
        </button>
      ))}
      <Input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className="h-8 text-xs" aria-label="From date" />
      <span className="text-muted">→</span>
      <Input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className="h-8 text-xs" aria-label="To date" />
      {(value.projectId || value.sources.length || value.from || value.to) && (
        <button onClick={() => onChange(emptyFilters)} className="px-1 text-accent hover:underline">Clear</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- assistant
function Assistant() {
  const [threadId, setThreadId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [highlight, setHighlight] = useState<{ msg: number; n: number } | null>(null);
  const threads = useApi<any[]>("/threads");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); // newer browsers return a Promise here — don't hand it to React
  }, [messages.length, busy]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", content: question }]);
    setBusy(true);
    try {
      const f = { projectId: filters.projectId || undefined, sources: filters.sources.length ? filters.sources : undefined, from: filters.from || undefined, to: filters.to || undefined };
      const r = await post("/ask", { question, threadId, filters: f });
      setThreadId(r.threadId);
      setMessages((m) => [...m, { role: "assistant", content: r.answer, meta: { citations: r.citations, related: r.related, retrievalMs: r.retrievalMs, totalMs: r.totalMs, mode: r.mode, retrievalQuery: r.retrievalQuery } }]);
      threads.reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openThread = async (id: string) => {
    const t = await api(`/threads/${id}`);
    setThreadId(t.id);
    setMessages(t.messages.map((m: any) => ({ role: m.role, content: m.content, meta: m.meta })));
    setHighlight(null);
  };
  const newThread = () => { setThreadId(undefined); setMessages([]); setHighlight(null); };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); ask(input); };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
      <Card pad={false} className="flex min-h-[620px] flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Brain className="size-4 text-accent" /> Organizational AI Assistant
            {threadId && <Badge tone="accent">Conversation memory on</Badge>}
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant={showFilters ? "secondary" : "ghost"} icon={<Filter className="size-3.5" />} onClick={() => setShowFilters(!showFilters)}>Filters</Button>
            <Button size="sm" variant="ghost" icon={<MessageSquarePlus className="size-3.5" />} onClick={newThread}>New chat</Button>
          </div>
        </div>
        {showFilters && <div className="border-b border-line px-5 py-2.5"><FilterBar value={filters} onChange={setFilters} /></div>}

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {!messages.length && (
            <div className="mx-auto max-w-xl py-8 text-center">
              <div className="mx-auto mb-3 grid size-11 place-items-center rounded-xl bg-accent-soft text-accent"><Sparkles className="size-5" /></div>
              <div className="text-base font-semibold text-ink">Ask anything your team has worked on</div>
              <p className="mt-1 text-sm text-muted">Answers are grounded in captured sources and the knowledge graph, with citations you can open.</p>
              <div className="mt-5 grid gap-2 text-left sm:grid-cols-2">
                {STARTERS.map((s) => (
                  <button key={s} onClick={() => ask(s)} className="rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink-2 transition hover:border-accent hover:text-ink">{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white">{m.content}</div>
              </div>
            ) : (
              <AnswerBlock key={i} msg={m} highlight={highlight?.msg === i ? highlight.n : null} onCite={(n) => setHighlight({ msg: i, n })} />
            ),
          )}
          {busy && <div className="flex items-center gap-2 text-sm text-muted"><span className="size-2 animate-pulse rounded-full bg-accent" /> Searching organizational memory…</div>}
          <ErrorBox error={error} />
          <div ref={endRef} />
        </div>

        <form onSubmit={onSubmit} className="border-t border-line p-3">
          <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-surface px-3 py-2 focus-within:border-accent">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
              rows={1}
              placeholder={threadId ? "Ask a follow-up — e.g. “how did we fix it?”" : "Ask about decisions, incidents, deadlines, customers…"}
              className="max-h-32 min-h-6 flex-1 resize-none bg-transparent py-1 text-sm text-ink outline-none placeholder:text-muted"
            />
            <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!input.trim()} icon={<ArrowUp className="size-3.5" />} aria-label="Send" />
          </div>
        </form>
      </Card>

      <Card pad={false} className="h-fit">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold"><History className="size-4 text-muted" /> Past conversations</div>
        <div className="max-h-[560px] overflow-y-auto p-1.5">
          {threads.loading && !threads.data && <Spinner />}
          {threads.data && !threads.data.length && <div className="px-3 py-4 text-xs text-muted">No conversations yet.</div>}
          {threads.data?.map((t) => (
            <button key={t.id} onClick={() => openThread(t.id)} className={cx("w-full rounded-lg px-3 py-2 text-left hover:bg-surface-2", t.id === threadId && "bg-accent-soft")}>
              <div className="line-clamp-2 text-xs text-ink">{t.title}</div>
              <div className="mt-0.5 text-[11px] text-muted">{t.messages} messages · {ago(t.created_at)}</div>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function AnswerBlock({ msg, highlight, onCite }: { msg: Msg; highlight: number | null; onCite: (n: number) => void }) {
  const meta = msg.meta;
  const refs = useRef<Record<number, HTMLAnchorElement | null>>({});
  const cite = (n: number) => { onCite(n); refs.current[n]?.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        {meta?.mode === "claude" ? <Badge tone="accent"><Cpu className="size-3" />Claude</Badge> : <Badge><WifiOff className="size-3" />Extractive · offline</Badge>}
        {meta && <span className="inline-flex items-center gap-1"><Zap className="size-3" />retrieval {meta.retrievalMs} ms</span>}
        {meta && <span className="inline-flex items-center gap-1"><Clock className="size-3" />total {meta.totalMs} ms</span>}
        {meta?.retrievalQuery && <Badge tone="accent" className="max-w-full"><History className="size-3" /><span className="truncate">memory: resolved follow-up → “{meta.retrievalQuery}”</span></Badge>}
      </div>
      <div className="rounded-2xl rounded-tl-md border border-line bg-surface-2/60 px-4 py-3">
        <Markdown text={msg.content} onCite={cite} />
      </div>
      {!!meta?.citations?.length && (
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Supporting evidence</div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {meta.citations.map((c) => (
              <Link
                key={c.n}
                ref={(el) => { refs.current[c.n] = el; }}
                to={`/lake/${c.docId}`}
                className={cx("block rounded-lg border bg-surface p-2.5 transition hover:border-accent", highlight === c.n ? "border-accent ring-2 ring-accent/30" : "border-line")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent-soft px-1 text-[10px] font-semibold text-accent">{c.n}</span>
                  <SourceBadge kind={c.sourceKind} />
                  <span className="ml-auto text-[11px] text-muted">{date(c.occurredAt)}</span>
                </div>
                <div className="mt-1.5 line-clamp-1 text-xs font-medium text-ink">{c.title}</div>
                <div className="mt-1 line-clamp-3 text-[11px] leading-snug text-ink-2">{c.snippet}</div>
              </Link>
            ))}
          </div>
        </div>
      )}
      {!!meta?.related?.length && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Related knowledge</span>
          {meta.related.map((e: any) => (
            <Link key={e.id} to={`/graph/${e.id}`}><EntityBadge type={e.type} name={e.name} /></Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- raw hybrid search
function highlightTerms(text: string, terms: string[]): ReactNode {
  if (!terms.length) return text;
  const re = new RegExp(`\\b(?:${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\w*`, "gi");
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    out.push(<mark key={m.index} className="rounded bg-warning-soft px-0.5 text-ink">{m[0]}</mark>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function RawSearch() {
  const [q, setQ] = useState("payment timeout retry");
  const [mode, setMode] = useState<"hybrid" | "keyword" | "semantic">("hybrid");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ q, mode, limit: "15" });
      if (filters.projectId) qs.set("project", filters.projectId);
      if (filters.sources.length) qs.set("sources", filters.sources.join(","));
      if (filters.from) qs.set("from", filters.from);
      if (filters.to) qs.set("to", filters.to);
      setRes(await api(`/search?${qs}`));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [mode, filters]);

  const idx = res?.index;
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
      <div className="space-y-4">
        <Card className="space-y-3">
          <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sessions, meetings, documents, traces…" className="w-full pl-9" />
            </div>
            <div className="flex rounded-lg border border-line-strong p-0.5">
              {(["hybrid", "keyword", "semantic"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={cx("rounded-md px-3 text-xs font-medium capitalize", mode === m ? "bg-accent text-white" : "text-ink-2 hover:text-ink")}>{m}</button>
              ))}
            </div>
            <Button type="submit" variant="primary" busy={busy}>Search</Button>
          </form>
          <FilterBar value={filters} onChange={setFilters} />
        </Card>
        <ErrorBox error={error} />
        {res && (
          <div className="text-xs text-muted">
            {res.hits.length} results · {res.candidates} candidates scored in <span className="font-medium text-ink tabular">{res.ms} ms</span> · mode <span className="font-medium text-ink">{mode}</span>
          </div>
        )}
        {res && !res.hits.length && <Card><Empty title="No results" icon={<SearchIcon className="size-6" />}>Nothing matched in the sources you have access to. Try another mode or clear filters.</Empty></Card>}
        <div className="space-y-2.5">
          {res?.hits.map((h: any, i: number) => (
            <Card key={h.chunkId} className="!p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-xs font-semibold text-muted tabular">{i + 1}</span>
                <SourceBadge kind={h.sourceKind} />
                <Link to={`/lake/${h.docId}`} className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:text-accent">{h.title}</Link>
                <span className="text-[11px] text-muted">{date(h.occurredAt)}</span>
              </div>
              <p className="mt-2 line-clamp-4 whitespace-pre-line pl-7 text-xs leading-relaxed text-ink-2">{highlightTerms(h.text, h.matched)}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-3 pl-7 text-[11px] text-muted">
                <ScorePill label="BM25" value={h.bm25} max={Math.max(...res.hits.map((x: any) => x.bm25), 1)} color="var(--s1)" />
                <ScorePill label="Semantic" value={h.semantic} max={1} color="var(--s7)" />
                <span>fused <span className="font-medium text-ink tabular">{h.score.toFixed(4)}</span></span>
                {h.matched.length > 0 && <span>matched: {h.matched.map((t: string) => <code key={t} className="mx-0.5 rounded bg-code px-1 text-ink">{t}</code>)}</span>}
              </div>
            </Card>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <Card>
          <CardTitle sub="Measured server-side on every query"><span className="inline-flex items-center gap-1.5"><Gauge className="size-4 text-muted" />Search performance</span></CardTitle>
          <div className="space-y-3">
            <PerfRow label="This query" value={res ? `${res.ms} ms` : "—"} />
            <PerfRow label="Average query" value={idx?.queries ? `${(idx.totalQueryMs / idx.queries).toFixed(2)} ms` : "—"} />
            <PerfRow label="Queries served" value={num(idx?.queries)} />
            <PerfRow label="Candidates scored" value={num(res?.candidates)} />
            <div className="border-t border-line pt-3" />
            <PerfRow label="Indexed chunks" value={num(idx?.chunks)} />
            <PerfRow label="Indexed documents" value={num(idx?.docs)} />
            <PerfRow label="Vocabulary terms" value={num(idx?.terms)} />
            <PerfRow label="Index build" value={idx ? `${idx.buildMs} ms` : "—"} />
          </div>
        </Card>
        <Card>
          <CardTitle>How retrieval works</CardTitle>
          <ul className="space-y-2 text-xs leading-relaxed text-ink-2">
            <li><b className="text-ink">Keyword</b> — BM25 over normalized tokens with concept folding (fail/error/outage → one concept).</li>
            <li><b className="text-ink">Semantic</b> — 512-d local feature-hashing embeddings (unigrams, bigrams, char n-grams). Swappable for a hosted embedding model.</li>
            <li><b className="text-ink">Hybrid</b> — Reciprocal Rank Fusion of both rankings.</li>
            <li><b className="text-ink">Permissions</b> — results are filtered to documents your identity (or agent key) can read before ranking.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function ScorePill({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full" style={{ width: `${Math.min(1, value / (max || 1)) * 100}%`, background: color }} /></span>
      <span className="font-medium text-ink tabular">{value.toFixed(2)}</span>
    </span>
  );
}
const PerfRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex items-center justify-between text-sm"><span className="text-ink-2">{label}</span><span className="font-medium text-ink tabular">{value}</span></div>
);
