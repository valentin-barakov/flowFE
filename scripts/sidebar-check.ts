// Checks which left-menu rows remain after a chat is cleared. No Electron and no SDK.
//   node --disable-warning=ExperimentalWarning --experimental-strip-types --import ./scripts/repos-check-resolve.mjs scripts/sidebar-check.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ChatStateName, RepoListItem, Settings } from "../src/shared/ipc.ts";
import { emptySlice, initialState, reducer, shouldLeaveAfterReset, sidebarRows, type AppState, type ChatSlice } from "../src/renderer/state.ts";

function repo(name: string, hasHistory: boolean, state: ChatStateName = "ready"): RepoListItem {
  return { name, state, pendingQuestion: state === "awaitingAnswer", hasHistory };
}

function chat(patch: Partial<ChatSlice> = {}): ChatSlice {
  return { ...emptySlice(), loaded: true, chatState: "ready", ...patch };
}

function app(repos: RepoListItem[], view: AppState["view"], chats: AppState["chats"] = {}): AppState {
  return { ...initialState, booted: true, repos, view, chats };
}

function cleared(state: AppState, repoName: string): AppState {
  const next = reducer(state, { type: "reset-chat", repo: repoName });
  if (shouldLeaveAfterReset(state, repoName)) return reducer(next, { type: "open-home" });
  return next;
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

test("history, the open chat, a busy repo, an unseen reply, and a banner are listed", () => {
  const state = app(
    [repo("api", true), repo("web", false), repo("worker", false, "streaming"), repo("wait", false, "awaitingAnswer"), repo("quiet", false)],
    { kind: "repo", repo: "web" },
    {
      worker: chat({ chatState: "streaming" }),
      wait: chat({ chatState: "awaitingAnswer" }),
      quiet: chat({ unseen: true }),
      bad: chat({ banner: { title: "Agent error", body: "nope", retryable: true, setup: false } }),
    },
  );
  const withBanner = app(
    [...state.repos, repo("bad", false)],
    state.view,
    state.chats,
  );
  assert.deepEqual(
    sidebarRows(withBanner).map((row) => [row.name, row.status, row.active, row.unseen]),
    [
      ["api", "idle", false, false],
      ["web", "idle", true, false],
      ["worker", "running", false, false],
      ["wait", "waiting", false, false],
      ["quiet", "idle", false, true],
      ["bad", "error", false, false],
    ],
  );
});

test("an idle repo with no history, no banner, and no unseen reply is omitted", () => {
  const state = app([repo("api", false), repo("web", true)], { kind: "home" });
  assert.deepEqual(sidebarRows(state).map((row) => row.name), ["web"]);
});

test("stopping is shown as running", () => {
  const state = app([repo("api", false, "stopping")], { kind: "home" }, { api: chat({ chatState: "stopping" }) });
  assert.equal(sidebarRows(state)[0]?.status, "running");
});

test("clearing a background chat drops it and leaves the open chat", () => {
  const state = app(
    [repo("api", true), repo("web", true)],
    { kind: "repo", repo: "web" },
    { api: chat({ unseen: true }), web: chat() },
  );
  const next = cleared(state, "api");
  assert.equal(shouldLeaveAfterReset(state, "api"), false);
  assert.deepEqual(sidebarRows(next).map((row) => row.name), ["web"]);
  assert.equal(next.view.kind, "repo");
  assert.equal(next.chats.api?.unseen, false);
  assert.equal(next.repos.find((row) => row.name === "api")?.hasHistory, false);
});

test("clearing the open chat in a multi-repo workspace returns home and drops the row", () => {
  const state = app(
    [repo("api", true), repo("web", true)],
    { kind: "repo", repo: "api" },
    { api: chat(), web: chat() },
  );
  const openRules = { ...state, instructionsOpen: true };
  const next = cleared(openRules, "api");
  assert.equal(shouldLeaveAfterReset(openRules, "api"), true);
  assert.deepEqual(next.view, { kind: "home" });
  assert.equal(next.instructionsOpen, false);
  assert.deepEqual(sidebarRows(next).map((row) => row.name), ["web"]);
});

test("a one-repo workspace stays on that chat after a clear", () => {
  const state = app([repo(".", true)], { kind: "repo", repo: "." }, { ".": chat() });
  const next = cleared(state, ".");
  assert.equal(shouldLeaveAfterReset(state, "."), false);
  assert.deepEqual(next.view, { kind: "repo", repo: "." });
  assert.equal(sidebarRows(next)[0]?.active, true);
});

test("a missing folder keeps the row because the folder banner comes back", () => {
  const state = app([repo("api", true), repo("web", true)], { kind: "home" }, { api: chat({ unseen: true }) });
  const missing = reducer({ ...state, settings: { ...settings, folderMissing: true } }, { type: "reset-chat", repo: "api" });
  assert.equal(missing.chats.api?.banner?.title, "Folder missing");
  assert.deepEqual(sidebarRows(missing).map((row) => row.name), ["api", "web"]);
  assert.equal(sidebarRows(missing)[0]?.status, "error");
});
