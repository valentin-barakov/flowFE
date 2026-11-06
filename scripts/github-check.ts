// Checks the GitHub helpers, contracts, service, and pane state. No Electron and no live GitHub call.
//   npm run check:github
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createGithubService,
  GithubError,
  parseItemsPage,
  parsePrsResponse,
  parseProjectsResponse,
  parseRepoRows,
} from "../src/main/github-service.ts";
import {
  existingReviewFile,
  githubFullNameFromRemote,
  localRepoPath,
  originFullName,
} from "../src/main/pr-review-file.ts";
import {
  ciLabel,
  ciState,
  isDoneStatus,
  isRepoFullName,
  itemUrl,
  nextLink,
  PROJECT_ID,
  projectColumn,
  projectsReady,
  prsReady,
  relativeTime,
  reviewLabel,
  reviewState,
  shortRepoName,
} from "../src/shared/github.ts";
import { COMMANDS, GithubStatusSchema } from "../src/shared/ipc.ts";
import type { ChatStateName, RepoListItem, Settings } from "../src/shared/ipc.ts";
import {
  emptySlice,
  initialState,
  reducer,
  screenOf,
  sidebarRows,
  type AppState,
  type ChatSlice,
} from "../src/renderer/state.ts";

test("repo names are owner/name and cannot climb out of the path", () => {
  for (const good of ["octo/hello", "octo/hello.world", "a-b/c_d", "o/.github"]) {
    assert.equal(isRepoFullName(good), true, good);
  }
  for (const bad of [
    "octo",
    "octo/",
    "/hello",
    "octo/..",
    "octo/.",
    "octo/a/b",
    "octo/a b",
    "octo/hello\n",
    "octo/a?b=1",
    ".octo/hello",
    `${"o".repeat(40)}/hello`,
    `octo/${"x".repeat(101)}`,
  ]) {
    assert.equal(isRepoFullName(bad), false, bad);
  }
  assert.equal(shortRepoName("octo/hello"), "hello");
  assert.equal(shortRepoName("hello"), "hello");
});

test("project ids are PVT_ node ids", () => {
  assert.ok(PROJECT_ID.test("PVT_kwHOABCD-1_x"));
  for (const bad of ["PVT_", "pvt_abc", "PVT_a b", "PVT_a/../b", "PVT_a\n", "abc"]) {
    assert.equal(PROJECT_ID.test(bad), false, bad);
  }
});

test("an item URL is built from a clean repo and a positive number", () => {
  assert.equal(itemUrl("octo/hello", "pr", 12), "https://github.com/octo/hello/pull/12");
  assert.equal(itemUrl("octo/hello", "issue", 7), "https://github.com/octo/hello/issues/7");
  assert.equal(itemUrl("octo/..", "pr", 1), null);
  assert.equal(itemUrl("evil.example/x?y", "pr", 1), null);
  assert.equal(itemUrl("octo/hello", "pr", 0), null);
  assert.equal(itemUrl("octo/hello", "pr", 1.5), null);
  assert.equal(itemUrl("octo/hello", "pr", 1_000_000_000), null);
});

test("the Link header gives the next page", () => {
  assert.equal(
    nextLink(
      '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next", <https://api.github.com/user/repos?per_page=100&page=9>; rel="last"',
    ),
    "https://api.github.com/user/repos?per_page=100&page=2",
  );
  assert.equal(
    nextLink('<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"'),
    "https://api.github.com/x?page=3",
  );
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
  assert.equal(nextLink(""), null);
});

test("review and CI states map to short labels", () => {
  assert.equal(reviewState("APPROVED"), "approved");
  assert.equal(reviewState("CHANGES_REQUESTED"), "changes");
  assert.equal(reviewState("REVIEW_REQUIRED"), "required");
  assert.equal(reviewState(null), null);
  assert.equal(reviewState("SOMETHING_NEW"), null);
  assert.equal(ciState("SUCCESS"), "passing");
  assert.equal(ciState("FAILURE"), "failing");
  assert.equal(ciState("ERROR"), "failing");
  assert.equal(ciState("PENDING"), "pending");
  assert.equal(ciState("EXPECTED"), "pending");
  assert.equal(ciState(undefined), null);
  assert.equal(reviewLabel("changes"), "Changes requested");
  assert.equal(ciLabel("passing"), "CI passing");
});

test("done statuses are dropped and cards land in the Jira columns", () => {
  for (const done of ["Done", " done ", "CLOSED", "Completed", "shipped"]) {
    assert.equal(isDoneStatus(done), true, done);
  }
  for (const open of ["Todo", "In Progress", "Done soon", ""]) {
    assert.equal(isDoneStatus(open), false, open);
  }
  assert.equal(projectColumn(""), "todo");
  assert.equal(projectColumn("Todo"), "todo");
  assert.equal(projectColumn("Backlog"), "todo");
  assert.equal(projectColumn("In Progress"), "progress");
  assert.equal(projectColumn("Blocked"), "progress");
  assert.equal(projectColumn("In Review"), "review");
  assert.equal(projectColumn("Code review"), "review");
});

