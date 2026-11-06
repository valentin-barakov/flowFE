// GitHub pull requests and Projects for the signed-in account. Main process only.
// github.bin holds two optional tokens, their logins, and the picked repos and projects,
// encrypted with safeStorage. Requests go to https://api.github.com and nowhere else.
// Mango only reads. The window never sees a token.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ciState,
  ENOUGH_ITEMS,
  GITHUB_API_ORIGIN,
  isDoneStatus,
  isRepoFullName,
  ITEM_PAGE_SIZE,
  itemUrl,
  MAX_ITEM_PAGES,
  MAX_REPO_PAGES,
  MAX_SELECTED_PROJECTS,
  MAX_SELECTED_REPOS,
  nextLink,
  PR_PAGE_SIZE,
  PROJECT_ID,
  reviewState,
  type GithubItemKind,
  type GithubTokenKind,
} from "../shared/github.js";
import { isSavedReviewPath, readReviewVerdict } from "./pr-review-file.js";
import { writeAtomic } from "./atomic-write.js";
import type {
  ErrorCode,
  GithubItem,
  GithubItemsResult,
  GithubPr,
  GithubPrsResult,
  GithubProjectRef,
  GithubProjectsResult,
  GithubRepo,
  GithubReposResult,
  GithubStatus,
} from "../shared/ipc.js";
import type { SecretBox } from "./settings-store.js";

export class GithubError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "GithubError";
    this.code = code;
    this.retryable = retryable;
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
const GRAPHQL_URL = `${GITHUB_API_ORIGIN}/graphql`;
const USER_URL = `${GITHUB_API_ORIGIN}/user`;
const REPOS_URL = `${GITHUB_API_ORIGIN}/user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member`;

/** The only pages the window can ask main to open besides an item. A kind that is not a key here is refused. */
const TOKEN_PAGES: Record<GithubTokenKind, string> = {
  repos: "https://github.com/settings/tokens/new?scopes=repo&description=Mango%20pull%20requests",
  projects: "https://github.com/settings/tokens/new?scopes=read:project&description=Mango%20projects",
};

const VIEWER_QUERY = "query { viewer { login } }";

