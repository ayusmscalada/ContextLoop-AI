/**
 * GitHub ingestion. Accepts:
 *  - webhook payloads: push, pull_request, pull_request_review, pull_request_review_comment, issue_comment
 *  - `gh pr view/list --json …` output (camelCase) and REST API objects (snake_case) for PRs
 *  - REST commit lists (GET /repos/{o}/{r}/commits)
 * Each PR becomes one document keyed by `github:pr:<repo>#<n>`, so later events (synchronize,
 * merged, edited) supersede the earlier version instead of piling up near-duplicates.
 */
import type { ParsedDoc, Segment } from "./parsers.js";

type Obj = Record<string, any>;
const iso = (v: any) => (v ? new Date(v).toISOString() : undefined);
const login = (u: any) => u?.login ?? u?.name ?? u?.username ?? "unknown";
const person = (u: any) => (u?.name && /\s/.test(u.name) ? u.name : login(u)); // prefer a real name ("Ben Okafor") over a handle
const repoOf = (o: Obj) => o.repository?.full_name ?? o.base?.repo?.full_name ?? o.headRepository?.nameWithOwner ?? (typeof o.url === "string" ? o.url.match(/github\.com\/(?:repos\/)?([^/]+\/[^/]+)/)?.[1] : undefined) ?? "unknown/repo";

// ---------- detection ----------
const isPR = (o: Obj) => o && typeof o.number === "number" && typeof o.title === "string" && ("headRefName" in o || "head" in o || "mergedAt" in o || "merged_at" in o);
const isPush = (o: Obj) => o && typeof o.ref === "string" && Array.isArray(o.commits) && ("pusher" in o || "before" in o);
const isRestCommit = (o: Obj) => o && typeof o.sha === "string" && o.commit?.message !== undefined;
const isPREvent = (o: Obj) => o && o.pull_request && typeof o.action === "string";
const isIssueComment = (o: Obj) => o && o.comment && o.issue && typeof o.action === "string";

export function looksLikeGitHub(data: any): boolean {
  const items = Array.isArray(data) ? data : [data];
  return items.length > 0 && items.every((o) => isPR(o) || isPush(o) || isRestCommit(o) || isPREvent(o) || isIssueComment(o));
}

// ---------- normalizers ----------
function prDoc(pr: Obj, repo: string, extra: { action?: string; reviews?: Obj[]; comments?: Obj[]; event?: string } = {}): ParsedDoc {
  const author = person(pr.author ?? pr.user);
  const merged = pr.merged === true || !!pr.mergedAt || !!pr.merged_at || pr.state === "MERGED";
  const state = merged ? "merged" : String(pr.state ?? "open").toLowerCase();
  const head = pr.headRefName ?? pr.head?.ref;
  const base = pr.baseRefName ?? pr.base?.ref;
  const segments: Segment[] = [
    { speaker: author, role: "pr", at: iso(pr.createdAt ?? pr.created_at), text: `Pull request #${pr.number}: ${pr.title} (${state}; ${head ?? "?"} → ${base ?? "?"})\n${(pr.body ?? "").trim() || "(no description)"}` },
  ];
  const reviews = extra.reviews ?? pr.reviews ?? pr.latestReviews ?? [];
  for (const r of reviews) {
    const body = (r.body ?? "").trim();
    segments.push({ speaker: person(r.author ?? r.user), role: "review", at: iso(r.submittedAt ?? r.submitted_at), text: `Review (${String(r.state ?? "commented").toLowerCase()})${body ? `: ${body}` : ""}` });
  }
  const comments = extra.comments ?? (Array.isArray(pr.comments) ? pr.comments : []);
  for (const c of comments) if ((c.body ?? "").trim()) segments.push({ speaker: person(c.author ?? c.user), role: "comment", at: iso(c.createdAt ?? c.created_at), text: c.body.trim() });
  if (merged) segments.push({ speaker: person(pr.mergedBy ?? pr.merged_by) || author, role: "event", at: iso(pr.mergedAt ?? pr.merged_at), text: `Merged pull request #${pr.number} into ${base ?? "main"}.` });

  const files = (pr.files ?? []).map((f: Obj) => f.path ?? f.filename).filter(Boolean);
  return {
    sourceKind: "github",
    title: `PR #${pr.number}: ${pr.title}`,
    segments,
    occurredAt: iso(pr.createdAt ?? pr.created_at),
    metadata: {
      format: extra.event ? `github-webhook-${extra.event}` : "github-pr-json",
      repo,
      number: pr.number,
      state,
      action: extra.action,
      url: pr.url ?? pr.html_url,
      author,
      head_ref: head,
      base_ref: base,
      merged_at: iso(pr.mergedAt ?? pr.merged_at),
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changedFiles ?? pr.changed_files ?? (files.length || undefined),
      files: files.length ? files : undefined,
      labels: (pr.labels ?? []).map((l: Obj) => l.name ?? l),
      reviewers: [...new Set([...reviews.map((r: Obj) => person(r.author ?? r.user)), ...(pr.requested_reviewers ?? []).map(person)])],
      speakers: [...new Set(segments.map((s) => s.speaker).filter(Boolean))],
      external_id: `github:pr:${repo}#${pr.number}`,
    },
  };
}