test("a section is ready only while its own token is saved", () => {
  const none = {
    repos: { tokenSet: false },
    projects: { tokenSet: false },
  };
  const reposOn = { ...none, repos: { tokenSet: true } };
  const projectsOn = { ...none, projects: { tokenSet: true } };
  assert.equal(prsReady(null), false);
  assert.equal(projectsReady(null), false);
  assert.equal(prsReady(none), false);
  assert.equal(projectsReady(none), false);
  assert.equal(prsReady(reposOn), true);
  assert.equal(projectsReady(reposOn), false);
  assert.equal(projectsReady(projectsOn), true);
  assert.equal(prsReady(projectsOn), false);
});

test("relative time", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(relativeTime("2026-11-06T11:59:40Z", now), "just now");
  assert.equal(relativeTime("2026-11-06T12:30:00Z", now), "just now");
  assert.equal(relativeTime("2026-11-06T11:30:00Z", now), "30m ago");
  assert.equal(relativeTime("2026-11-06T09:00:00Z", now), "3h ago");
  assert.equal(relativeTime("2026-11-04T12:00:00Z", now), "2d ago");
  assert.equal(relativeTime("2026-09-01T12:00:00Z", now), "2026-09-01");
  assert.equal(relativeTime("garbage", now), "");
});

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};
type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};
type Handler = (call: Call) => Reply;

const API = "https://api.github.com";
const REPO_TOKEN = "ghp_repos_token_value";
const PROJECT_TOKEN = "ghp_projects_token_value";

const box = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) =>
    Buffer.from(Buffer.from(text).toString("base64").split("").reverse().join("")),
  decryptString: (data: Buffer) =>
    Buffer.from(data.toString().split("").reverse().join(""), "base64").toString(),
};

function fakeFetch(handler: Handler, calls: Call[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const reply = handler(call);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as typeof globalThis.fetch;
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "github-check-"));
}

function makeService(dir: string, handler: Handler) {
  const calls: Call[] = [];
  const opened: string[] = [];
  const service = createGithubService({
    userDataDir: dir,
    secrets: box,
    fetch: fakeFetch(handler, calls),
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  return { service, calls, opened };
}

function graphqlCall(call: Call): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(call.body) as { query: string; variables: Record<string, unknown> };
}

/** Answers the two token checks, then hands every other call to `next`. */
function viewerOr(call: Call, next: Handler): Reply {
  if (call.url === `${API}/user`) return { status: 200, body: { login: "mona" } };
  if (call.url === `${API}/graphql` && graphqlCall(call).query.includes("viewer { login }")) {
    return { status: 200, body: { data: { viewer: { login: "mona" } } } };
  }
  return next(call);
}

async function repoService(handler: Handler) {
  const made = makeService(tempDir(), (call) => viewerOr(call, handler));
  await made.service.saveRepoToken({ token: REPO_TOKEN });
  made.calls.splice(0);
  return made;
}

async function projectService(handler: Handler) {
  const made = makeService(tempDir(), (call) => viewerOr(call, handler));
  await made.service.saveProjectToken({ token: PROJECT_TOKEN });
  made.calls.splice(0);
  return made;
}

const notFound: Handler = () => ({ status: 404, body: {} });
const isError = (code: string, retryable?: boolean) => (error: unknown) =>
  error instanceof GithubError &&
  error.code === code &&
  (retryable === undefined || error.retryable === retryable);

test("a repos token is checked before it is kept, and never leaves main", async () => {
  const dir = tempDir();
  const rejected = makeService(dir, () => ({ status: 401, body: {} }));
  await assert.rejects(
    () => rejected.service.saveRepoToken({ token: "nope" }),
    isError("auth", false),
  );
  assert.equal(rejected.service.status().repos.tokenSet, false);
  assert.equal(existsSync(path.join(dir, "github.bin")), false);

  const good = makeService(dir, (call) => viewerOr(call, notFound));
  const saved = await good.service.saveRepoToken({ token: REPO_TOKEN });
  assert.deepEqual(saved, {
    repos: { tokenSet: true, login: "mona", selected: [] },
    projects: { tokenSet: false, login: null, selected: [] },
  });
  assert.equal(good.calls[0]?.url, `${API}/user`);
  assert.equal(good.calls[0]?.headers.Authorization, `Bearer ${REPO_TOKEN}`);
  assert.equal(JSON.stringify(saved).includes(REPO_TOKEN), false);

  const disk = readFileSync(path.join(dir, "github.bin")).toString();
  assert.equal(disk.includes(REPO_TOKEN), false);
  assert.equal(disk.includes("mona"), false);

  const again = makeService(dir, notFound);
  assert.equal(again.service.status().repos.login, "mona");
  assert.equal(again.service.status().repos.tokenSet, true);
});

test("a projects token is checked through GraphQL and kept apart from the repos token", async () => {
  const dir = tempDir();
  const first = makeService(dir, (call) => viewerOr(call, notFound));
  await first.service.saveProjectToken({ token: PROJECT_TOKEN });
  const sent = first.calls[0];
  assert.equal(sent?.url, `${API}/graphql`);
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.headers.Authorization, `Bearer ${PROJECT_TOKEN}`);
  const status = first.service.status();
  assert.deepEqual(status.projects, { tokenSet: true, login: "mona", selected: [] });
  assert.equal(status.repos.tokenSet, false);
  assert.equal(JSON.stringify(status).includes(PROJECT_TOKEN), false);

  const bad = makeService(tempDir(), () => ({ status: 401, body: {} }));
  await assert.rejects(
    () => bad.service.saveProjectToken({ token: "nope" }),
    isError("auth", false),
  );
  assert.equal(bad.service.status().projects.tokenSet, false);
});