const PRS_QUERY = `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number
        title
        isDraft
        updatedAt
        author { login }
        headRefName
        baseRefName
        reviewDecision
        viewerLatestReview { state }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const PROJECTS_QUERY = "query { viewer { projectsV2(first: 50) { nodes { id title number closed } } } }";

const ITEMS_QUERY = `query($id: ID!, $first: Int!, $after: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            __typename
            ... on Issue { number title state repository { nameWithOwner } }
            ... on PullRequest { number title state repository { nameWithOwner } }
            ... on DraftIssue { title }
          }
        }
      }
    }
  }
}`;

const ProjectRefSchema = z.object({
  id: z.string().regex(PROJECT_ID),
  title: z.string().max(200),
});

const GithubDataSchema = z.object({
  repoToken: z.string().nullable(),
  repoLogin: z.string().nullable(),
  projectToken: z.string().nullable(),
  projectLogin: z.string().nullable(),
  selectedRepos: z.array(z.string().refine(isRepoFullName)).max(MAX_SELECTED_REPOS),
  selectedProjects: z.array(ProjectRefSchema).max(MAX_SELECTED_PROJECTS),
});
type GithubData = z.infer<typeof GithubDataSchema>;

const EMPTY_DATA: GithubData = {
  repoToken: null,
  repoLogin: null,
  projectToken: null,
  projectLogin: null,
  selectedRepos: [],
  selectedProjects: [],
};

const UserSchema = z.object({ login: z.string().min(1).max(100) });
const ViewerSchema = z.object({ viewer: UserSchema });

const GraphqlEnvelopeSchema = z.object({
  data: z.unknown().nullish(),
  errors: z
    .array(z.object({ type: z.string().nullish(), message: z.string().nullish() }))
    .nullish(),
});

const ApiRepoSchema = z.object({
  full_name: z.string(),
  private: z.boolean().nullish(),
  archived: z.boolean().nullish(),
});

const PrNodeSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().nullish(),
  isDraft: z.boolean().nullish(),
  updatedAt: z.string().nullish(),
  author: z.object({ login: z.string() }).nullish(),
  headRefName: z.string().nullish(),
  baseRefName: z.string().nullish(),
  reviewDecision: z.string().nullish(),
  viewerLatestReview: z.object({ state: z.string() }).nullish(),
  commits: z
    .object({
      nodes: z
        .array(
          z
            .object({
              commit: z
                .object({
                  statusCheckRollup: z.object({ state: z.string() }).nullish(),
                })
                .nullish(),
            })
            .nullish(),
        )
        .nullish(),
    })
    .nullish(),
});

const PrsDataSchema = z.object({
  repository: z
    .object({
      pullRequests: z.object({
        totalCount: z.number().int().min(0),
        nodes: z.array(z.unknown()).nullish(),
      }),
    })
    .nullable(),
});

const ProjectNodeSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  closed: z.boolean().nullish(),
});

const ProjectsDataSchema = z.object({
  viewer: z.object({
    projectsV2: z.object({ nodes: z.array(z.unknown()).nullish() }),
  }),
});

const ItemContentSchema = z.object({
  __typename: z.string(),
  number: z.number().int().positive().nullish(),
  title: z.string().nullish(),
  state: z.string().nullish(),
  repository: z.object({ nameWithOwner: z.string() }).nullish(),
});

const ItemNodeSchema = z.object({
  id: z.string(),
  status: z.object({ name: z.string().nullish() }).nullish(),
  content: ItemContentSchema.nullish(),
});

const ItemsDataSchema = z.object({
  node: z
    .object({
      items: z
        .object({
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullish(),
          }),
          nodes: z.array(z.unknown()).nullish(),
        })
        .optional(),
    })
    .nullable(),
});

export type GithubService = {
  status(): GithubStatus;
  /** Checks the token with GET /user. A rejected token is not saved. */
  saveRepoToken(input: { token: string }): Promise<GithubStatus>;
  /** Removes the repos token and the picked repos. */
  clearRepoToken(): GithubStatus;
  /** Checks the token with a GraphQL viewer query. A rejected token is not saved. */
  saveProjectToken(input: { token: string }): Promise<GithubStatus>;
  /** Removes the Projects token and the picked projects. */
  clearProjectToken(): GithubStatus;
  repos(): Promise<GithubReposResult>;
  selectRepos(input: { repos: string[] }): GithubStatus;
  prs(input: { repo: string }): Promise<GithubPrsResult>;
  projects(): Promise<GithubProjectsResult>;
  selectProjects(input: { projects: GithubProjectRef[] }): GithubStatus;
  projectItems(input: {
    projectId: string;
    cursor?: string | undefined;
  }): Promise<GithubItemsResult>;
  open(input: { repo: string; kind: GithubItemKind; number: number }): Promise<void>;
  /** Opens pr-reviews/<number>.md for a picked repo when that file is in the local checkout. */
  openReview(input: { repo: string; number: number }): Promise<void>;
  /** True when pr-reviews/<number>.md is a saved review in the local checkout. Reads the disk only, never GitHub. */
  reviewReady(input: { repo: string; number: number }): {
    ready: boolean;
    verdict: "yes" | "no" | null;
  };
  openTokenPage(input: { kind: GithubTokenKind }): Promise<void>;
};

export type GithubOptions = {
  userDataDir: string;
  secrets: SecretBox;
  openExternal(url: string): Promise<void>;
  /** Absolute path of pr-reviews/<number>.md in the local checkout, or null when there is none. */
  reviewFile?(repo: string, number: number): string | null;
  /** The workspace repo name whose origin is `repo`, or null when the workspace has no such checkout. */
  localRepoName?(repo: string): string | null;
  /** Opens a path that reviewFile returned. */
  openPath?(file: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
};

/** Rows that do not parse, or whose name is odd, are skipped. */
export function parseRepoRows(rows: readonly unknown[]): GithubRepo[] {
  const repos: GithubRepo[] = [];
  for (const raw of rows) {
    const row = ApiRepoSchema.safeParse(raw);
    if (!row.success || !isRepoFullName(row.data.full_name)) continue;
    repos.push({
      fullName: row.data.full_name,
      private: row.data.private === true,
      archived: row.data.archived === true,
    });
  }
  return repos;
}

/** `null` when the answer is not the expected shape, `"missing"` when the repo is not visible to the token. */
export function parsePrsResponse(data: unknown): Omit<GithubPrsResult, "checkout"> | "missing" | null {
  const parsed = PrsDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const repository = parsed.data.repository;
  if (repository === null) return "missing";
  const prs: GithubPr[] = [];
  for (const raw of repository.pullRequests.nodes ?? []) {
    const node = PrNodeSchema.safeParse(raw);
    if (!node.success) continue;
    const row = node.data;
    prs.push({
      number: row.number,
      title: clip(row.title ?? "", 500),
      author: clip(row.author?.login ?? "", 100),
      headRefName: clip(row.headRefName ?? "", 200),
      baseRefName: clip(row.baseRefName ?? "", 200),
      isDraft: row.isDraft === true,
      updatedAt: clip(row.updatedAt ?? "", 60),
      review: reviewState(row.reviewDecision),
      approvedByYou: row.viewerLatestReview?.state === "APPROVED",
      ci: ciState(row.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
      hasReview: false,
      verdict: null,
    });
  }
  return { prs, total: repository.pullRequests.totalCount };
}

/** Open personal projects only. A closed project or an odd id is skipped. */
export function parseProjectsResponse(data: unknown): GithubProjectRef[] | null {
  const parsed = ProjectsDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const projects: GithubProjectRef[] = [];
  for (const raw of parsed.data.viewer.projectsV2.nodes ?? []) {
    const node = ProjectNodeSchema.safeParse(raw);
    if (!node.success || node.data.closed === true || !PROJECT_ID.test(node.data.id)) continue;
    projects.push({ id: node.data.id, title: clip(node.data.title ?? "", 200) });
  }
  return projects;
}

/**
 * One page of project items. Closed or merged issues and pull requests, and items whose Status
 * is a done name, are dropped. Drafts are kept. `"missing"` when the id is not a project.
 */
export function parseItemsPage(
  data: unknown,
): { items: GithubItem[]; hasNext: boolean; endCursor: string | null } | "missing" | null {
  const parsed = ItemsDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const items = parsed.data.node?.items;
  if (items === undefined) return "missing";
  const kept: GithubItem[] = [];
  for (const raw of items.nodes ?? []) {
    const item = toItem(raw);
    if (item !== null) kept.push(item);
  }
  return {
    items: kept,
    hasNext: items.pageInfo.hasNextPage,
    endCursor: items.pageInfo.endCursor ?? null,
  };
}

function toItem(raw: unknown): GithubItem | null {
  const node = ItemNodeSchema.safeParse(raw);
  if (!node.success) return null;
  const content = node.data.content;
  if (content === null || content === undefined) return null;
  const status = clip(node.data.status?.name ?? "", 100);
  if (isDoneStatus(status)) return null;
  const id = clip(node.data.id, 200);
  const title = clip(content.title ?? "", 500);
  if (id === "") return null;
  if (content.__typename === "DraftIssue") {
    return { id, kind: "draft", repo: null, number: null, title, status };
  }
  if (content.__typename !== "Issue" && content.__typename !== "PullRequest") return null;
  if (content.state !== "OPEN") return null;
  const repo = content.repository?.nameWithOwner;
  const number = content.number;
  if (repo === undefined || repo === null || !isRepoFullName(repo)) return null;
  if (number === undefined || number === null) return null;
  return {
    id,
    kind: content.__typename === "PullRequest" ? "pr" : "issue",
    repo,
    number,
    title,
    status,
  };
}

export function createGithubService(options: GithubOptions): GithubService {
  const file = path.join(options.userDataDir, "github.bin");
  const doFetch = options.fetch ?? globalThis.fetch;
  let cache: GithubData | null = null;

  function load(): GithubData {
    if (cache === null) cache = readData();
    return cache;
  }

  function readData(): GithubData {
    if (!existsSync(file) || !options.secrets.isEncryptionAvailable()) return EMPTY_DATA;
    try {
      const parsed = GithubDataSchema.safeParse(
        JSON.parse(options.secrets.decryptString(readFileSync(file))) as unknown,
      );
      return parsed.success ? parsed.data : EMPTY_DATA;
    } catch {
      return EMPTY_DATA;
    }
  }

  function save(next: GithubData): void {
    if (!options.secrets.isEncryptionAvailable()) {
      throw new GithubError(
        "io_error",
        "This Mac cannot encrypt the GitHub tokens right now.",
        false,
      );
    }
    try {
      writeAtomic(file, options.secrets.encryptString(JSON.stringify(next)));
    } catch {
      throw new GithubError("io_error", "Could not save the GitHub settings.", false);
    }
    cache = next;
  }

  function status(): GithubStatus {
    const data = load();
    return {
      repos: {
        tokenSet: data.repoToken !== null,
        login: data.repoLogin,
        selected: [...data.selectedRepos],
      },
      projects: {
        tokenSet: data.projectToken !== null,
        login: data.projectLogin,
        selected: data.selectedProjects.map((project) => ({
          id: project.id,
          title: project.title,
        })),
      },
    };
  }

  function requireRepoToken(): string {
    const token = load().repoToken;
    if (token === null) {
      throw new GithubError(
        "not_ready",
        "Add a GitHub token for pull requests in Setup.",
        false,
      );
    }
    return token;
  }

  function requireProjectToken(): string {
    const token = load().projectToken;
    if (token === null) {
      throw new GithubError("not_ready", "Add a GitHub token for projects in Setup.", false);
    }
    return token;
  }

  /** One request to api.github.com. The token is never sent to another host. */
  async function send(token: string, url: string, body?: string): Promise<Response> {
    if (!url.startsWith(`${GITHUB_API_ORIGIN}/`)) {
      throw new GithubError("invalid_input", "Refused a request to another host.", false);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Mango",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await doFetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GithubError(
        "io_error",
        "Could not reach GitHub. Check the connection and try again.",
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

  async function graphql(
    token: string,
    scope: "repo" | "read:project",
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await send(token, GRAPHQL_URL, JSON.stringify({ query, variables }));
    if (!response.ok) throw httpFailure(response);
    const envelope = GraphqlEnvelopeSchema.safeParse(await readJson(response));
    if (!envelope.success) throw unreadable();
    const errors = envelope.data.errors ?? [];
    if (errors.length > 0) throw graphqlFailure(errors, scope);
    if (envelope.data.data === undefined || envelope.data.data === null) throw unreadable();
    return envelope.data.data;
  }

  async function saveRepoToken(input: { token: string }): Promise<GithubStatus> {
    const token = input.token.trim();
    if (token === "") throw new GithubError("invalid_input", "Paste a token.", false);
    const response = await send(token, USER_URL);
    if (!response.ok) throw httpFailure(response);
    const user = UserSchema.safeParse(await readJson(response));
    if (!user.success) throw unreadable();
    save({ ...load(), repoToken: token, repoLogin: user.data.login });
    return status();
  }

  function clearRepoToken(): GithubStatus {
    const data = load();
    if (data.repoToken === null && data.repoLogin === null && data.selectedRepos.length === 0) {
      return status();
    }
    save({ ...data, repoToken: null, repoLogin: null, selectedRepos: [] });
    return status();
  }

  async function saveProjectToken(input: { token: string }): Promise<GithubStatus> {
    const token = input.token.trim();
    if (token === "") throw new GithubError("invalid_input", "Paste a token.", false);
    const data = await graphql(token, "read:project", VIEWER_QUERY, {});
    const viewer = ViewerSchema.safeParse(data);
    if (!viewer.success) throw unreadable();
    save({ ...load(), projectToken: token, projectLogin: viewer.data.viewer.login });
    return status();
  }

  function clearProjectToken(): GithubStatus {
    const data = load();
    if (
      data.projectToken === null &&
      data.projectLogin === null &&
      data.selectedProjects.length === 0
    ) {
      return status();
    }
    save({ ...data, projectToken: null, projectLogin: null, selectedProjects: [] });
    return status();
  }

  async function repos(): Promise<GithubReposResult> {
    const token = requireRepoToken();
    const found: GithubRepo[] = [];
    let url: string | null = REPOS_URL;
    let pages = 0;
    while (url !== null && pages < MAX_REPO_PAGES) {
      const response: Response = await send(token, url);
      if (!response.ok) throw httpFailure(response);
      const body = await readJson(response);
      if (!Array.isArray(body)) throw unreadable();
      found.push(...parseRepoRows(body));
      pages += 1;
      url = nextApiLink(response.headers.get("link"));
    }
    return { repos: found, truncated: url !== null };
  }

  function selectRepos(input: { repos: string[] }): GithubStatus {
    requireRepoToken();
    const data = load();
    const names = [...new Set(input.repos)];
    if (names.length > MAX_SELECTED_REPOS) {
      throw new GithubError(
        "invalid_input",
        `Pick at most ${MAX_SELECTED_REPOS} repositories.`,
        false,
      );
    }
    if (!names.every((name) => isRepoFullName(name))) {
      throw new GithubError("invalid_input", "Unknown repository.", false);
    }
    save({ ...data, selectedRepos: names });
    return status();
  }

  async function prs(input: { repo: string }): Promise<GithubPrsResult> {
    const token = requireRepoToken();
    if (!isRepoFullName(input.repo) || !load().selectedRepos.includes(input.repo)) {
      throw new GithubError("invalid_input", "Pick that repository in Setup first.", false);
    }
    const [owner, name] = input.repo.split("/");
    const data = await graphql(token, "repo", PRS_QUERY, {
      owner,
      name,
      first: PR_PAGE_SIZE,
    });
    const page = parsePrsResponse(data);
    if (page === null) throw unreadable();
    if (page === "missing") {
      throw new GithubError(
        "not_found",
        "GitHub could not find that repository for this token.",
        false,
      );
    }
    return {
      total: page.total,
      checkout: options.localRepoName?.(input.repo) ?? null,
      prs: page.prs.map((pr) => {
        const file = options.reviewFile?.(input.repo, pr.number) ?? null;
        const mark = reviewMark(file, pr.number);
        return { ...pr, hasReview: mark.hasReview, verdict: mark.verdict };
      }),
    };
  }

  async function projects(): Promise<GithubProjectsResult> {
    const token = requireProjectToken();
    const data = await graphql(token, "read:project", PROJECTS_QUERY, {});
    const list = parseProjectsResponse(data);
    if (list === null) throw unreadable();
    return { projects: list };
  }

  function selectProjects(input: { projects: GithubProjectRef[] }): GithubStatus {
    requireProjectToken();
    const data = load();
    const unique = new Map<string, GithubProjectRef>();
    for (const project of input.projects) {
      if (!PROJECT_ID.test(project.id)) {
        throw new GithubError("invalid_input", "Unknown project.", false);
      }
      unique.set(project.id, { id: project.id, title: clip(project.title, 200) });
    }
    if (unique.size > MAX_SELECTED_PROJECTS) {
      throw new GithubError(
        "invalid_input",
        `Pick at most ${MAX_SELECTED_PROJECTS} projects.`,
        false,
      );
    }
    save({ ...data, selectedProjects: [...unique.values()] });
    return status();
  }

  async function projectItems(input: {
    projectId: string;
    cursor?: string | undefined;
  }): Promise<GithubItemsResult> {
    const token = requireProjectToken();
    if (!load().selectedProjects.some((project) => project.id === input.projectId)) {
      throw new GithubError("invalid_input", "Pick that project in Setup first.", false);
    }
    const items: GithubItem[] = [];
    let cursor: string | null = input.cursor ?? null;
    let more = true;
    let pages = 0;
    while (more && pages < MAX_ITEM_PAGES && items.length < ENOUGH_ITEMS) {
      const data = await graphql(token, "read:project", ITEMS_QUERY, {
        id: input.projectId,
        first: ITEM_PAGE_SIZE,
        after: cursor,
      });
      const page = parseItemsPage(data);
      if (page === null) throw unreadable();
      if (page === "missing") {
        throw new GithubError(
          "not_found",
          "GitHub could not find that project for this token.",
          false,
        );
      }
      items.push(...page.items);
      pages += 1;
      cursor = page.endCursor;
      more = page.hasNext && page.endCursor !== null;
    }
    return {
      items,
      ...(more && cursor !== null ? { nextCursor: cursor } : {}),
    };
  }

  async function open(input: {
    repo: string;
    kind: GithubItemKind;
    number: number;
  }): Promise<void> {
    const data = load();
    if (data.repoToken === null && data.projectToken === null) {
      throw new GithubError("not_ready", "Add a GitHub token in Setup.", false);
    }
    const url = itemUrl(input.repo, input.kind, input.number);
    if (url === null) {
      throw new GithubError("invalid_input", "Unknown pull request or issue.", false);
    }
    await browse(url);
  }

  async function openReview(input: { repo: string; number: number }): Promise<void> {
    if (!isRepoFullName(input.repo) || !load().selectedRepos.includes(input.repo)) {
      throw new GithubError("invalid_input", "Pick that repository in Setup first.", false);
    }
    const file = options.reviewFile?.(input.repo, input.number) ?? null;
    if (file === null || !savedReview(file, input.number) || options.openPath === undefined) {
      throw new GithubError("not_found", "No saved review for that pull request.", false);
    }
    try {
      await options.openPath(file);
    } catch {
      throw new GithubError("io_error", "Could not open the review.", true);
    }
  }

  function reviewReady(input: { repo: string; number: number }): {
    ready: boolean;
    verdict: "yes" | "no" | null;
  } {
    if (
      !isRepoFullName(input.repo) ||
      !load().selectedRepos.includes(input.repo)
    ) {
      throw new GithubError(
        "invalid_input",
        "Pick that repository in Setup first.",
        false,
      );
    }
    const file = options.reviewFile?.(input.repo, input.number) ?? null;
    const mark = reviewMark(file, input.number);
    return { ready: mark.ready, verdict: mark.verdict };
  }

  async function openTokenPage(input: { kind: GithubTokenKind }): Promise<void> {
    const url = Object.hasOwn(TOKEN_PAGES, input.kind) ? TOKEN_PAGES[input.kind] : undefined;
    if (url === undefined) {
      throw new GithubError("invalid_input", "Unknown token page.", false);
    }
    await browse(url);
  }

  async function browse(url: string): Promise<void> {
    try {
      await options.openExternal(url);
    } catch {
      throw new GithubError("io_error", "Could not open the browser.", true);
    }
  }

  return {
    status,
    saveRepoToken,
    clearRepoToken,
    saveProjectToken,
    clearProjectToken,
    repos,
    selectRepos,
    prs,
    projects,
    selectProjects,
    projectItems,
    open,
    openReview,
    reviewReady,
    openTokenPage,
  };
}

function savedReview(file: string | null, number: number): boolean {
  return file !== null && isSavedReviewPath(file, number);
}

/** `ready` when the path is a saved review. `verdict` is the Yes or No at the top of that file. */
function reviewMark(
  file: string | null,
  number: number,
): { hasReview: boolean; ready: boolean; verdict: "yes" | "no" | null } {
  const ready = savedReview(file, number);
  return {
    hasReview: ready,
    ready,
    verdict: ready && file !== null ? readReviewVerdict(file) : null,
  };
}

/** The `Link` next page, but only when it is on api.github.com. */
function nextApiLink(header: string | null): string | null {
  const next = nextLink(header);
  if (next === null) return null;
  try {
    return new URL(next).origin === GITHUB_API_ORIGIN ? next : null;
  } catch {
    return null;
  }
}

function unreadable(): GithubError {
  return new GithubError("io_error", "GitHub sent an answer the app could not read.", true);
}

function httpFailure(response: Response): GithubError {
  const status = response.status;
  if (status === 401) {
    return new GithubError("auth", "GitHub rejected the token. Check it in Setup.", false);
  }
  if (status === 403 || status === 429) {
    const limited =
      status === 429 ||
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.get("retry-after") !== null;
    if (limited) {
      return new GithubError("io_error", "GitHub is limiting requests. Try again in a moment.", true);
    }
    return new GithubError(
      "auth",
      "GitHub refused this request for that token. Check its scope in Setup.",
      false,
    );
  }
  if (status === 404) {
    return new GithubError(
      "not_found",
      "GitHub could not find that. Check the token and the picks in Setup.",
      false,
    );
  }
  if (status >= 500) {
    return new GithubError("io_error", `GitHub had a problem (HTTP ${status}). Try again.`, true);
  }
  return new GithubError("io_error", `GitHub refused the request (HTTP ${status}).`, false);
}

function graphqlFailure(
  errors: readonly { type?: string | null | undefined }[],
  scope: "repo" | "read:project",
): GithubError {
  const types = errors.map((error) => error.type ?? "");
  if (types.includes("INSUFFICIENT_SCOPES")) {
    return new GithubError(
      "auth",
      `The token needs the ${scope} scope. Use Get token to make a new one.`,
      false,
    );
  }
  if (types.includes("FORBIDDEN")) {
    return new GithubError(
      "auth",
      "GitHub refused this request for that token. Check its scope in Setup.",
      false,
    );
  }
  if (types.includes("NOT_FOUND")) {
    return new GithubError("not_found", "GitHub could not find that for this token.", false);
  }
  if (types.includes("RATE_LIMITED")) {
    return new GithubError("io_error", "GitHub is limiting requests. Try again in a moment.", true);
  }
  return new GithubError("io_error", "GitHub could not answer that request.", false);
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
