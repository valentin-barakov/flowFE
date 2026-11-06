// Checks repo discovery, two sessions at once, and the cap of 7. No Electron and no SDK.
//   node --disable-warning=ExperimentalWarning --experimental-strip-types --import ./scripts/repos-check-resolve.mjs scripts/repos-check.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FlowEvent } from "../src/shared/ipc.ts";
import type { AskUser } from "../src/shared/questions.ts";
import type { AgentService } from "../src/main/agent-service.ts";
import { SessionError } from "../src/main/chat-session.ts";
import { createSessionManager } from "../src/main/session-manager.ts";
import { createSettingsStore, type SecretBox } from "../src/main/settings-store.ts";

const secrets: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain),
  decryptString: (encrypted) => encrypted.toString(),
};

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "flowfe-repos-"));
}

function gitRepo(dir: string): void {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
}

test("a git workspace is the only repo", () => {
  const root = workspace();
  try {
    gitRepo(root);
    mkdirSync(path.join(root, "child"));
    gitRepo(path.join(root, "child"));
    const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
    assert.deepEqual(store.listRepos(root), [{ name: ".", path: realpathSync(root) }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child git directories are repos, and a folder with none is itself", () => {
  const root = workspace();
  try {
    const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
    assert.deepEqual(store.listRepos(root).map((repo) => repo.name), ["."]);
    mkdirSync(path.join(root, "web"));
    gitRepo(path.join(root, "web"));
    mkdirSync(path.join(root, "api"));
    gitRepo(path.join(root, "api"));
    mkdirSync(path.join(root, ".hidden"));
    gitRepo(path.join(root, ".hidden"));
    assert.deepEqual(store.listRepos(root).map((repo) => repo.name), ["api", "web"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child directory named my repo is skipped", () => {
  const root = workspace();
  try {
    mkdirSync(path.join(root, "my repo"));
    gitRepo(path.join(root, "my repo"));
    mkdirSync(path.join(root, "a@b"));
    gitRepo(path.join(root, "a@b"));
    mkdirSync(path.join(root, "api"));
    gitRepo(path.join(root, "api"));
    const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
    assert.deepEqual(store.listRepos(root).map((repo) => repo.name), ["api"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink to a repo is not a second repo", () => {
  const root = workspace();
  try {
    mkdirSync(path.join(root, "api"));
    gitRepo(path.join(root, "api"));
    symlinkSync(path.join(root, "api"), path.join(root, "alias"));
    const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
    const repos = store.listRepos(root);
    assert.equal(repos.length, 1);
    assert.equal(repos[0]?.name, "alias");
    assert.equal(repos[0]?.path, realpathSync(path.join(root, "api")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settings file without mode reads as agent, and a theme save keeps plan", () => {
  const root = workspace();
  try {
    const dir = path.join(root, "data");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ folder: null, model: null, theme: "system" }));
    const store = createSettingsStore({ userDataDir: dir, secrets });
    assert.equal(store.view().mode, "agent");
    store.save({ mode: "plan" });
    assert.equal(store.view().mode, "plan");
    store.save({ theme: "dark" });
    assert.equal(store.view().mode, "plan");
    assert.equal(store.view().theme, "dark");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two repos run, the same repo conflicts, and a question stays in its repo", async () => {
  const root = workspace();
  try {
    gitRepo(path.join(root, "api"));
    gitRepo(path.join(root, "web"));
    const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
    store.save({ folder: root, model: "composer" });
    store.setKey("test-key");
    const gates: { resolve: () => void }[] = [];
    let asked = false;
    const seen: string[] = [];
    const events: FlowEvent[] = [];
    const manager = createSessionManager({
      store,
      files: { seenDirty: () => 0, clearDirty: () => undefined },
      emit: (event) => events.push(event),
      listModels: async () => [],
      createAgents(ask: AskUser): AgentService {
        return {
          prepare() {},
          async listModels() {
            return [];
          },
          async ensure() {
            return { agentId: "agent-1", restored: false };
          },
          async beginSend() {
            if (!asked) {
              asked = true;
              const result = await ask({
                questions: [{ id: "q", prompt: "Pick", options: [{ id: "yes", label: "Yes" }] }],
              });
              seen.push(result);
            }
            await new Promise<void>((resolvePromise) => gates.push({ resolve: () => resolvePromise() }));
          },
          async cancel() {},
          async dispose() {},
        };
      },
    });
    const first = manager.send("api", "hello");
    const pending = await waitFor(() => manager.state("api").pendingQuestion);
    assert.equal(pending.questions[0]?.id, "q");
    assert.equal(manager.state("web").pendingQuestion, undefined);
    await assert.rejects(manager.send("api", "again"), (error: unknown) => error instanceof SessionError && error.code === "conflict");
    const second = manager.send("web", "other");
    await waitFor(() => (gates.length >= 1 ? true : null));
    manager.answer("api", pending.questionId, { q: { selected: ["yes"] } });
    await waitFor(() => (gates.length >= 2 ? true : null));
    gates.forEach((gate) => gate.resolve());
    await first;
    await second;
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? "", /yes/);
    assert.equal(store.readChat(path.join(root, "web")).messages.some((message) => message.role === "question"), false);
    assert.equal(store.readChat(path.join(root, "api")).messages.some((message) => message.role === "question"), true);
    assert.equal(events.some((event) => event.repo === "web" && event.type === "question.asked"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an eighth busy repo is refused", async () => {
  const root = workspace();
  try {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (const name of names) gitRepo(path.join(root, name));
    const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
    store.save({ folder: root, model: "composer" });
    store.setKey("test-key");
    const manager = createSessionManager({
      store,
      files: { seenDirty: () => 0, clearDirty: () => undefined },
      emit: () => undefined,
      listModels: async () => [],
      createAgents(): AgentService {
        return {
          prepare() {},
          async listModels() {
            return [];
          },
          async ensure() {
            return { agentId: "agent-1", restored: false };
          },
          beginSend() {
            return new Promise<void>(() => undefined);
          },
          async cancel() {},
          async dispose() {},
        };
      },
    });
    for (const name of names.slice(0, 7)) void manager.send(name, "hello");
    await waitFor(() => (names.slice(0, 7).every((name) => manager.state(name).state === "streaming") ? true : null));
    await assert.rejects(manager.send("h", "too many"), (error: unknown) => {
      return error instanceof SessionError && error.code === "conflict" && error.message === "Seven agents are already running. Stop one before starting another.";
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool line records where in the text it started", async () => {
  const root = workspace();
  try {
    gitRepo(path.join(root, "api"));
    const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
    store.save({ folder: root, model: "composer" });
    store.setKey("test-key");
    const events: FlowEvent[] = [];
    const manager = createSessionManager({
      store,
      files: { seenDirty: () => 0, clearDirty: () => undefined },
      emit: (event) => events.push(event),
      listModels: async () => [],
      createAgents(): AgentService {
        return {
          prepare() {},
          async listModels() {
            return [];
          },
          async ensure() {
            return { agentId: "agent-1", restored: false };
          },
          async beginSend(input) {
            input.onEvent({ type: "delta", text: "Hello" });
            input.onEvent({ type: "tool", toolCallId: "t1", name: "read", status: "running", summary: "a.ts" });
            // Text arrives while the tool runs. The finished event must keep the first offset.
            input.onEvent({ type: "delta", text: " world" });
            input.onEvent({ type: "tool", toolCallId: "t1", name: "read", status: "ok", summary: "a.ts" });
            input.onEvent({ type: "done", stopReason: "end" });
          },
          async cancel() {},
          async dispose() {},
        };
      },
    });
    await manager.send("api", "hi");
    const offsets = events.flatMap((event) => (event.type === "chat.tool" ? [event.offset] : []));
    assert.deepEqual(offsets, [5, 5]);
    const messages = store.readChat(path.join(root, "api")).messages;
    const stored = messages.find((message) => message.role === "tool");
    assert.equal(stored?.role === "tool" ? stored.offset : undefined, 5);
    const agent = messages.find((message) => message.role === "agent");
    assert.equal(agent?.role === "agent" ? agent.text : undefined, "Hello world");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a question records where in the text it was asked", async () => {
  const root = workspace();
  try {
    gitRepo(path.join(root, "api"));
    const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
    store.save({ folder: root, model: "composer" });
    store.setKey("test-key");
    const events: FlowEvent[] = [];
    const manager = createSessionManager({
      store,
      files: { seenDirty: () => 0, clearDirty: () => undefined },
      emit: (event) => events.push(event),
      listModels: async () => [],
      createAgents(ask: AskUser): AgentService {
        return {
          prepare() {},
          async listModels() {
            return [];
          },
          async ensure() {
            return { agentId: "agent-1", restored: false };
          },
          async beginSend(input) {
            input.onEvent({ type: "delta", text: "Hi" });
            await ask({ questions: [{ id: "q", prompt: "Pick", options: [{ id: "yes", label: "Yes" }] }] });
            input.onEvent({ type: "done", stopReason: "end" });
          },
          async cancel() {},
          async dispose() {},
        };
      },
    });
    const sent = manager.send("api", "hello");
    const pending = await waitFor(() => manager.state("api").pendingQuestion);
    manager.answer("api", pending.questionId, { q: { selected: ["yes"] } });
    await sent;
    const asked = events.flatMap((event) => (event.type === "question.asked" ? [event.offset] : []));
    assert.deepEqual(asked, [2]);
    const question = store.readChat(path.join(root, "api")).messages.find((message) => message.role === "question");
    assert.equal(question?.role === "question" ? question.offset : undefined, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown repo name is refused", async () => {
  const root = workspace();
  try {
    gitRepo(path.join(root, "api"));
    const manager = hangingManager(root);
    await assert.rejects(manager.send("../x", "hello"), (error: unknown) => error instanceof SessionError && error.code === "not_found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saving the model is refused while a repo is busy", async () => {
  const root = workspace();
  try {
    gitRepo(path.join(root, "api"));
    const manager = hangingManager(root);
    void manager.send("api", "hello");
    await waitFor(() => (manager.state("api").state === "streaming" ? true : null));
    await assert.rejects(manager.save({ model: "other" }), (error: unknown) => error instanceof SessionError && error.code === "conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saving the mode is refused while a repo is busy", async () => {
  const root = workspace();
  try {
    gitRepo(path.join(root, "api"));
    const manager = hangingManager(root);
    void manager.send("api", "hello");
    await waitFor(() => (manager.state("api").state === "streaming" ? true : null));
    await assert.rejects(manager.save({ mode: "plan" }), (error: unknown) => error instanceof SessionError && error.code === "conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop on one repo leaves the other running", async () => {
  const root = workspace();
  try {
    gitRepo(path.join(root, "api"));
    gitRepo(path.join(root, "web"));
    const manager = hangingManager(root);
    void manager.send("api", "hello");
    void manager.send("web", "hello");
    await waitFor(() => (manager.state("api").state === "streaming" && manager.state("web").state === "streaming" ? true : null));
    rmSync(path.join(root, "api"), { recursive: true, force: true });
    await manager.stop("api");
    assert.equal(manager.state("web").state, "streaming");
    // The folder is gone, so the name no longer resolves. A second stop throws unless api is still streaming or stopping.
    await assert.rejects(manager.stop("api"), (error: unknown) => {
      return error instanceof SessionError && error.code === "not_ready" && error.message === "Nothing is running";
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function hangingManager(root: string) {
  const store = createSettingsStore({ userDataDir: path.join(root, "data"), secrets });
  store.save({ folder: root, model: "composer" });
  store.setKey("test-key");
  return createSessionManager({
    store,
    files: { seenDirty: () => 0, clearDirty: () => undefined },
    emit: () => undefined,
    listModels: async () => [],
    createAgents(): AgentService {
      return {
        prepare() {},
        async listModels() {
          return [];
        },
        async ensure() {
          return { agentId: "agent-1", restored: false };
        },
        beginSend() {
          return new Promise<void>(() => undefined);
        },
        async cancel() {},
        async dispose() {},
      };
    },
  });
}

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - started > 2_000) throw new Error("timed out waiting for the session");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
