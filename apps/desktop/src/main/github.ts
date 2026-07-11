import { repoPathFor } from "./git";
import { gh, gitSafe, gitShow } from "./git-exec";
import { looksBinary } from "./fs-util";
import type {
  PrChecks,
  PrComment,
  PrCommit,
  PrConversationResult,
  PrDiffResult,
  PrHeadShaResult,
  PrMeta,
  PrMetaResult,
  PrListResult,
  PrState,
  PrSummary,
  PrFileView,
} from "../shared-types";

/** Absolute cwd for the repo at `subPath` within a project, or null if none.
 *  Backed by git.ts's layout cache — no spawns in steady state, so every PR
 *  endpoint (and every per-file view) can afford to call it. */
const repoCwd = repoPathFor;

// Positive-only cache: a repo's GitHub slug only changes if its remote is
// repointed, which the app has no way to observe — and a stale slug merely
// 404s the conversation fetch until relaunch. Saves a gh spawn per timeline.
const slugCache = new Map<string, string>();

/** owner/name for the repo's GitHub remote, or null if it isn't on GitHub. */
async function repoSlug(cwd: string): Promise<string | null> {
  const cached = slugCache.get(cwd);
  if (cached) return cached;
  const r = await gh(cwd, [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  const slug = r.stdout.trim();
  if (!r.ok || !slug) return null;
  slugCache.set(cwd, slug);
  return slug;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

// ── gh JSON shapes (only the fields we read) ─────────────────────────────────
interface GhUser {
  login?: string;
  name?: string;
  is_bot?: boolean; // gh pr list/view author
  type?: string; // REST api user.type ("Bot" | "User")
}
interface GhRollupEntry {
  __typename?: string;
  state?: string; // StatusContext
  status?: string; // CheckRun
  conclusion?: string; // CheckRun
}
interface GhPrListItem {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author?: GhUser;
  updatedAt: string;
  url: string;
  statusCheckRollup?: GhRollupEntry[];
}

function normState(s: string): PrState {
  const up = s.toUpperCase();
  return up === "MERGED" || up === "CLOSED" ? up : "OPEN";
}

function rollupToChecks(rollup?: GhRollupEntry[]): PrChecks {
  if (!rollup || rollup.length === 0) return null;
  let pending = false;
  for (const e of rollup) {
    const state = (e.conclusion || e.state || "").toUpperCase();
    const status = (e.status || "").toUpperCase();
    if (state === "FAILURE" || state === "ERROR" || state === "TIMED_OUT") {
      return "failure";
    }
    if (!state || (status && status !== "COMPLETED") || state === "PENDING") {
      pending = true;
    }
  }
  return pending ? "pending" : "success";
}

/**
 * List a repo's pull requests (most-recently-updated first). Includes merged and
 * closed PRs so a branch's history is visible, not just its one open PR. Returns
 * `available: false` when the repo has no GitHub remote — the sidebar then shows
 * that repo as "no GitHub remote" rather than an error.
 */
export async function listPrs(
  encoded: string,
  subPath: string,
): Promise<PrListResult> {
  const cwd = await repoCwd(encoded, subPath);
  if (!cwd) return { available: false, prs: [] };

  const r = await gh(cwd, [
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    "50",
    "--json",
    "number,title,state,isDraft,headRefName,baseRefName,author,updatedAt,url,statusCheckRollup",
  ]);
  if (!r.ok) {
    // gh exits non-zero for "no GitHub remote" too — treat that as unavailable
    // rather than a hard error the user must dismiss.
    if (/no.*remote|not a github|could not determine/i.test(r.stderr)) {
      return { available: false, prs: [] };
    }
    return { available: false, prs: [], error: r.stderr };
  }

  const raw = parseJson<GhPrListItem[]>(r.stdout, []);
  const prs: PrSummary[] = raw.map((p) => ({
    number: p.number,
    title: p.title,
    state: normState(p.state),
    isDraft: p.isDraft,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    author: p.author?.login ?? p.author?.name ?? "ghost",
    authorIsBot: p.author?.is_bot ?? false,
    updatedAt: p.updatedAt,
    checks: rollupToChecks(p.statusCheckRollup),
    url: p.url,
  }));
  return { available: true, prs };
}

// ── PR detail ────────────────────────────────────────────────────────────────
interface GhPrView {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  isDraft: boolean;
  author?: GhUser;
  createdAt: string;
  mergedAt: string | null;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  commits?: {
    oid: string;
    messageHeadline: string;
    committedDate: string;
    authors?: GhUser[];
  }[];
}
interface GhIssueComment {
  id: number;
  user?: GhUser;
  body: string;
  created_at: string;
  html_url: string;
}
interface GhReview {
  id: number;
  user?: GhUser;
  body: string;
  state: string;
  submitted_at: string;
  html_url: string;
}
interface GhReviewComment {
  id: number;
  user?: GhUser;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  created_at: string;
  in_reply_to_id: number | null;
  html_url: string;
}

function authorLogin(u?: GhUser): string {
  return u?.login ?? u?.name ?? "ghost";
}
function authorIsBot(u?: GhUser): boolean {
  return u?.type === "Bot" || u?.is_bot === true;
}

/**
 * The PR "shell" — header fields, description body, and commit list — from a
 * single `gh pr view`. This is the fast section: no pagination, no diff, no
 * network ref-fetch, so the PR view can paint its header and description the
 * moment this returns, without waiting on the conversation or diff.
 */
export async function getPrMeta(
  encoded: string,
  subPath: string,
  number: number,
): Promise<PrMetaResult> {
  const cwd = await repoCwd(encoded, subPath);
  if (!cwd) return { ok: false, error: "Repo not found." };

  const r = await gh(cwd, [
    "pr",
    "view",
    String(number),
    "--json",
    "number,title,body,state,url,isDraft,author,createdAt,mergedAt,baseRefName,headRefName,additions,deletions,commits",
  ]);
  if (!r.ok) return { ok: false, error: r.stderr };
  const view = parseJson<GhPrView | null>(r.stdout, null);
  if (!view) return { ok: false, error: "Couldn't parse PR data." };

  const commits: PrCommit[] = (view.commits ?? []).map((c) => ({
    oid: c.oid,
    messageHeadline: c.messageHeadline,
    author: authorLogin(c.authors?.[0]),
    committedDate: c.committedDate,
  }));

  const meta: PrMeta = {
    number: view.number,
    title: view.title,
    body: view.body ?? "",
    state: normState(view.state),
    isDraft: view.isDraft,
    url: view.url,
    author: authorLogin(view.author),
    authorIsBot: authorIsBot(view.author),
    createdAt: view.createdAt,
    mergedAt: view.mergedAt,
    baseRefName: view.baseRefName,
    headRefName: view.headRefName,
    additions: view.additions,
    deletions: view.deletions,
    commits,
  };
  return { ok: true, meta };
}

/**
 * The PR conversation timeline: issue comments + reviews + inline review
 * comments, merged into one chronological stream. This is the slowest section —
 * three paginated REST endpoints — so it's its own call and never blocks the
 * header.
 *
 * The timeline pulls from the REST API rather than `gh pr view --json comments`
 * because only REST exposes `user.type` (reliable bot detection) and the inline
 * anchoring fields (path/line/diff_hunk) — no guessing from logins. Individual
 * endpoint failures degrade to an empty section (parseJson fallback) rather than
 * failing the whole timeline.
 */
export async function getPrConversation(
  encoded: string,
  subPath: string,
  number: number,
): Promise<PrConversationResult> {
  const cwd = await repoCwd(encoded, subPath);
  if (!cwd) return { ok: false, error: "Repo not found." };
  const slug = await repoSlug(cwd);
  if (!slug) return { ok: false, error: "This repo has no GitHub remote." };

  const [commentsR, reviewsR, reviewCommentsR] = await Promise.all([
    gh(cwd, ["api", `repos/${slug}/issues/${number}/comments`, "--paginate"]),
    gh(cwd, ["api", `repos/${slug}/pulls/${number}/reviews`, "--paginate"]),
    gh(cwd, ["api", `repos/${slug}/pulls/${number}/comments`, "--paginate"]),
  ]);

  const timeline: PrComment[] = [];

  for (const c of parseJson<GhIssueComment[]>(commentsR.stdout, [])) {
    timeline.push({
      kind: "comment",
      id: `c${c.id}`,
      author: authorLogin(c.user),
      authorIsBot: authorIsBot(c.user),
      body: c.body ?? "",
      createdAt: c.created_at,
      url: c.html_url,
    });
  }

  for (const rv of parseJson<GhReview[]>(reviewsR.stdout, [])) {
    // Skip empty "commented" review containers — their inline notes come through
    // the review-comments endpoint below, so the empty shell carries no info.
    const state = (rv.state || "").toUpperCase();
    if (!rv.body?.trim() && state === "COMMENTED") continue;
    timeline.push({
      kind: "review",
      id: `r${rv.id}`,
      author: authorLogin(rv.user),
      authorIsBot: authorIsBot(rv.user),
      body: rv.body ?? "",
      createdAt: rv.submitted_at,
      url: rv.html_url,
      reviewState: state,
    });
  }

  for (const rc of parseJson<GhReviewComment[]>(reviewCommentsR.stdout, [])) {
    timeline.push({
      kind: "review-comment",
      id: `rc${rc.id}`,
      author: authorLogin(rc.user),
      authorIsBot: authorIsBot(rc.user),
      body: rc.body ?? "",
      createdAt: rc.created_at,
      url: rc.html_url,
      path: rc.path,
      line: rc.line ?? rc.original_line ?? null,
      diffHunk: rc.diff_hunk,
      inReplyToId: rc.in_reply_to_id != null ? `rc${rc.in_reply_to_id}` : null,
    });
  }

  timeline.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ok: true, timeline };
}

/** The raw unified diff (`gh pr diff`). Its own call so a large diff doesn't
 * block the header or the conversation. */
export async function getPrDiff(
  encoded: string,
  subPath: string,
  number: number,
): Promise<PrDiffResult> {
  const cwd = await repoCwd(encoded, subPath);
  if (!cwd) return { ok: false, error: "Repo not found." };
  const r = await gh(cwd, ["pr", "diff", String(number)]);
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true, diff: r.stdout };
}

/** Resolve the PR head SHA (network `git fetch pull/N/head`). Its own call
 * because only the Files tab needs it — the default Conversation tab shouldn't
 * wait on a network round-trip. `headSha` is null offline / without access. */
export async function getPrHeadSha(
  encoded: string,
  subPath: string,
  number: number,
): Promise<PrHeadShaResult> {
  const cwd = await repoCwd(encoded, subPath);
  if (!cwd) return { ok: false, error: "Repo not found." };
  return { ok: true, headSha: await resolveHeadSha(cwd, number) };
}

/**
 * The PR head commit SHA — the "new" side of every file diff. We fetch
 * `refs/pull/N/head` (which GitHub keeps even for merged/closed PRs) so the head
 * tree is in the local object store and `git show <sha>:<path>` works offline.
 *
 * We deliberately do NOT resolve a base SHA: for a merged PR the base branch has
 * moved on and absorbed the head, so `merge-base(base, head)` degenerates to the
 * head and the "old" blob comes back identical to the new one — the bug where
 * every modified file rendered as "all unchanged". Instead the old side is
 * reconstructed in the renderer by reverse-applying the authoritative `gh pr
 * diff` to the head blob (see reconstructOldText). Returns null if the head ref
 * can't be fetched (offline / no access).
 */
async function resolveHeadSha(
  cwd: string,
  number: number,
): Promise<string | null> {
  const headFetch = await gitSafe(cwd, [
    "fetch",
    "origin",
    `pull/${number}/head`,
  ]);
  if (!headFetch.ok) return null;
  const headRev = await gitSafe(cwd, ["rev-parse", "FETCH_HEAD"]);
  return headRev.ok ? headRev.stdout.trim() || null : null;
}

/**
 * The PR head blob for one file — the "new" side fed to InteractiveDiff. The
 * "old" side is reconstructed in the renderer from the diff, so this is a single
 * local `git show` (no network, no per-file base resolution). Empty text for a
 * deleted file (no `newPath`), which reconstructs to a full deletion.
 */
export async function getPrFileView(
  encoded: string,
  subPath: string,
  headSha: string | null,
  newPath: string | null,
): Promise<PrFileView> {
  const cwd = await repoCwd(encoded, subPath);
  if (!cwd || !headSha || !newPath) return { text: "", binary: false };
  const text = await gitShow(cwd, headSha, newPath);
  return { text, binary: looksBinary(text) };
}