test("the repo list follows Link headers on api.github.com, stops at 10 pages, and skips odd names", async () => {
  const { service, calls } = await repoService((call) => {
    const page = Number(new URL(call.url).searchParams.get("page") ?? "1");
    return {
      status: 200,
      body: [
        { full_name: `octo/r${page}`, private: page === 2, archived: page === 3 },
        { full_name: "bad name", private: false, archived: false },
      ],
      headers:
        page < 3
          ? {
              Link: `<${API}/user/repos?per_page=100&page=${page + 1}>; rel="next", <${API}/user/repos?per_page=100&page=9>; rel="last"`,
            }
          : {},
    };
  });
  const listed = await service.repos();
  assert.equal(
    calls[0]?.url,
    `${API}/user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member`,
  );
  assert.deepEqual(
    listed.repos.map((repo) => [repo.fullName, repo.private, repo.archived]),
    [
      ["octo/r1", false, false],
      ["octo/r2", true, false],
      ["octo/r3", false, true],
    ],
  );
  assert.equal(listed.truncated, false);
  assert.equal(calls.length, 3);

  const endless = await repoService((call) => {
    const page = Number(new URL(call.url).searchParams.get("page") ?? "1");
    return {
      status: 200,
      body: [{ full_name: `octo/r${page}`, private: false, archived: false }],
      headers: { Link: `<${API}/user/repos?per_page=100&page=${page + 1}>; rel="next"` },
    };
  });
  const capped = await endless.service.repos();
  assert.equal(capped.repos.length, 10);
  assert.equal(capped.truncated, true);
  assert.equal(endless.calls.length, 10);

  const evil = await repoService(() => ({
    status: 200,
    body: [{ full_name: "octo/a", private: false, archived: false }],
    headers: { Link: '<https://evil.example/steal>; rel="next"' },
  }));
  const safe = await evil.service.repos();
  assert.equal(safe.repos.length, 1);
  assert.equal(safe.truncated, false);
  assert.equal(evil.calls.length, 1);
  assert.deepEqual(
    parseRepoRows([{ full_name: "octo/a" }, 5, { full_name: "octo/.." }]).map((repo) => repo.fullName),
    ["octo/a"],
  );
});

test("picked repos are checked, capped, kept after a restart, and cleared with the token", async () => {
  const dir = tempDir();
  const first = makeService(dir, (call) => viewerOr(call, notFound));
  assert.throws(() => first.service.selectRepos({ repos: ["octo/a"] }), isError("not_ready"));
  await first.service.saveRepoToken({ token: REPO_TOKEN });

  const picked = first.service.selectRepos({ repos: ["octo/a", "octo/b", "octo/a"] });
  assert.deepEqual(picked.repos.selected, ["octo/a", "octo/b"]);
  for (const bad of [["nope"], ["octo/.."], Array.from({ length: 31 }, (_, index) => `octo/r${index}`)]) {
    assert.throws(() => first.service.selectRepos({ repos: bad }), isError("invalid_input"));
  }
  assert.deepEqual(first.service.status().repos.selected, ["octo/a", "octo/b"]);

  const again = makeService(dir, notFound);
  assert.deepEqual(again.service.status().repos.selected, ["octo/a", "octo/b"]);

  const cleared = again.service.clearRepoToken();
  assert.deepEqual(cleared.repos, { tokenSet: false, login: null, selected: [] });
  assert.deepEqual(makeService(dir, notFound).service.status().repos.selected, []);
});

