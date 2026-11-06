// Checks the Jira helpers and the Jira service. No Electron and no live Jira call.
//   node --disable-warning=ExperimentalWarning --experimental-strip-types --import ./scripts/repos-check-resolve.mjs scripts/jira-check.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ChatStateName,
  RepoListItem,
  Settings,
} from "../src/shared/ipc.ts";
import {
  emptySlice,
  initialState,
  reducer,
  screenOf,
  sidebarRows,
  type AppState,
  type ChatSlice,
} from "../src/renderer/state.ts";
import {
  ASSIGNED_JQL,
  ISSUE_KEY,
  implementPrompt,
  issueBrowseUrl,
  jiraReady,
  jiraSiteOrigin,
  JIRA_PAGE_SIZE,
  siteLabel,
  ticketColumn,
} from "../src/shared/jira.ts";
import {
  createJiraService,
  JiraError,
  parseSearchResponse,
  type JiraService,
} from "../src/main/jira-service.ts";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};
type Reply = { status: number; body: unknown };
type Handler = (call: Call) => Reply;

const box = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) =>
    Buffer.from(
      Buffer.from(text).toString("base64").split("").reverse().join(""),
    ),
  decryptString: (data: Buffer) =>
    Buffer.from(
      data.toString().split("").reverse().join(""),
      "base64",
    ).toString(),
};

const ISSUE_ROW = {
  id: "1",
  key: "ABC-1",
  fields: {
    summary: "Fix it",
    status: {
      name: "In Progress",
      statusCategory: { name: "In Progress" },
    },
    issuetype: { name: "Bug" },
    project: { name: "Alpha" },
    updated: "2026-11-06T10:00:00.000+0000",
  },
};

function searchOk(call: Call): Reply {
  const body = JSON.parse(call.body) as { nextPageToken?: string };
  return {
    status: 200,
    body: {
      issues: [ISSUE_ROW, { id: "2", key: "bad key", fields: {} }],
      ...(body.nextPageToken === undefined ? { nextPageToken: "next-1" } : {}),
    },
  };
}

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
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function makeService(dir: string, handler: Handler) {
  const calls: Call[] = [];
  const opened: string[] = [];
  const service: JiraService = createJiraService({
    userDataDir: dir,
    secrets: box,
    fetch: fakeFetch(handler, calls),
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  return { service, calls, opened };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "jira-check-"));
}

function authHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
}

test("the JQL is bounded, assigned, not done, and newest first", () => {
  assert.equal(
    ASSIGNED_JQL,
    "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
  );
  assert.equal(ASSIGNED_JQL.includes("assignee = currentUser()"), true);
  assert.equal(ASSIGNED_JQL.includes("statusCategory != Done"), true);
});

test("issue keys and browse URLs are strict", () => {
  assert.ok(ISSUE_KEY.test("ABC-12"));
  assert.ok(ISSUE_KEY.test("A1_B-7"));
  for (const bad of [
    "abc-1",
    "ABC-",
    "ABC 1",
    "ABC-1/../x",
    "-1",
    "A-1",
    "ABC-1\n",
    "ABC-1234567890",
  ]) {
    assert.equal(ISSUE_KEY.test(bad), false, bad);
  }
  assert.equal(
    issueBrowseUrl("https://acme.atlassian.net", "ABC-12"),
    "https://acme.atlassian.net/browse/ABC-12",
  );
  assert.equal(
    issueBrowseUrl("https://acme.atlassian.net/jira/path", "ABC-12"),
    "https://acme.atlassian.net/browse/ABC-12",
  );
  assert.equal(issueBrowseUrl("http://acme.atlassian.net", "ABC-12"), null);
  assert.equal(issueBrowseUrl("https://evil.example", "ABC-12"), null);
  assert.equal(
    issueBrowseUrl("https://acme.atlassian.net", "ABC-12/../x"),
    null,
  );
});

