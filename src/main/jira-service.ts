// Jira Cloud ticket list for the signed-in account. Main process only.
// jira.bin holds the email, the site origin, and the API token, encrypted with safeStorage.
// Requests use Basic auth against https://<site>.atlassian.net and nowhere else.
// The window never sees the token.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ASSIGNED_JQL,
  issueBrowseUrl,
  jiraSiteOrigin,
  JIRA_PAGE_SIZE,
  ISSUE_KEY,
} from "../shared/jira.js";
import { writeAtomic } from "./atomic-write.js";
import type {
  ErrorCode,
  JiraIssue,
  JiraIssuesResult,
  JiraStatus,
} from "../shared/ipc.js";
import type { SecretBox } from "./settings-store.js";

export class JiraError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "JiraError";
    this.code = code;
    this.retryable = retryable;
  }
}

const ISSUE_FIELDS = ["summary", "status", "issuetype", "project", "updated"];
const REQUEST_TIMEOUT_MS = 20_000;

const JiraDataSchema = z.object({
  email: z.string().nullable(),
  site: z.string().nullable(),
  token: z.string().nullable(),
});
type JiraData = z.infer<typeof JiraDataSchema>;

const EMPTY_DATA: JiraData = { email: null, site: null, token: null };

const ApiIssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().nullish(),
    updated: z.string().nullish(),
    status: z
      .object({
        name: z.string(),
        statusCategory: z.object({ name: z.string() }).nullish(),
      })
      .nullish(),
    issuetype: z.object({ name: z.string() }).nullish(),
    project: z.object({ name: z.string() }).nullish(),
  }),
});

const SearchResponseSchema = z.object({
  issues: z.array(z.unknown()),
  nextPageToken: z.string().nullish(),
});

export type JiraService = {
  status(): JiraStatus;
  /** Saves the email and site. `token` replaces the stored token; omitted keeps the stored one. */
  saveAccount(input: {
    email: string;
    site: string;
    token?: string;
  }): JiraStatus;
  /** Removes the email, the site, and the token. */
  clear(): JiraStatus;
  issues(input: { pageToken?: string | undefined }): Promise<JiraIssuesResult>;
  open(key: string): Promise<void>;
};

