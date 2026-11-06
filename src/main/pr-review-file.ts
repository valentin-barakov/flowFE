// The saved review for pull request N is <checkout>/pr-reviews/N.md. Main process only.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const PR_REVIEW_DIR = "pr-reviews";

/** True when `file` is an absolute `pr-reviews/<number>.md`. */
export function isSavedReviewPath(file: string, number: number): boolean {
  if (!path.isAbsolute(file)) return false;
  if (!Number.isInteger(number) || number < 1) return false;
  const resolved = path.resolve(file);
  return path.basename(resolved) === `${number}.md` && path.basename(path.dirname(resolved)) === PR_REVIEW_DIR;
}

/** `owner/name` from an origin URL, or null when it is not a GitHub remote. */
export function githubFullNameFromRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
  const scp = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/);
  if (scp !== null) return `${scp[1]}/${scp[2]}`;
  const ssh = trimmed.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)$/);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter((part) => part !== "");
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** The origin `owner/name` from a checkout's git config, or null. */
export function originFullName(repoPath: string): string | null {
  const text = readGitConfig(repoPath);
  if (text === null) return null;
  const section = text.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/);
  if (section === null) return null;
  const url = section[1].match(/^\s*url\s*=\s*(\S+)/m);
  if (url === null) return null;
  return githubFullNameFromRemote(url[1]);
}

/** The workspace checkout whose origin is `fullName`, or null. */
export function localRepoPath(fullName: string, repos: readonly { path: string }[]): string | null {
  for (const repo of repos) {
    if (originFullName(repo.path) === fullName) return repo.path;
  }
  return null;
}

/**
 * Absolute path of `pr-reviews/<number>.md` when that file is a regular file
 * inside the checkout. A symlink that leaves the checkout is refused.
 */
export function existingReviewFile(repoPath: string, number: number): string | null {
  if (!Number.isInteger(number) || number < 1) return null;
  const file = path.join(repoPath, PR_REVIEW_DIR, `${number}.md`);
  let realRepo: string;
  let realFile: string;
  try {
    realRepo = realpathSync(repoPath);
    if (!statSync(file).isFile()) return null;
    realFile = realpathSync(file);
  } catch {
    return null;
  }
  const root = realRepo.endsWith(path.sep) ? realRepo : `${realRepo}${path.sep}`;
  if (!realFile.startsWith(root)) return null;
  if (!isSavedReviewPath(realFile, number)) return null;
  return realFile;
}

function readGitConfig(repoPath: string): string | null {
  const gitPath = path.join(repoPath, ".git");
  if (!existsSync(gitPath)) return null;
  let gitDir: string;
  try {
    if (statSync(gitPath).isDirectory()) {
      gitDir = gitPath;
    } else {
      const pointer = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (pointer === null) return null;
      gitDir = path.resolve(repoPath, pointer[1].trim());
    }
  } catch {
    return null;
  }
  const own = readText(path.join(gitDir, "config"));
  if (own !== null && own.includes('[remote "origin"]')) return own;
  const common = readText(path.join(gitDir, "commondir"));
  if (common === null) return own;
  return readText(path.join(path.resolve(gitDir, common.trim()), "config"));
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