test("a site is https and exactly one label under atlassian.net", () => {
  assert.equal(
    jiraSiteOrigin("https://acme.atlassian.net"),
    "https://acme.atlassian.net",
  );
  assert.equal(
    jiraSiteOrigin("  https://Acme.atlassian.net/jira  "),
    "https://acme.atlassian.net",
  );
  for (const bad of [
    "http://acme.atlassian.net",
    "https://acme.atlassian.net:8443",
    "https://user:pw@acme.atlassian.net",
    "https://acme.atlassian.net.evil.com",
    "https://evil.com",
    "https://127.0.0.1",
    "https://localhost",
    "javascript:alert(1)",
    "https://.atlassian.net",
    "not a url",
  ]) {
    assert.equal(jiraSiteOrigin(bad), null, bad);
  }
});

test("a search response keeps good rows and the next-page token", () => {
  const page = parseSearchResponse({
    issues: [ISSUE_ROW, { key: "x", fields: {} }, 5],
    nextPageToken: "n1",
  });
  assert.deepEqual(page, {
    issues: [
      {
        key: "ABC-1",
        summary: "Fix it",
        status: "In Progress",
        statusCategory: "In Progress",
        type: "Bug",
        project: "Alpha",
        updated: "2026-11-06T10:00:00.000+0000",
      },
    ],
    nextPageToken: "n1",
  });
  assert.equal(parseSearchResponse({ issues: [] })?.nextPageToken, null);
  assert.equal(parseSearchResponse("nope"), null);
});

test("Implement opens New chat with the ticket prompt and asks for a folder", () => {
  const text = implementPrompt("https://acme.atlassian.net/browse/ABC-1");
  assert.equal(text, "implement ticket https://acme.atlassian.net/browse/ABC-1 @");
  const opened = reducer(app({ jiraOpen: true }), { type: "implement-ticket", text });
  assert.equal(opened.jiraOpen, false);
  assert.equal(screenOf(opened), "home");
  assert.equal(opened.homeDraft, text);
  assert.equal(opened.homeNotice, null);
  assert.equal(opened.homePickFolder, true);
  assert.equal(reducer(opened, { type: "open-home" }).homePickFolder, false);
});

test("tickets land in To Do, In Progress, or In Review", () => {
  assert.equal(ticketColumn("To Do", "To Do"), "todo");
  assert.equal(ticketColumn("Scoping", "To Do"), "todo");
  assert.equal(ticketColumn("Scoping", ""), "todo");
  assert.equal(ticketColumn("In Progress", "In Progress"), "progress");
  assert.equal(ticketColumn("Blocked", "In Progress"), "progress");
  assert.equal(ticketColumn("Code review", "In Progress"), "review");
  assert.equal(ticketColumn("In Review", "In Progress"), "review");
  assert.equal(ticketColumn("Ready for review", ""), "review");
  assert.equal(ticketColumn("Mystery", ""), "progress");
});