const PR_BODY = {
  data: {
    repository: {
      pullRequests: {
        totalCount: 72,
        nodes: [
          {
            number: 5,
            title: "Add cache",
            isDraft: true,
            updatedAt: "2026-11-06T09:00:00Z",
            author: { login: "mona" },
            headRefName: "feat/cache",
            baseRefName: "main",
            reviewDecision: "CHANGES_REQUESTED",
            viewerLatestReview: { state: "APPROVED" },
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
          },
          {
            number: 6,
            title: "Plain",
            isDraft: false,
            updatedAt: "2026-11-05T09:00:00Z",
            author: null,
            headRefName: "a",
            baseRefName: "main",
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
          "junk",
        ],
      },
    },
  },
};

test("pull requests: one GraphQL call for a picked repo, parsed, and refused otherwise", async () => {
  let reply: Reply = { status: 200, body: PR_BODY };
  const { service, calls } = await repoService(() => reply);
  service.selectRepos({ repos: ["octo/hello"] });

  await assert.rejects(() => service.prs({ repo: "octo/other" }), isError("invalid_input"));
  await assert.rejects(() => service.prs({ repo: "octo/.." }), isError("invalid_input"));
  assert.equal(calls.length, 0);

  const result = await service.prs({ repo: "octo/hello" });
  assert.equal(calls.length, 1);
  const sent = calls[0] as Call;
  assert.equal(sent.url, `${API}/graphql`);
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.Authorization, `Bearer ${REPO_TOKEN}`);
  const body = graphqlCall(sent);
  assert.deepEqual(body.variables, { owner: "octo", name: "hello", first: 50 });
  assert.equal(body.query.includes("states: OPEN"), true);
  assert.equal(body.query.includes("UPDATED_AT"), true);
  assert.equal(body.query.includes("viewerLatestReview"), true);

  assert.equal(result.total, 72);
  assert.deepEqual(result.prs, [
    {
      number: 5,
      title: "Add cache",
      author: "mona",
      headRefName: "feat/cache",
      baseRefName: "main",
      isDraft: true,
      updatedAt: "2026-11-06T09:00:00Z",
      review: "changes",
      approvedByYou: true,
      ci: "failing",
      hasReview: false,
    },
    {
      number: 6,
      title: "Plain",
      author: "",
      headRefName: "a",
      baseRefName: "main",
      isDraft: false,
      updatedAt: "2026-11-05T09:00:00Z",
      review: null,
      approvedByYou: false,
      ci: null,
      hasReview: false,
    },
  ]);

  reply = { status: 200, body: { data: { repository: null } } };
  await assert.rejects(() => service.prs({ repo: "octo/hello" }), isError("not_found", false));
  reply = { status: 200, body: { data: { nope: true } } };
  await assert.rejects(() => service.prs({ repo: "octo/hello" }), isError("io_error", true));
  reply = { status: 200, body: { errors: [{ type: "INSUFFICIENT_SCOPES", message: "x" }] } };
  await assert.rejects(
    () => service.prs({ repo: "octo/hello" }),
    (error) => isError("auth", false)(error) && /repo scope/.test((error as Error).message),
  );
  assert.equal(parsePrsResponse({ repository: null }), "missing");
  assert.equal(parsePrsResponse("nope"), null);
});

test("a saved pr-reviews/<number>.md is marked on the card and opened", async () => {
  const notes = path.join(tempDir(), "checkout", "pr-reviews", "5.md");
  const opened: string[] = [];
  const { service } = await repoService(() => ({ status: 200, body: PR_BODY }));
  service.selectRepos({ repos: ["octo/hello"] });
  const withNotes = createGithubService({
    userDataDir: tempDir(),
    secrets: box,
    fetch: fakeFetch((call) => viewerOr(call, () => ({ status: 200, body: PR_BODY })), []),
    openExternal: async () => {},
    reviewFile: (_repo, number) => (number === 5 ? notes : number === 6 ? "/tmp/secret.txt" : null),
    openPath: async (file) => {
      opened.push(file);
    },
  });
  await withNotes.saveRepoToken({ token: REPO_TOKEN });
  withNotes.selectRepos({ repos: ["octo/hello"] });

  const result = await withNotes.prs({ repo: "octo/hello" });
  assert.equal(result.prs[0]?.hasReview, true);
  assert.equal(result.prs[1]?.hasReview, false);

  await withNotes.openReview({ repo: "octo/hello", number: 5 });
  assert.deepEqual(opened, [notes]);
  await assert.rejects(() => withNotes.openReview({ repo: "octo/hello", number: 6 }), isError("not_found", false));
  await assert.rejects(() => withNotes.openReview({ repo: "octo/other", number: 5 }), isError("invalid_input"));
  await assert.rejects(() => service.openReview({ repo: "octo/hello", number: 5 }), isError("not_found", false));
});

test("the review file is pr-reviews/<number>.md in the checkout whose origin matches", () => {
  assert.equal(githubFullNameFromRemote("https://github.com/octo/hello.git"), "octo/hello");
  assert.equal(githubFullNameFromRemote("git@github.com:octo/hello.git"), "octo/hello");
  assert.equal(githubFullNameFromRemote("ssh://git@github.com/octo/hello.git"), "octo/hello");
  assert.equal(githubFullNameFromRemote("https://gitlab.com/octo/hello.git"), null);

  const root = tempDir();
  const match = path.join(root, "hello");
  const other = path.join(root, "other");
  writeOrigin(match, "https://github.com/octo/hello.git");
  writeOrigin(other, "git@github.com:octo/elsewhere.git");
  assert.equal(originFullName(match), "octo/hello");
  assert.equal(localRepoPath("octo/hello", [{ path: other }, { path: match }]), match);
  assert.equal(localRepoPath("octo/missing", [{ path: match }]), null);

  const notes = path.join(match, "pr-reviews");
  mkdirSync(notes);
  const file = path.join(notes, "5.md");
  writeFileSync(file, "# review\n");
  const found = existingReviewFile(match, 5);
  assert.equal(found !== null && found.endsWith(`${path.sep}pr-reviews${path.sep}5.md`), true);
  assert.equal(existingReviewFile(match, 6), null);

  const outside = tempDir();
  const escaped = path.join(outside, "5.md");
  writeFileSync(escaped, "nope\n");
  symlinkSync(escaped, path.join(notes, "9.md"));
  assert.equal(existingReviewFile(match, 9), null);
});

function writeOrigin(repo: string, url: string): void {
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
}

