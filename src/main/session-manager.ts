import { QuestionRejected, QUESTION_CANCELLED, type Answers, type AskUser } from "../shared/questions.js";
import { BUSY_CAP_MESSAGE, MAX_BUSY_REPOS, type AgentMode, type ChatStateName, type FlowEvent, type Message, type PendingQuestion, type RepoListItem, type Settings, type Theme } from "../shared/ipc.js";
import { AgentCallError, type AgentService } from "./agent-service.js";
import { createRepoSession, SessionError, type RepoSession } from "./chat-session.js";
import type { RulesSkills } from "./rules-skills-service.js";
import type { RepoRecord, SettingsStore } from "./settings-store.js";

export type SessionManager = {
  view(): Settings;
  save(partial: { folder?: string; model?: string; mode?: AgentMode; theme?: Theme }): Promise<Settings>;
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  listModels(): Promise<{ id: string; label: string }[]>;
  repos(): RepoListItem[];
  send(repo: string, text: string): Promise<{ runId: string; userMessageId: string; agentMessageId: string; restored: boolean }>;
  stop(repo: string): Promise<void>;
  reset(repo: string): Promise<void>;
  history(repo: string): { messages: Message[] };
  state(repo: string): { state: ChatStateName; runId?: string; instructionsPending: boolean; pendingQuestion?: PendingQuestion };
  answer(repo: string, questionId: string, answers: Answers): void;
  skip(repo: string, questionId: string): void;
  repoPath(repo: string): string;
  shutdown(): Promise<void>;
  isShuttingDown(): boolean;
};