test("save, search, a site change, open, and clear", async () => {
  const dir = tempDir();
  const { service, calls, opened } = makeService(dir, (call) => {
    if (call.url.endsWith("/rest/api/3/search/jql")) return searchOk(call);
    return { status: 404, body: {} };
  });

  await assert.rejects(
    () =>
      Promise.resolve().then(() =>
        service.saveAccount({
          email: "me@example.com",
          site: "https://acme.atlassian.net",
        }),
      ),
    (error) => error instanceof JiraError && error.code === "not_ready",
  );
  assert.throws(
    () =>
      service.saveAccount({
        email: "me@example.com",
        site: "https://evil.example",
        token: "jira-token-value",
      }),
    (error) => error instanceof JiraError && error.code === "invalid_input",
  );
  assert.equal(calls.length, 0);

  const saved = service.saveAccount({
    email: "me@example.com",
    site: "https://acme.atlassian.net/jira",
    token: "jira-token-value",
  });
  assert.deepEqual(saved, {
    email: "me@example.com",
    site: "https://acme.atlassian.net",
    tokenSet: true,
  });
  assert.equal(JSON.stringify(saved).includes("jira-token-value"), false);

  const disk = readFileSync(path.join(dir, "jira.bin")).toString();
  assert.equal(disk.includes("jira-token-value"), false);
  assert.equal(disk.includes("me@example.com"), false);

  const first = await service.issues({});
  assert.equal(first.issues.length, 1);
  assert.equal(first.nextPageToken, "next-1");
  const search = calls[0];
  assert.equal(search?.url, "https://acme.atlassian.net/rest/api/3/search/jql");
  assert.equal(search?.method, "POST");
  assert.equal(
    search?.headers.Authorization,
    authHeader("me@example.com", "jira-token-value"),
  );
  const searchBody = JSON.parse(search?.body ?? "{}") as {
    jql: string;
    maxResults: number;
    fields: string[];
    nextPageToken?: string;
  };
  assert.equal(searchBody.jql, ASSIGNED_JQL);
  assert.equal(searchBody.maxResults, JIRA_PAGE_SIZE);
  assert.deepEqual(searchBody.fields, [
    "summary",
    "status",
    "issuetype",
    "project",
    "updated",
  ]);
  assert.equal(searchBody.nextPageToken, undefined);

  await service.issues({ pageToken: "next-1" });
  const paged = JSON.parse(calls[1]?.body ?? "{}") as {
    nextPageToken?: string;
  };
  assert.equal(paged.nextPageToken, "next-1");

  service.saveAccount({
    email: "me@example.com",
    site: "https://other.atlassian.net",
  });
  await service.issues({});
  assert.equal(
    calls[2]?.url,
    "https://other.atlassian.net/rest/api/3/search/jql",
  );
  assert.equal(
    calls[2]?.headers.Authorization,
    authHeader("me@example.com", "jira-token-value"),
  );

  const again = makeService(dir, (call) =>
    call.url.endsWith("/rest/api/3/search/jql")
      ? searchOk(call)
      : { status: 404, body: {} },
  );
  assert.equal(again.service.status().tokenSet, true);
  assert.equal(again.service.status().site, "https://other.atlassian.net");

  await service.open("ABC-1");
  assert.equal(opened.at(-1), "https://other.atlassian.net/browse/ABC-1");
  await assert.rejects(
    () => service.open("ABC-1/../x"),
    (error) => error instanceof JiraError && error.code === "invalid_input",
  );

  const gone = service.clear();
  assert.deepEqual(gone, { email: null, site: null, tokenSet: false });
  await assert.rejects(
    () => service.issues({}),
    (error) => error instanceof JiraError && error.code === "not_ready",
  );
  await assert.rejects(
    () => service.open("ABC-1"),
    (error) => error instanceof JiraError && error.code === "not_ready",
  );
});

test("a rejected token stays saved and is not sent anywhere but the stored site", async () => {
  const dir = tempDir();
  const { service, calls } = makeService(dir, () => ({
    status: 401,
    body: {},
  }));
  service.saveAccount({
    email: "me@example.com",
    site: "https://acme.atlassian.net",
    token: "jira-token-value",
  });
  await assert.rejects(
    () => service.issues({}),
    (error) =>
      error instanceof JiraError &&
      error.code === "auth" &&
      /API token/.test(error.message),
  );
  assert.equal(service.status().tokenSet, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://acme.atlassian.net/rest/api/3/search/jql",
  );
});