const ISSUE_ROW = {
  id: "PVTI_1",
  status: { name: "In Progress" },
  content: {
    __typename: "Issue",
    number: 7,
    title: "Fix login",
    state: "OPEN",
    repository: { nameWithOwner: "octo/hello" },
  },
};
const PR_ROW = {
  id: "PVTI_2",
  status: { name: "In Review" },
  content: {
    __typename: "PullRequest",
    number: 9,
    title: "Add cache",
    state: "OPEN",
    repository: { nameWithOwner: "octo/hello" },
  },
};
const CLOSED_ROW = {
  id: "PVTI_3",
  status: { name: "Todo" },
  content: {
    __typename: "Issue",
    number: 8,
    title: "Old",
    state: "CLOSED",
    repository: { nameWithOwner: "octo/hello" },
  },
};
const MERGED_ROW = {
  id: "PVTI_4",
  status: { name: "Todo" },
  content: {
    __typename: "PullRequest",
    number: 10,
    title: "Merged",
    state: "MERGED",
    repository: { nameWithOwner: "octo/hello" },
  },
};
const DONE_ROW = { ...ISSUE_ROW, id: "PVTI_5", status: { name: "Done" } };
const DRAFT_ROW = {
  id: "PVTI_6",
  status: null,
  content: { __typename: "DraftIssue", title: "Idea" },
};
const GONE_ROW = { id: "PVTI_7", status: { name: "Todo" }, content: null };

function itemsBody(nodes: unknown[], hasNextPage: boolean, endCursor: string | null) {
  return {
    status: 200,
    body: { data: { node: { items: { pageInfo: { hasNextPage, endCursor }, nodes } } } },
  };
}

test("projects: list, pick, and read items with the done filter, drafts kept", async () => {
  const { service, calls } = await projectService((call) => {
    const { query, variables } = graphqlCall(call);
    if (query.includes("projectsV2")) {
      return {
        status: 200,
        body: {
          data: {
            viewer: {
              projectsV2: {
                nodes: [
                  { id: "PVT_a1", title: "Roadmap", number: 1, closed: false },
                  { id: "PVT_b2", title: "Old", number: 2, closed: true },
                  { id: "bad id", title: "Odd", number: 3, closed: false },
                  null,
                ],
              },
            },
          },
        },
      };
    }
    if (query.includes("items(")) {
      return (variables.after ?? null) === null
        ? itemsBody([ISSUE_ROW, CLOSED_ROW, MERGED_ROW, DONE_ROW], true, "c1")
        : itemsBody([PR_ROW, DRAFT_ROW, GONE_ROW], false, "c2");
    }
    return { status: 404, body: {} };
  });

  const listed = await service.projects();
  assert.deepEqual(listed.projects, [{ id: "PVT_a1", title: "Roadmap" }]);

  assert.throws(
    () => service.selectProjects({ projects: [{ id: "bad id", title: "x" }] }),
    isError("invalid_input"),
  );
  assert.throws(
    () =>
      service.selectProjects({
        projects: Array.from({ length: 11 }, (_, index) => ({ id: `PVT_p${index}`, title: "p" })),
      }),
    isError("invalid_input"),
  );
  const picked = service.selectProjects({
    projects: [
      { id: "PVT_a1", title: "Roadmap" },
      { id: "PVT_a1", title: "Roadmap again" },
    ],
  });
  assert.deepEqual(picked.projects.selected, [{ id: "PVT_a1", title: "Roadmap again" }]);

  await assert.rejects(
    () => service.projectItems({ projectId: "PVT_zzz" }),
    isError("invalid_input"),
  );
  assert.equal(calls.length, 1);

  const page = await service.projectItems({ projectId: "PVT_a1" });
  assert.deepEqual(
    page.items.map((item) => [item.id, item.kind, item.repo, item.number, item.status]),
    [
      ["PVTI_1", "issue", "octo/hello", 7, "In Progress"],
      ["PVTI_2", "pr", "octo/hello", 9, "In Review"],
      ["PVTI_6", "draft", null, null, ""],
    ],
  );
  assert.equal(page.nextCursor, undefined);
  assert.equal(calls.length, 3);
  const firstCall = graphqlCall(calls[1] as Call);
  assert.deepEqual(firstCall.variables, { id: "PVT_a1", first: 50, after: null });
  assert.equal(graphqlCall(calls[2] as Call).variables.after, "c1");

  const resumed = await service.projectItems({ projectId: "PVT_a1", cursor: "c1" });
  assert.equal(resumed.items.length, 2);
  assert.equal(graphqlCall(calls[3] as Call).variables.after, "c1");
});

test("project items stop after four requests and hand back the cursor", async () => {
  let n = 0;
  const { service, calls } = await projectService(() => {
    n += 1;
    return itemsBody([CLOSED_ROW], true, `c${n}`);
  });
  service.selectProjects({ projects: [{ id: "PVT_a1", title: "Roadmap" }] });
  const page = await service.projectItems({ projectId: "PVT_a1" });
  assert.equal(page.items.length, 0);
  assert.equal(page.nextCursor, "c4");
  assert.equal(calls.length, 4);
});