export function createSessionManager(options: {
  store: SettingsStore;
  files: Pick<RulesSkills, "seenDirty" | "clearDirty">;
  emit: (event: FlowEvent) => void;
  listModels(apiKey: string): Promise<{ id: string; label: string }[]>;
  createAgents(ask: AskUser): AgentService;
}): SessionManager {
  const { store, files, emit } = options;
  const sessions = new Map<string, RepoSession>();
  let shuttingDown = false;

  function anyBusy(): boolean {
    return busyCount() > 0;
  }

  function busyCount(): number {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.isBusy()) count += 1;
    }
    return count;
  }

  function resolve(name: string): RepoRecord {
    const current = store.view();
    if (current.folder === null) throw new SessionError("not_ready", "Choose a folder first", false);
    if (current.folderMissing) throw new SessionError("not_ready", "That folder is missing.", false);
    const found = store.listRepos(current.folder).find((repo) => repo.name === name);
    if (found === undefined) throw new SessionError("not_found", "Unknown repo", false);
    return found;
  }

  async function sessionFor(name: string): Promise<RepoSession> {
    const repo = resolve(name);
    const current = sessions.get(repo.name);
    if (current && current.path() === repo.path) return current;
    if (current) {
      sessions.delete(repo.name);
      await current.dispose();
    }
    const bridge: { ask: AskUser | null } = { ask: null };
    const agents = options.createAgents((request) => {
      const ask = bridge.ask;
      if (ask === null) return Promise.reject(new QuestionRejected("cancelled", QUESTION_CANCELLED));
      return ask(request);
    });
    const session = createRepoSession({
      repoName: repo.name,
      repoPath: repo.path,
      store,
      agents,
      files,
      emit,
    });
    bridge.ask = (request) => session.ask(request);
    sessions.set(repo.name, session);
    return session;
  }

  function existing(name: string): RepoSession | null {
    const repo = resolve(name);
    const current = sessions.get(repo.name);
    if (current === undefined || current.path() !== repo.path) return null;
    return current;
  }

  async function disposeAll(): Promise<void> {
    const closing = [...sessions.values()];
    sessions.clear();
    await Promise.all(closing.map((session) => session.dispose()));
  }

  function view(): Settings {
    return store.view();
  }

  async function save(partial: { folder?: string; model?: string; mode?: AgentMode; theme?: Theme }): Promise<Settings> {
    if ((partial.folder !== undefined || partial.model !== undefined || partial.mode !== undefined) && anyBusy()) {
      throw new SessionError("conflict", "Wait for every running agent to finish", false);
    }
    const previous = store.view().folder;
    let next: Settings;
    try {
      next = store.save(partial);
    } catch (error) {
      throw new SessionError("io_error", errorText(error), false);
    }
    if (next.folder !== previous) await disposeAll();
    return next;
  }

  async function setKey(key: string): Promise<void> {
    if (anyBusy()) throw new SessionError("conflict", "Wait for every running agent to finish", false);
    try {
      store.setKey(key);
    } catch (error) {
      throw new SessionError("io_error", errorText(error), false);
    }
    await disposeAll();
  }

  async function clearKey(): Promise<void> {
    if (anyBusy()) throw new SessionError("conflict", "Wait for every running agent to finish", false);
    store.clearKey();
    await disposeAll();
  }

  async function listModels(): Promise<{ id: string; label: string }[]> {
    const key = store.readKey();
    if (key === null) throw new SessionError("auth", "Save a Cursor key first", false);
    try {
      return await options.listModels(key);
    } catch (error) {
      if (error instanceof SessionError) throw error;
      if (error instanceof AgentCallError) throw new SessionError(error.code, error.message, error.retryable);
      throw new SessionError("agent_error", errorText(error), false);
    }
  }

  function repos(): RepoListItem[] {
    const current = store.view();
    if (current.folder === null || current.folderMissing) return [];
    return store.listRepos(current.folder).map((repo) => {
      const session = sessions.get(repo.name);
      const live = session && session.path() === repo.path ? session.state() : null;
      return {
        name: repo.name,
        state: live?.state ?? (current.setupComplete ? "ready" : "needsSetup"),
        pendingQuestion: live?.pendingQuestion !== undefined,
        hasHistory: store.hasChatHistory(repo.path),
      };
    });
  }

  function history(name: string): { messages: Message[] } {
    const session = existing(name);
    if (session) return session.history();
    return { messages: store.readChat(resolve(name).path).messages };
  }

  function state(name: string): { state: ChatStateName; runId?: string; instructionsPending: boolean; pendingQuestion?: PendingQuestion } {
    const session = existing(name);
    if (session) return session.state();
    const repo = resolve(name);
    const current = store.view();
    return {
      state: current.setupComplete ? "ready" : "needsSetup",
      instructionsPending: files.seenDirty(repo.path) !== 0,
    };
  }

  async function send(name: string, text: string) {
    if (shuttingDown) throw new SessionError("not_ready", "The app is closing", false);
    const session = await sessionFor(name);
    if (!session.isBusy() && busyCount() >= MAX_BUSY_REPOS) {
      throw new SessionError("conflict", BUSY_CAP_MESSAGE, false);
    }
    return session.send(text);
  }

  async function stop(name: string): Promise<void> {
    const session = sessions.get(name);
    if (session === undefined) throw new SessionError("not_ready", "Nothing is running", false);
    await session.stop();
  }

  async function reset(name: string): Promise<void> {
    const session = existing(name);
    if (session) {
      await session.reset();
      return;
    }
    const repo = resolve(name);
    try {
      store.writeChat(repo.path, { agentId: null, messages: [] });
    } catch (error) {
      throw new SessionError("io_error", errorText(error), false);
    }
  }

  function answer(name: string, questionId: string, answers: Answers): void {
    const session = sessions.get(name);
    if (session === undefined) throw new SessionError("not_found", "That question is closed", false);
    session.answer(questionId, answers);
  }

  function skip(name: string, questionId: string): void {
    const session = sessions.get(name);
    if (session === undefined) throw new SessionError("not_found", "That question is closed", false);
    session.skip(questionId);
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const closing = [...sessions.values()].map((session) => session.shutdown());
    await Promise.race([Promise.all(closing), new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 3_000))]);
  }

  return {
    view,
    save,
    setKey,
    clearKey,
    listModels,
    repos,
    send,
    stop,
    reset,
    history,
    state,
    answer,
    skip,
    repoPath: (name) => resolve(name).path,
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.slice(0, 400);
  return "Something went wrong";
}