test("a search failure reports the code and whether to retry", async () => {
  const rows: {
    label: string;
    code: "auth" | "not_found" | "io_error";
    retryable: boolean;
    fetch: typeof globalThis.fetch;
  }[] = [
    { label: "403", code: "auth", retryable: false, fetch: statusFetch(403) },
    { label: "404", code: "not_found", retryable: false, fetch: statusFetch(404) },
    { label: "429", code: "io_error", retryable: true, fetch: statusFetch(429) },
    { label: "500", code: "io_error", retryable: true, fetch: statusFetch(500) },
    { label: "503", code: "io_error", retryable: true, fetch: statusFetch(503) },
    {
      label: "unreadable page",
      code: "io_error",
      retryable: true,
      fetch: fakeFetch(() => ({ status: 200, body: { nope: true } }), []),
    },
    {
      label: "network",
      code: "io_error",
      retryable: true,
      fetch: (() => Promise.reject(new Error("offline"))) as typeof globalThis.fetch,
    },
    {
      label: "unreadable",
      code: "io_error",
      retryable: true,
      fetch: (async () => new Response("not-json", { status: 200 })) as typeof globalThis.fetch,
    },
  ];
  for (const row of rows) {
    const service = createJiraService({
      userDataDir: tempDir(),
      secrets: box,
      fetch: row.fetch,
      openExternal: async () => {},
    });
    service.saveAccount({
      email: "me@example.com",
      site: "https://acme.atlassian.net",
      token: "jira-token-value",
    });
    await assert.rejects(
      () => service.issues({}),
      (error) =>
        error instanceof JiraError &&
        error.code === row.code &&
        error.retryable === row.retryable,
      row.label,
    );
  }
});

test("a bad jira.bin reads as empty, and save fails when encryption is off", () => {
  const corruptDir = tempDir();
  writeFileSync(path.join(corruptDir, "jira.bin"), "not a jira file");
  const corrupt = makeService(corruptDir, () => ({ status: 200, body: {} }));
  assert.deepEqual(corrupt.service.status(), {
    email: null,
    site: null,
    tokenSet: false,
  });

  const badDir = tempDir();
  writeFileSync(
    path.join(badDir, "jira.bin"),
    box.encryptString(
      JSON.stringify({
        email: "me@example.com",
        site: "https://evil.example",
        token: "jira-token-value",
      }),
    ),
  );
  const badSite = makeService(badDir, () => ({ status: 200, body: {} }));
  assert.deepEqual(badSite.service.status(), {
    email: null,
    site: null,
    tokenSet: false,
  });

  const locked = createJiraService({
    userDataDir: tempDir(),
    secrets: { ...box, isEncryptionAvailable: () => false },
    openExternal: async () => {},
  });
  assert.throws(
    () =>
      locked.saveAccount({
        email: "me@example.com",
        site: "https://acme.atlassian.net",
        token: "jira-token-value",
      }),
    (error) =>
      error instanceof JiraError &&
      error.code === "io_error" &&
      error.retryable === false,
  );

  const missing = tempDir();
  const fresh = makeService(missing, () => ({ status: 200, body: {} }));
  assert.deepEqual(fresh.service.clear(), {
    email: null,
    site: null,
    tokenSet: false,
  });
  assert.equal(existsSync(path.join(missing, "jira.bin")), false);
});

function statusFetch(status: number): typeof globalThis.fetch {
  return fakeFetch(() => ({ status, body: {} }), []);
}