function pushDoc(p: Obj): ParsedDoc {
  const repo = repoOf(p);
  const branch = String(p.ref).replace(/^refs\/heads\//, "");
  const segments: Segment[] = p.commits.map((c: Obj) => {
    const files = [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])];
    return { speaker: person(c.author), role: "commit", at: iso(c.timestamp), text: `${c.message}${files.length ? `\n[files: ${files.slice(0, 12).join(", ")}${files.length > 12 ? ", …" : ""}]` : ""}` };
  });
  return {
    sourceKind: "github",
    title: `Push to ${repo}@${branch}: ${p.commits.length} commit${p.commits.length === 1 ? "" : "s"}`,
    segments,
    occurredAt: iso(p.head_commit?.timestamp ?? p.commits[0]?.timestamp),
    metadata: {
      format: "github-webhook-push",
      repo,
      branch,
      before: p.before,
      after: p.after,
      pusher: p.pusher?.name ?? login(p.sender),
      commits: p.commits.map((c: Obj) => ({ id: String(c.id).slice(0, 7), author: person(c.author), message: String(c.message).split("\n")[0] })),
      compare: p.compare,
      forced: p.forced,
      speakers: [...new Set(segments.map((s) => s.speaker))],
      external_id: `github:push:${repo}:${p.after}`,
    },
  };
}

function commitsDoc(list: Obj[], repo: string): ParsedDoc {
  const segments: Segment[] = list.map((c) => ({ speaker: c.commit?.author?.name ?? login(c.author), role: "commit", at: iso(c.commit?.author?.date), text: c.commit.message }));
  return {
    sourceKind: "github",
    title: `${list.length} commits on ${repo}`,
    segments,
    occurredAt: segments.at(-1)?.at,
    metadata: { format: "github-rest-commits", repo, commits: list.map((c) => ({ id: c.sha.slice(0, 7), message: String(c.commit.message).split("\n")[0] })), speakers: [...new Set(segments.map((s) => s.speaker))], external_id: `github:commits:${repo}:${list[0]?.sha}` },
  };
}

/** Normalize one webhook/JSON payload (or an array of them) into documents. */
export function githubToDocs(data: any, eventHint?: string): ParsedDoc[] {
  const items: Obj[] = Array.isArray(data) ? data : [data];
  if (items.length && items.every(isRestCommit)) return [commitsDoc(items, repoOf(items[0]))];
  const docs: ParsedDoc[] = [];
  for (const o of items) {
    if (isPush(o)) docs.push(pushDoc(o));
    else if (isPREvent(o)) {
      const repo = repoOf(o);
      const event = eventHint ?? (o.review ? "pull_request_review" : o.comment ? "pull_request_review_comment" : "pull_request");
      if (o.review) {
        docs.push({
          sourceKind: "github",
          title: `Review on PR #${o.pull_request.number}: ${o.pull_request.title}`,
          segments: [{ speaker: person(o.review.user), role: "review", at: iso(o.review.submitted_at), text: `Review (${String(o.review.state).toLowerCase()}) on "${o.pull_request.title}"${o.review.body ? `: ${o.review.body}` : ""}` }],
          occurredAt: iso(o.review.submitted_at),
          metadata: { format: `github-webhook-${event}`, repo, number: o.pull_request.number, state: o.review.state, speakers: [person(o.review.user)], external_id: `github:review:${repo}#${o.pull_request.number}:${o.review.id}` },
        });
      } else if (o.comment) {
        docs.push({
          sourceKind: "github",
          title: `Comment on PR #${o.pull_request.number}: ${o.pull_request.title}`,
          segments: [{ speaker: person(o.comment.user), role: "comment", at: iso(o.comment.created_at), text: `${o.comment.path ? `[${o.comment.path}] ` : ""}${o.comment.body}` }],
          occurredAt: iso(o.comment.created_at),
          metadata: { format: `github-webhook-${event}`, repo, number: o.pull_request.number, speakers: [person(o.comment.user)], external_id: `github:comment:${repo}:${o.comment.id}` },
        });
      } else docs.push(prDoc(o.pull_request, repo, { action: o.action, event }));
    } else if (isIssueComment(o)) {
      const repo = repoOf(o);
      docs.push({
        sourceKind: "github",
        title: `Comment on #${o.issue.number}: ${o.issue.title}`,
        segments: [{ speaker: person(o.comment.user), role: "comment", at: iso(o.comment.created_at), text: o.comment.body }],
        occurredAt: iso(o.comment.created_at),
        metadata: { format: "github-webhook-issue_comment", repo, number: o.issue.number, speakers: [person(o.comment.user)], external_id: `github:comment:${repo}:${o.comment.id}` },
      });
    } else if (isPR(o)) docs.push(prDoc(o, repoOf(o)));
  }
  return docs;
}

/** Pull recent PRs (with reviews + comments embedded) and commits from the GitHub REST API. */
export async function fetchGitHubRepo(repo: string, opts: { token?: string; limit?: number } = {}): Promise<{ prs: Obj[]; commits: Obj[]; rateRemaining?: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repository must look like owner/name");
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "contextloop-ai", "x-github-api-version": "2022-11-28" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let rateRemaining: string | undefined;
  const gh = async (p: string) => {
    const res = await fetch(`https://api.github.com${p}`, { headers, signal: AbortSignal.timeout(15000) });
    rateRemaining = res.headers.get("x-ratelimit-remaining") ?? rateRemaining;
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${p}: ${(await res.json().catch(() => ({}))).message ?? res.statusText}`);
    return res.json();
  };
  const limit = Math.min(opts.limit ?? 10, 30);
  const list: Obj[] = await gh(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`);
  const prs = await Promise.all(
    list.map(async (pr) => {
      const [reviews, comments] = await Promise.all([
        gh(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=20`).catch(() => []),
        gh(`/repos/${repo}/issues/${pr.number}/comments?per_page=20`).catch(() => []),
      ]);
      return { ...pr, reviews, comments };
    }),
  );
  const commits: Obj[] = await gh(`/repos/${repo}/commits?per_page=${Math.min(limit * 2, 50)}`).catch(() => []);
  return { prs, commits, rateRemaining };
}
