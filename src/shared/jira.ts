// Pure Jira checks shared by main and the check script. No I/O.

/** A Jira issue key such as ABC-12. The browse URL is built only from a key that matches. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,49}-[0-9]{1,9}$/;

/** Enough to reject an empty or space-filled address. Atlassian checks the real account. */
export const JIRA_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Assigned to the caller, not Done, newest update first.
 * Both filters are required: POST /rest/api/3/search/jql rejects a JQL with no filter clause.
 */
export const ASSIGNED_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

export const JIRA_PAGE_SIZE = 50;

const SITE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

/**
 * The https origin of a Jira Cloud site, or null.
 * Accepts `https://acme.atlassian.net` and `https://acme.atlassian.net/any/path`.
 * Rejects http, a port, user info, an IP, and any host that is not `<name>.atlassian.net`.
 */
export function jiraSiteOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (!SITE_HOST.test(url.hostname)) return null;
  return url.origin;
}

/** The browse URL for one issue, or null when the site or the key is not acceptable. */
export function issueBrowseUrl(site: string, key: string): string | null {
  if (!ISSUE_KEY.test(key)) return null;
  const origin = jiraSiteOrigin(site);
  return origin === null ? null : `${origin}/browse/${key}`;
}

/** True when Setup has an email, a site, and a saved token. The pane loads tickets only then. */
export function jiraReady(
  status: {
    email: string | null;
    site: string | null;
    tokenSet: boolean;
  } | null,
): boolean {
  return (
    status?.tokenSet === true && status.email !== null && status.site !== null
  );
}

/** The site name shown in the pane header, such as `acme` from `https://acme.atlassian.net`. */
export function siteLabel(site: string | null): string {
  if (site === null) return "";
  try {
    return new URL(site).hostname.replace(/\.atlassian\.net$/, "");
  } catch {
    return "";
  }
}