function repo(
  name: string,
  hasHistory: boolean,
  state: ChatStateName = "ready",
): RepoListItem {
  return {
    name,
    state,
    pendingQuestion: state === "awaitingAnswer",
    hasHistory,
  };
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

test("opening and closing Jira leaves the chat on screen as it was", () => {
  const opened = reducer(app(), { type: "open-jira" });
  assert.equal(opened.jiraOpen, true);
  assert.deepEqual(opened.view, { kind: "repo", repo: "api" });
  assert.equal(screenOf(opened), "jira");
  const closed = reducer(opened, { type: "close-jira" });
  assert.equal(closed.jiraOpen, false);
  assert.equal(screenOf(closed), "chat");
  assert.deepEqual(closed.view, { kind: "repo", repo: "api" });
});

test("Back returns to Rules, New chat, or the chat, whichever was open", () => {
  const rules = app({ instructionsOpen: true });
  assert.equal(
    screenOf(
      reducer(reducer(rules, { type: "open-jira" }), { type: "close-jira" }),
    ),
    "instructions",
  );
  const home = app({ view: { kind: "home" } });
  assert.equal(screenOf(reducer(home, { type: "open-jira" })), "jira");
  assert.equal(
    screenOf(
      reducer(reducer(home, { type: "open-jira" }), { type: "close-jira" }),
    ),
    "home",
  );
});

test("a left-menu agent, even the chat underneath, and New chat leave the list", () => {
  const opened = reducer(app(), { type: "open-jira" });
  const sameChat = reducer(opened, { type: "open-repo", repo: "api" });
  assert.equal(sameChat.jiraOpen, false);
  assert.equal(screenOf(sameChat), "chat");
  const other = reducer(opened, { type: "open-repo", repo: "web" });
  assert.equal(other.jiraOpen, false);
  assert.deepEqual(other.view, { kind: "repo", repo: "web" });
  const home = reducer(opened, { type: "open-home" });
  assert.equal(home.jiraOpen, false);
  assert.equal(screenOf(home), "home");
});

test("Setup wins over the list, and closing Setup returns to the list", () => {
  const opened = reducer(app(), { type: "open-jira" });
  const editing = reducer(opened, { type: "edit-setup" });
  assert.equal(editing.jiraOpen, true);
  assert.equal(screenOf(editing), "setup");
  assert.equal(screenOf(reducer(editing, { type: "close-setup" })), "jira");
  const incomplete = app({
    jiraOpen: true,
    settings: { ...settings, setupComplete: false },
  });
  assert.equal(screenOf(incomplete), "setup");
});

test("while the list is open no repo row is selected, and the chat underneath keeps its row", () => {
  const quiet = app({
    repos: [repo("api", false), repo("web", true)],
    chats: { api: chat(), web: chat() },
  });
  assert.deepEqual(
    sidebarRows(quiet).map((row) => [row.name, row.active]),
    [
      ["api", true],
      ["web", false],
    ],
  );
  const opened = reducer(quiet, { type: "open-jira" });
  assert.deepEqual(
    sidebarRows(opened).map((row) => [row.name, row.active]),
    [
      ["api", false],
      ["web", false],
    ],
  );
});

test("a reply that finishes under the list is unseen until Back", () => {
  const opened = reducer(
    app({
      chats: {
        api: chat({ chatState: "streaming", activeRunId: "r1" }),
        web: chat(),
      },
    }),
    { type: "open-jira" },
  );
  const done = reducer(opened, {
    type: "event",
    event: {
      type: "chat.done",
      repo: "api",
      runId: "r1",
      messageId: "m1",
      stopReason: "end",
    },
  });
  assert.equal(done.chats.api?.unseen, true);
  const closed = reducer(done, { type: "close-jira" });
  assert.equal(closed.chats.api?.unseen, false);
  assert.equal(reducer(app(), { type: "close-jira" }).jiraOpen, false);
});

test("the pane is ready only when email, site, and token are all saved", () => {
  assert.equal(jiraReady(null), false);
  assert.equal(
    jiraReady({
      email: "me@example.com",
      site: "https://acme.atlassian.net",
      tokenSet: false,
    }),
    false,
  );
  assert.equal(
    jiraReady({
      email: null,
      site: "https://acme.atlassian.net",
      tokenSet: true,
    }),
    false,
  );
  assert.equal(
    jiraReady({ email: "me@example.com", site: null, tokenSet: true }),
    false,
  );
  assert.equal(
    jiraReady({
      email: "me@example.com",
      site: "https://acme.atlassian.net",
      tokenSet: true,
    }),
    true,
  );
  assert.equal(siteLabel("https://acme.atlassian.net"), "acme");
  assert.equal(siteLabel(null), "");
});