test("project reads fail clearly: a missing project, a missing scope, and odd shapes", async () => {
  let reply: Reply = { status: 200, body: { data: { node: null } } };
  const { service } = await projectService(() => reply);
  service.selectProjects({ projects: [{ id: "PVT_a1", title: "Roadmap" }] });
  await assert.rejects(() => service.projectItems({ projectId: "PVT_a1" }), isError("not_found", false));
  reply = { status: 200, body: { data: { node: {} } } };
  await assert.rejects(() => service.projectItems({ projectId: "PVT_a1" }), isError("not_found", false));
  reply = { status: 200, body: { errors: [{ type: "INSUFFICIENT_SCOPES" }] } };
  await assert.rejects(
    () => service.projects(),
    (error) => isError("auth", false)(error) && /read:project/.test((error as Error).message),
  );
  reply = { status: 200, body: { data: { viewer: "nope" } } };
  await assert.rejects(() => service.projects(), isError("io_error", true));
  assert.equal(parseItemsPage({ node: null }), "missing");
  assert.equal(parseProjectsResponse(5), null);
});

test("open builds a GitHub URL from a clean name, and the token pages are a fixed table", async () => {
  const { service, opened } = await repoService(notFound);
  await service.open({ repo: "octo/hello", kind: "pr", number: 12 });
  await service.open({ repo: "octo/hello", kind: "issue", number: 7 });
  assert.deepEqual(opened, [
    "https://github.com/octo/hello/pull/12",
    "https://github.com/octo/hello/issues/7",
  ]);
  await assert.rejects(() => service.open({ repo: "octo/..", kind: "pr", number: 1 }), isError("invalid_input"));
  await assert.rejects(() => service.open({ repo: "evil.example/x?y", kind: "pr", number: 1 }), isError("invalid_input"));
  await assert.rejects(() => service.open({ repo: "octo/hello", kind: "pr", number: 0 }), isError("invalid_input"));

  const fresh = makeService(tempDir(), notFound);
  await assert.rejects(
    () => fresh.service.open({ repo: "octo/hello", kind: "pr", number: 1 }),
    isError("not_ready"),
  );
  await fresh.service.openTokenPage({ kind: "repos" });
  await fresh.service.openTokenPage({ kind: "projects" });
  assert.deepEqual(fresh.opened, [
    "https://github.com/settings/tokens/new?scopes=repo&description=Mango%20pull%20requests",
    "https://github.com/settings/tokens/new?scopes=read:project&description=Mango%20projects",
  ]);
  for (const bad of ["other", "__proto__", "toString", ""]) {
    await assert.rejects(
      () => fresh.service.openTokenPage({ kind: bad as "repos" }),
      isError("invalid_input"),
      bad,
    );
  }
  assert.equal(fresh.opened.length, 2);
});

test("each section needs its own token", async () => {
  const { service } = await repoService(notFound);
  await assert.rejects(() => service.projects(), isError("not_ready"));
  await assert.rejects(() => service.projectItems({ projectId: "PVT_a1" }), isError("not_ready"));
  assert.throws(
    () => service.selectProjects({ projects: [{ id: "PVT_a1", title: "x" }] }),
    isError("not_ready"),
  );

  await service.saveProjectToken({ token: PROJECT_TOKEN });
  const both = service.status();
  assert.equal(both.repos.tokenSet, true);
  assert.equal(both.projects.tokenSet, true);
  const text = JSON.stringify(both);
  assert.equal(text.includes(REPO_TOKEN) || text.includes(PROJECT_TOKEN), false);

  const withoutProjects = service.clearProjectToken();
  assert.equal(withoutProjects.projects.tokenSet, false);
  assert.equal(withoutProjects.repos.tokenSet, true);
  await assert.rejects(() => service.projects(), isError("not_ready"));

  service.clearRepoToken();
  await assert.rejects(() => service.repos(), isError("not_ready"));
  await assert.rejects(() => service.prs({ repo: "octo/hello" }), isError("not_ready"));
});

test("a failure reports the code and whether to retry", async () => {
  const rows: {
    label: string;
    status: number;
    headers?: Record<string, string>;
    code: "auth" | "not_found" | "io_error";
    retryable: boolean;
  }[] = [
    { label: "401", status: 401, code: "auth", retryable: false },
    { label: "403 scope", status: 403, code: "auth", retryable: false },
    { label: "403 rate limit", status: 403, headers: { "x-ratelimit-remaining": "0" }, code: "io_error", retryable: true },
    { label: "403 retry-after", status: 403, headers: { "retry-after": "30" }, code: "io_error", retryable: true },
    { label: "404", status: 404, code: "not_found", retryable: false },
    { label: "429", status: 429, code: "io_error", retryable: true },
    { label: "500", status: 500, code: "io_error", retryable: true },
    { label: "503", status: 503, code: "io_error", retryable: true },
    { label: "418", status: 418, code: "io_error", retryable: false },
  ];
  for (const row of rows) {
    let reply: Reply = { status: 200, body: [] };
    const { service } = await repoService(() => reply);
    reply = {
      status: row.status,
      body: {},
      ...(row.headers !== undefined ? { headers: row.headers } : {}),
    };
    await assert.rejects(() => service.repos(), isError(row.code, row.retryable), row.label);
  }

  for (const [label, errors, code, retryable] of [
    ["rate limited", [{ type: "RATE_LIMITED" }], "io_error", true],
    ["forbidden", [{ type: "FORBIDDEN" }], "auth", false],
    ["other", [{ type: "SOMETHING" }], "io_error", false],
  ] as const) {
    const { service } = await repoService(() => ({ status: 200, body: { errors } }));
    service.selectRepos({ repos: ["octo/hello"] });
    await assert.rejects(() => service.prs({ repo: "octo/hello" }), isError(code, retryable), label);
  }

  let current: typeof globalThis.fetch = fakeFetch((call) => viewerOr(call, notFound), []);
  const service = createGithubService({
    userDataDir: tempDir(),
    secrets: box,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      current(input, init)) as typeof globalThis.fetch,
    openExternal: async () => {},
  });
  await service.saveRepoToken({ token: REPO_TOKEN });
  current = (() => Promise.reject(new Error("offline"))) as typeof globalThis.fetch;
  await assert.rejects(() => service.repos(), isError("io_error", true));
  current = (async () => new Response("not-json", { status: 200 })) as typeof globalThis.fetch;
  await assert.rejects(() => service.repos(), isError("io_error", true));
});

