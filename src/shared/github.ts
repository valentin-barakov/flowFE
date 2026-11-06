// Pure GitHub helpers shared by main, the window, and the check script. No I/O.
import { ticketColumn, type TicketColumn } from "./jira.js";

/** `owner/name`. A pull request or issue URL is built only from a name that passes isRepoFullName. */
export const REPO_FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** A Projects (v2) node id, such as PVT_kwHOABCD. */
export const PROJECT_ID = /^PVT_[A-Za-z0-9_-]{1,190}$/;

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const MAX_SELECTED_REPOS = 30;
export const MAX_SELECTED_PROJECTS = 10;
export const PR_PAGE_SIZE = 50;
export const MAX_REPO_PAGES = 10;
export const ITEM_PAGE_SIZE = 50;
/** The Projects board keeps reading pages until it has this many items, or runs out of pages. */
export const ENOUGH_ITEMS = 25;
export const MAX_ITEM_PAGES = 4;

export type GithubTokenKind = "repos" | "projects";
export type GithubItemKind = "issue" | "pr";
export type ReviewState = "approved" | "changes" | "required";
export type CiState = "passing" | "failing" | "pending";

/** True for `owner/name`. The name part may not be `.` or `..`, so a URL cannot climb out of the repo path. */
export function isRepoFullName(value: string): boolean {
  if (!REPO_FULL_NAME.test(value)) return false;
  const name = value.slice(value.indexOf("/") + 1);
  return name !== "." && name !== "..";
}

/** The browser URL for one pull request or issue, or null when the repo or the number is not acceptable. */
export function itemUrl(repo: string, kind: GithubItemKind, number: number): string | null {
  if (!isRepoFullName(repo)) return null;
  if (!Number.isInteger(number) || number < 1 || number >= 1_000_000_000) return null;
  return `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

/** The message a Review button sends to the repo's agent, or null when the repo or the number is not acceptable. */
export function reviewPrompt(repo: string, number: number): string | null {
  const url = itemUrl(repo, "pr", number);
  return url === null ? null : `review pr ${url}`;
}

/** `hello` from `octo/hello`. */
export function shortRepoName(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash === -1 ? fullName : fullName.slice(slash + 1);
}

/** The `rel="next"` target of a GitHub `Link` header, or null. */
export function nextLink(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(header);
  return match?.[1] ?? null;
}

/** GitHub's `reviewDecision` as a short state. */
export function reviewState(raw: string | null | undefined): ReviewState | null {
  if (raw === "APPROVED") return "approved";
  if (raw === "CHANGES_REQUESTED") return "changes";
  if (raw === "REVIEW_REQUIRED") return "required";
  return null;
}

/** GitHub's `statusCheckRollup.state` as a short state. */
export function ciState(raw: string | null | undefined): CiState | null {
  if (raw === "SUCCESS") return "passing";
  if (raw === "FAILURE" || raw === "ERROR") return "failing";
  if (raw === "PENDING" || raw === "EXPECTED") return "pending";
  return null;
}

export function reviewLabel(state: ReviewState): string {
  if (state === "approved") return "Approved";
  if (state === "changes") return "Changes requested";
  return "Review required";
}

export function ciLabel(state: CiState): string {
  if (state === "passing") return "CI passing";
  if (state === "failing") return "CI failing";
  return "CI pending";
}

const DONE_NAMES = new Set(["done", "closed", "completed", "shipped"]);

/** True for a Status name that means the work is finished. Like Jira's "not Done". */
export function isDoneStatus(name: string): boolean {
  return DONE_NAMES.has(name.trim().toLowerCase());
}

/**
 * Column for one project item, using the same three columns as the Jira board.
 * An item with no Status goes to To Do. Otherwise Jira's `ticketColumn` decides, with no status category.
 */
export function projectColumn(status: string): TicketColumn {
  if (status.trim() === "") return "todo";
  return ticketColumn(status, "");
}

/** The Pull requests section is available only while the repos token is saved. */
export function prsReady(status: { repos: { tokenSet: boolean } } | null): boolean {
  return status?.repos.tokenSet === true;
}

/** The Projects section is available only while the Projects token is saved. */
export function projectsReady(status: { projects: { tokenSet: boolean } } | null): boolean {
  return status?.projects.tokenSet === true;
}

/** "just now", "5m ago", "3h ago", "2d ago", or the date (YYYY-MM-DD) after 30 days. Empty for a bad date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}