export type JiraOptions = {
  userDataDir: string;
  secrets: SecretBox;
  openExternal(url: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
};

/** Reads a `search/jql` response. Rows that do not parse, or whose key is odd, are skipped. */
export function parseSearchResponse(
  body: unknown,
): { issues: JiraIssue[]; nextPageToken: string | null } | null {
  const parsed = SearchResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const issues: JiraIssue[] = [];
  for (const raw of parsed.data.issues) {
    const row = ApiIssueSchema.safeParse(raw);
    if (!row.success || !ISSUE_KEY.test(row.data.key)) continue;
    const fields = row.data.fields;
    issues.push({
      key: row.data.key,
      summary: clip(fields.summary ?? "", 500),
      status: clip(fields.status?.name ?? "", 100),
      statusCategory: clip(fields.status?.statusCategory?.name ?? "", 40),
      type: clip(fields.issuetype?.name ?? "", 100),
      project: clip(fields.project?.name ?? "", 200),
      updated: clip(fields.updated ?? "", 60),
    });
  }
  const next = parsed.data.nextPageToken;
  return {
    issues,
    nextPageToken:
      next === undefined || next === null || next === "" ? null : next,
  };
}

export function createJiraService(options: JiraOptions): JiraService {
  const file = path.join(options.userDataDir, "jira.bin");
  const doFetch = options.fetch ?? globalThis.fetch;
  let cache: JiraData | null = null;

  function load(): JiraData {
    if (cache === null) cache = readData();
    return cache;
  }

  function readData(): JiraData {
    if (!existsSync(file) || !options.secrets.isEncryptionAvailable())
      return EMPTY_DATA;
    try {
      const parsed = JiraDataSchema.safeParse(
        JSON.parse(
          options.secrets.decryptString(readFileSync(file)),
        ) as unknown,
      );
      if (!parsed.success) return EMPTY_DATA;
      if (
        parsed.data.site !== null &&
        jiraSiteOrigin(parsed.data.site) !== parsed.data.site
      )
        return EMPTY_DATA;
      return parsed.data;
    } catch {
      return EMPTY_DATA;
    }
  }

  function save(next: JiraData): void {
    if (!options.secrets.isEncryptionAvailable()) {
      throw new JiraError(
        "io_error",
        "This Mac cannot encrypt the Jira token right now.",
        false,
      );
    }
    try {
      writeAtomic(file, options.secrets.encryptString(JSON.stringify(next)));
    } catch {
      throw new JiraError(
        "io_error",
        "Could not save the Jira settings.",
        false,
      );
    }
    cache = next;
  }

  function status(): JiraStatus {
    const data = load();
    return {
      email: data.email,
      site: data.site,
      tokenSet: data.token !== null,
    };
  }

  function saveAccount(input: {
    email: string;
    site: string;
    token?: string;
  }): JiraStatus {
    const origin = jiraSiteOrigin(input.site);
    if (origin === null) {
      throw new JiraError(
        "invalid_input",
        "Use the site address, like https://your-site.atlassian.net.",
        false,
      );
    }
    const data = load();
    const token = input.token !== undefined ? input.token : data.token;
    if (token === null || token === "")
      throw new JiraError("not_ready", "Paste an API token.", false);
    save({ email: input.email, site: origin, token });
    return status();
  }

  function clear(): JiraStatus {
    if (!existsSync(file)) {
      cache = EMPTY_DATA;
      return status();
    }
    save(EMPTY_DATA);
    return status();
  }

  function requireAccount(): { email: string; site: string; token: string } {
    const data = load();
    const { email, site, token } = data;
    if (email === null || site === null || token === null) {
      throw new JiraError(
        "not_ready",
        "Add your Jira email, site, and API token in Setup.",
        false,
      );
    }
    return { email, site, token };
  }

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new JiraError(
        "io_error",
        "Could not reach Jira. Check the connection and try again.",
        true,
      );
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      throw unreadable();
    }
  }

  async function issues(input: {
    pageToken?: string | undefined;
  }): Promise<JiraIssuesResult> {
    const data = requireAccount();
    const url = `${data.site}/rest/api/3/search/jql`;
    const body = JSON.stringify({
      jql: ASSIGNED_JQL,
      fields: ISSUE_FIELDS,
      maxResults: JIRA_PAGE_SIZE,
      ...(input.pageToken !== undefined
        ? { nextPageToken: input.pageToken }
        : {}),
    });
    const response = await send(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(data.email, data.token),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
    });
    if (!response.ok) throw httpFailure(response.status);
    const page = parseSearchResponse(await readJson(response));
    if (page === null) throw unreadable();
    return {
      issues: page.issues,
      ...(page.nextPageToken !== null
        ? { nextPageToken: page.nextPageToken }
        : {}),
    };
  }

  async function open(key: string): Promise<void> {
    const data = requireAccount();
    const url = issueBrowseUrl(data.site, key);
    if (url === null)
      throw new JiraError("invalid_input", "Unknown issue key.", false);
    try {
      await options.openExternal(url);
    } catch {
      throw new JiraError("io_error", "Could not open the browser.", true);
    }
  }

  return { status, saveAccount, clear, issues, open };
}

function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
}

function unreadable(): JiraError {
  return new JiraError(
    "io_error",
    "Jira sent an answer the app could not read.",
    true,
  );
}

function httpFailure(status: number): JiraError {
  if (status === 401)
    return new JiraError(
      "auth",
      "Jira rejected the email or the API token. Check them in Setup.",
      false,
    );
  if (status === 403)
    return new JiraError(
      "auth",
      "Jira refused this search for that account.",
      false,
    );
  if (status === 404)
    return new JiraError(
      "not_found",
      "That Jira site did not answer. Check the site address in Setup.",
      false,
    );
  if (status === 429)
    return new JiraError(
      "io_error",
      "Jira is busy. Try again in a moment.",
      true,
    );
  if (status >= 500)
    return new JiraError(
      "io_error",
      `Jira had a problem (HTTP ${status}). Try again.`,
      true,
    );
  return new JiraError(
    "io_error",
    `Jira refused the request (HTTP ${status}).`,
    false,
  );
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