test("a bad github.bin reads as empty, and save fails when encryption is off", async () => {
  const corruptDir = tempDir();
  writeFileSync(path.join(corruptDir, "github.bin"), "not a github file");
  const corrupt = makeService(corruptDir, notFound);
  assert.deepEqual(corrupt.service.status(), {
    repos: { tokenSet: false, login: null, selected: [] },
    projects: { tokenSet: false, login: null, selected: [] },
  });

  const badDir = tempDir();
  writeFileSync(
    path.join(badDir, "github.bin"),
    box.encryptString(
      JSON.stringify({
        repoToken: REPO_TOKEN,
        repoLogin: "mona",
        projectToken: null,
        projectLogin: null,
        selectedRepos: ["octo/.."],
        selectedProjects: [],
      }),
    ),
  );
  assert.equal(makeService(badDir, notFound).service.status().repos.tokenSet, false);

  const locked = createGithubService({
    userDataDir: tempDir(),
    secrets: { ...box, isEncryptionAvailable: () => false },
    fetch: fakeFetch((call) => viewerOr(call, notFound), []),
    openExternal: async () => {},
  });
  await assert.rejects(() => locked.saveRepoToken({ token: REPO_TOKEN }), isError("io_error", false));

  const missing = tempDir();
  const fresh = makeService(missing, notFound);
  assert.equal(fresh.service.clearRepoToken().repos.tokenSet, false);
  assert.equal(fresh.service.clearProjectToken().projects.tokenSet, false);
  assert.equal(existsSync(path.join(missing, "github.bin")), false);
});

test("the GitHub commands refuse input the window should never send", () => {
  const openReview = COMMANDS["flow:github.openReview"].input;
  assert.equal(openReview.safeParse({ repo: "octo/hello", number: 69 }).success, true);
  assert.equal(openReview.safeParse({ repo: "octo/hello", number: 0 }).success, false);
  assert.equal(openReview.safeParse({ repo: "octo/..", number: 69 }).success, false);
  assert.equal(openReview.safeParse({ repo: "octo/hello", number: 69, file: "/tmp/x.md" }).success, false);

  const open = COMMANDS["flow:github.open"].input;
  assert.equal(open.safeParse({ repo: "octo/hello", kind: "pr", number: 3 }).success, true);
  for (const bad of [
    { repo: "octo/hello", kind: "branch", number: 3 },
    { repo: "octo/hello", kind: "pr", number: 0 },
    { repo: "octo/hello", kind: "pr", number: 1.5 },
    { repo: "octo/..", kind: "pr", number: 3 },
    { repo: "https://evil.example", kind: "pr", number: 3 },
    { repo: "octo/hello", kind: "pr", number: 3, url: "https://evil.example" },
  ]) {
    assert.equal(open.safeParse(bad).success, false, JSON.stringify(bad));
  }

  const tokenPage = COMMANDS["flow:github.openTokenPage"].input;
  assert.equal(tokenPage.safeParse({ kind: "repos" }).success, true);
  assert.equal(tokenPage.safeParse({ kind: "projects" }).success, true);
  assert.equal(tokenPage.safeParse({ kind: "other" }).success, false);
  assert.equal(tokenPage.safeParse({ kind: "repos", url: "https://evil.example" }).success, false);

  const selectRepos = COMMANDS["flow:github.selectRepos"].input;
  assert.equal(selectRepos.safeParse({ repos: ["octo/hello"] }).success, true);
  assert.equal(selectRepos.safeParse({ repos: ["nope"] }).success, false);
  assert.equal(
    selectRepos.safeParse({ repos: Array.from({ length: 31 }, (_, index) => `octo/r${index}`) }).success,
    false,
  );

  const items = COMMANDS["flow:github.projectItems"].input;
  assert.equal(items.safeParse({ projectId: "PVT_a1" }).success, true);
  assert.equal(items.safeParse({ projectId: "PVT_a1", cursor: "c1" }).success, true);
  assert.equal(items.safeParse({ projectId: "a1" }).success, false);

  const token = COMMANDS["flow:github.saveRepoToken"].input;
  const trimmed = token.safeParse({ token: "  ghp_x  " });
  assert.equal(trimmed.success && trimmed.data.token, "ghp_x");
  assert.equal(token.safeParse({ token: "   " }).success, false);
  assert.equal(token.safeParse({ token: "x".repeat(501) }).success, false);

  const status = {
    repos: { tokenSet: true, login: "mona", selected: ["octo/hello"] },
    projects: { tokenSet: false, login: null, selected: [] },
  };
  assert.deepEqual(GithubStatusSchema.parse(status), status);
});

function repo(name: string, hasHistory: boolean, state: ChatStateName = "ready"): RepoListItem {
  return { name, state, pendingQuestion: state === "awaitingAnswer", hasHistory };
}

function chat(patch: Partial<ChatSlice> = {}): ChatSlice {
  return { ...emptySlice(), loaded: true, chatState: "ready", ...patch };
}

const settings: Settings = {
  folder: "/tmp/ws",
  model: "composer",
  mode: "agent",
  theme: "system",
  keySet: true,
  folderMissing: false,
  setupComplete: true,
};

function app(patch: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    booted: true,
    settings,
    repos: [repo("api", true), repo("web", true)],
    view: { kind: "repo", repo: "api" },
    chats: { api: chat(), web: chat() },
    ...patch,
  };
}

function panes(state: AppState): [boolean, boolean, boolean] {
  return [state.jiraOpen, state.githubPrsOpen, state.githubProjectsOpen];
}

test("the three panes are never open together", () => {
  const prs = reducer(app(), { type: "open-github-prs" });
  assert.deepEqual(panes(prs), [false, true, false]);
  assert.equal(screenOf(prs), "githubPrs");
  const projects = reducer(prs, { type: "open-github-projects" });
  assert.deepEqual(panes(projects), [false, false, true]);
  assert.equal(screenOf(projects), "githubProjects");
  const jira = reducer(projects, { type: "open-jira" });
  assert.deepEqual(panes(jira), [true, false, false]);
  assert.equal(screenOf(jira), "jira");
  assert.deepEqual(panes(reducer(jira, { type: "open-github-prs" })), [false, true, false]);
});

test("Back from a GitHub pane restores the chat, Rules, or New chat that was open", () => {
  const opened = reducer(app(), { type: "open-github-prs" });
  assert.deepEqual(opened.view, { kind: "repo", repo: "api" });
  const closed = reducer(opened, { type: "close-github-prs" });
  assert.equal(screenOf(closed), "chat");
  assert.equal(
    screenOf(
      reducer(reducer(app({ instructionsOpen: true }), { type: "open-github-projects" }), {
        type: "close-github-projects",
      }),
    ),
    "instructions",
  );
  const home = app({ view: { kind: "home" } });
  assert.equal(screenOf(reducer(home, { type: "open-github-prs" })), "githubPrs");
  assert.equal(
    screenOf(reducer(reducer(home, { type: "open-github-prs" }), { type: "close-github-prs" })),
    "home",
  );
  assert.equal(reducer(app(), { type: "close-github-prs" }).githubPrsOpen, false);
  assert.equal(reducer(app(), { type: "close-github-projects" }).githubProjectsOpen, false);
  const other = reducer(reducer(app(), { type: "open-github-projects" }), { type: "close-github-prs" });
  assert.equal(other.githubProjectsOpen, true);
});

test("a left-menu agent, New chat, and Implement leave every pane", () => {
  for (const open of ["open-github-prs", "open-github-projects", "open-jira"] as const) {
    const opened = reducer(app(), { type: open });
    assert.deepEqual(panes(reducer(opened, { type: "open-repo", repo: "web" })), [false, false, false]);
    assert.deepEqual(panes(reducer(opened, { type: "open-home" })), [false, false, false]);
    const implement = reducer(opened, { type: "implement-ticket", text: "implement ticket x @" });
    assert.deepEqual(panes(implement), [false, false, false]);
    assert.equal(screenOf(implement), "home");
    assert.equal(implement.homePickFolder, true);
  }
});

test("Setup wins over a GitHub pane, and closing Setup returns to it", () => {
  const opened = reducer(app(), { type: "open-github-projects" });
  const editing = reducer(opened, { type: "edit-setup" });
  assert.equal(editing.githubProjectsOpen, true);
  assert.equal(screenOf(editing), "setup");
  assert.equal(screenOf(reducer(editing, { type: "close-setup" })), "githubProjects");
});

test("while any pane is open no repo row is selected, and a reply under it is unseen until Back", () => {
  const quiet = app({
    repos: [repo("api", false), repo("web", true)],
    chats: { api: chat(), web: chat() },
  });
  assert.deepEqual(sidebarRows(quiet).map((row) => [row.name, row.active]), [
    ["api", true],
    ["web", false],
  ]);
  for (const open of ["open-github-prs", "open-github-projects"] as const) {
    assert.deepEqual(
      sidebarRows(reducer(quiet, { type: open })).map((row) => [row.name, row.active]),
      [
        ["api", false],
        ["web", false],
      ],
    );
  }

  const opened = reducer(
    app({
      chats: { api: chat({ chatState: "streaming", activeRunId: "r1" }), web: chat() },
    }),
    { type: "open-github-prs" },
  );
  const done = reducer(opened, {
    type: "event",
    event: { type: "chat.done", repo: "api", runId: "r1", messageId: "m1", stopReason: "end" },
  });
  assert.equal(done.chats.api?.unseen, true);
  assert.equal(reducer(done, { type: "close-github-prs" }).chats.api?.unseen, false);
});
