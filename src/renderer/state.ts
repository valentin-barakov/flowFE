import type { Answers, ChatStateName, FlowEvent, Message, PendingQuestion, Question, RepoListItem, Settings, Subagent } from "../shared/ipc.js";
import { mergeSubagent } from "../shared/task.js";

export type Item =
  | { id: string; role: "user"; text: string; at: string }
  | { id: string; role: "agent"; text: string; at: string; status: "done" | "stopped" | "interrupted" | "error" }
  | {
      id: string;
      role: "tool";
      name: string;
      summary: string;
      status: "running" | "ok" | "error";
      at: string;
      plan?: string;
      truncated?: boolean;
      subagent?: Subagent;
      offset?: number;
    }
  | {
      id: string;
      role: "question";
      questionId: string;
      title?: string;
      questions: Question[];
      answers: Answers | null;
      skipped: boolean;
      cancelled: boolean;
      open: boolean;
      at: string;
      offset?: number;
    };

export type Banner = {
  title: string;
  body: string;
  retryable: boolean;
  setup: boolean;
};

export type ModelChoice = { id: string; label: string };

export type ChatSlice = {
  loaded: boolean;
  items: Item[];
  chatState: ChatStateName;
  activeRunId: string | null;
  sealedRunId: string | null;
  liveAgentId: string | null;
  draft: string;
  notice: string | null;
  banner: Banner | null;
  lastUserText: string | null;
  instructionsPending: boolean;
  pendingQuestionId: string | null;
  unseen: boolean;
};

export type View = { kind: "home" } | { kind: "repo"; repo: string };

export type AppState = {
  booted: boolean;
  editing: boolean;
  settings: Settings | null;
  banner: Banner | null;
  models: ModelChoice[];
  modelsError: string | null;
  instructionsOpen: boolean;
  /** The Jira ticket list replaces the main pane. `view` and `instructionsOpen` stay as they were. */
  jiraOpen: boolean;
  /** The GitHub Pull requests pane replaces the main pane like jiraOpen. At most one of the three panes is open. */
  githubPrsOpen: boolean;
  /** The GitHub Projects pane replaces the main pane like jiraOpen. At most one of the three panes is open. */
  githubProjectsOpen: boolean;
  view: View;
  repos: RepoListItem[];
  chats: Record<string, ChatSlice>;
  homeDraft: string;
  homeNotice: string | null;
  /** New chat is showing folder buttons for an Implement draft. */
  homePickFolder: boolean;
};

export function emptySlice(): ChatSlice {
  return {
    loaded: false,
    items: [],
    chatState: "needsSetup",
    activeRunId: null,
    sealedRunId: null,
    liveAgentId: null,
    draft: "",
    notice: null,
    banner: null,
    lastUserText: null,
    instructionsPending: false,
    pendingQuestionId: null,
    unseen: false,
  };
}

export function isBusyState(state: ChatStateName): boolean {
  return state === "streaming" || state === "stopping" || state === "awaitingAnswer";
}

export type PaneKey = "jiraOpen" | "githubPrsOpen" | "githubProjectsOpen";

const NO_PANE = { jiraOpen: false, githubPrsOpen: false, githubProjectsOpen: false } as const;

/** True while the Jira list or a GitHub pane covers the chat, New chat, or Rules. */
export function paneOpen(state: AppState): boolean {
  return state.jiraOpen || state.githubPrsOpen || state.githubProjectsOpen;
}

/** Closes one pane. The chat underneath, if any, is no longer unseen. */
function closePane(state: AppState, key: PaneKey): AppState {
  if (!state[key]) return state;
  const underneath = state.view.kind === "repo" ? state.view.repo : null;
  const slice = underneath === null ? undefined : state.chats[underneath];
  const next: AppState = {
    ...state,
    chats: underneath !== null && slice !== undefined ? { ...state.chats, [underneath]: { ...slice, unseen: false } } : state.chats,
  };
  next[key] = false;
  return next;
}

export type SidebarRow = {
  name: string;
  status: "idle" | "running" | "waiting" | "error";
  unseen: boolean;
  active: boolean;
};

export function sidebarRows(state: AppState): SidebarRow[] {
  const rows: SidebarRow[] = [];
  for (const row of state.repos) {
    const slice = state.chats[row.name];
    const current = state.view.kind === "repo" && state.view.repo === row.name;
    // While a pane is open no row looks selected, but the chat underneath keeps its row.
    const active = current && !paneOpen(state);
    if (
      !current &&
      !row.hasHistory &&
      !isBusyState(row.state) &&
      slice?.unseen !== true &&
      slice?.banner == null
    )
      continue;
    let status: SidebarRow["status"] = "idle";
    if (row.state === "awaitingAnswer") status = "waiting";
    else if (row.state === "streaming" || row.state === "stopping") status = "running";
    else if (slice?.banner != null) status = "error";
    rows.push({
      name: row.name,
      status,
      unseen: slice?.unseen === true,
      active,
    });
  }
  return rows;
}

export function shouldLeaveAfterReset(state: AppState, repo: string): boolean {
  return state.repos.length > 1 && state.view.kind === "repo" && state.view.repo === repo;
}

export function canRetry(slice: ChatSlice): boolean {
  return slice.banner?.retryable === true && slice.lastUserText !== null && (slice.chatState === "ready" || slice.chatState === "needsSetup");
}

export function busyRepoNames(state: AppState): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of state.repos) {
    seen.add(row.name);
    if (isBusyState(shownStatus(row.state, state.chats[row.name]))) names.push(row.name);
  }
  for (const [name, slice] of Object.entries(state.chats)) {
    if (seen.has(name)) continue;
    if (isBusyState(slice.chatState)) names.push(name);
  }
  return names;
}

export function anyBusy(state: AppState): boolean {
  return busyRepoNames(state).length > 0;
}

function sliceIsLive(slice: ChatSlice): boolean {
  return slice.loaded || slice.chatState !== "needsSetup";
}

function rowFromSlice(row: RepoListItem, slice: ChatSlice): RepoListItem {
  return {
    ...row,
    state: slice.chatState,
    pendingQuestion: slice.chatState === "awaitingAnswer" || slice.pendingQuestionId !== null,
  };
}

function shownStatus(rowState: ChatStateName, slice: ChatSlice | undefined): ChatStateName {
  if (slice === undefined || !sliceIsLive(slice)) return rowState;
  return rowFromSlice({ name: ".", state: rowState, pendingQuestion: false, hasHistory: false }, slice).state;
}

export type Action =
  | {
      type: "boot";
      settings: Settings;
      repos: RepoListItem[];
      view: View;
      repo?: string;
      messages?: Message[];
      chatState?: ChatStateName;
      runId?: string;
      instructionsPending?: boolean;
      pendingQuestion?: PendingQuestion;
    }
  | { type: "boot-failed"; settings: Settings }
  | { type: "settings"; settings: Settings; repos: RepoListItem[] }
  | { type: "models"; models: ModelChoice[] }
  | { type: "models-error"; message: string; code?: string }
  | { type: "edit-setup" }
  | { type: "close-setup" }
  | { type: "open-instructions" }
  | { type: "close-instructions" }
  | { type: "open-jira" }
  | { type: "close-jira" }
  | { type: "open-github-prs" }
  | { type: "close-github-prs" }
  | { type: "open-github-projects" }
  | { type: "close-github-projects" }
  | { type: "open-home" }
  | { type: "open-repo"; repo: string }
  | {
      type: "repo-loaded";
      repo: string;
      messages: Message[];
      chatState: ChatStateName;
      runId?: string;
      instructionsPending: boolean;
      pendingQuestion?: PendingQuestion;
    }
  | { type: "home-draft"; draft: string }
  | { type: "home-notice"; notice: string | null }
  /** Leave Jira for New chat, with the ticket prompt already in the box. */
  | { type: "implement-ticket"; text: string }
  | { type: "draft"; repo: string; draft: string }
  | { type: "sending"; repo: string; text: string }
  | { type: "banner"; repo: string; banner: Banner | null }
  | { type: "reset-chat"; repo: string }
  | {
      type: "run-started";
      repo: string;
      runId: string;
      userMessageId: string;
      agentMessageId: string;
      text: string;
      restored: boolean;
    }
  | { type: "send-failed"; repo: string; messages: Message[]; chatState: ChatStateName; banner: Banner }
  | { type: "history"; repo: string; messages: Message[] }
  | { type: "instructions-pending"; repo: string; pending: boolean }
  | { type: "dismiss-banner"; repo: string }
  | { type: "question-settled"; repo: string; questionId: string; answers: Answers | null; skipped: boolean }
  | { type: "repos"; repos: RepoListItem[] }
  | { type: "event"; event: FlowEvent };

export const initialState: AppState = {
  booted: false,
  editing: false,
  settings: null,
  banner: null,
  models: [],
  modelsError: null,
  instructionsOpen: false,
  jiraOpen: false,
  githubPrsOpen: false,
  githubProjectsOpen: false,
  view: { kind: "home" },
  repos: [],
  chats: {},
  homeDraft: "",
  homeNotice: null,
  homePickFolder: false,
};

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "boot": {
      const chats: Record<string, ChatSlice> = {};
      if (action.repo !== undefined) {
        chats[action.repo] = loadedSlice(
          emptySlice(),
          action.messages ?? [],
          action.chatState ?? "needsSetup",
          action.runId,
          action.instructionsPending ?? false,
          action.pendingQuestion,
          action.settings.folderMissing,
        );
      }
      return {
        ...state,
        booted: true,
        settings: action.settings,
        repos: action.repos,
        view: action.view,
        chats,
        banner: action.settings.folderMissing ? folderBanner() : null,
      };
    }
    case "boot-failed":
      return {
        ...state,
        booted: true,
        settings: action.settings,
        repos: [],
        view: { kind: "home" },
      };
    case "settings": {
      const folderChanged = state.settings?.folder !== action.settings.folder;
      const becameMissing = action.settings.folderMissing && state.settings?.folderMissing !== true;
      return {
        ...state,
        settings: action.settings,
        repos: action.repos,
        editing: action.settings.setupComplete ? state.editing : false,
        instructionsOpen: folderChanged ? false : state.instructionsOpen,
        chats: folderChanged ? {} : state.chats,
        view: folderChanged ? viewForRepos(action.repos) : state.view,
        banner: folderChanged || becameMissing ? (action.settings.folderMissing ? folderBanner() : null) : state.banner,
        homePickFolder: folderChanged ? false : state.homePickFolder,
      };
    }
    case "models":
      return { ...state, models: action.models, modelsError: null };
    case "models-error":
      return {
        ...state,
        modelsError: action.message,
        banner: action.code === "auth" ? bannerFor("auth", action.message, false) : state.banner,
      };
    case "edit-setup":
      return { ...state, editing: true, instructionsOpen: false };
    case "close-setup":
      return { ...state, editing: false };
    case "open-instructions":
      if (state.view.kind !== "repo") return state;
      return { ...state, instructionsOpen: true };
    case "close-instructions":
      return { ...state, instructionsOpen: false };
    case "open-jira":
      return { ...state, ...NO_PANE, jiraOpen: true };
    case "close-jira":
      return closePane(state, "jiraOpen");
    case "open-github-prs":
      return { ...state, ...NO_PANE, githubPrsOpen: true };
    case "close-github-prs":
      return closePane(state, "githubPrsOpen");
    case "open-github-projects":
      return { ...state, ...NO_PANE, githubProjectsOpen: true };
    case "close-github-projects":
      return closePane(state, "githubProjectsOpen");
    case "open-home":
      return {
        ...state,
        view: { kind: "home" },
        instructionsOpen: false,
        ...NO_PANE,
        homePickFolder: false,
      };
    case "implement-ticket":
      return {
        ...state,
        view: { kind: "home" },
        instructionsOpen: false,
        ...NO_PANE,
        homeDraft: action.text,
        homeNotice: null,
        homePickFolder: true,
      };
    case "open-repo": {
      const current = state.chats[action.repo] ?? emptySlice();
      return {
        ...state,
        view: { kind: "repo", repo: action.repo },
        instructionsOpen: false,
        ...NO_PANE,
        chats: { ...state.chats, [action.repo]: { ...current, unseen: false } },
      };
    }
    case "repo-loaded":
      return {
        ...state,
        chats: {
          ...state.chats,
          [action.repo]: loadedSlice(
            state.chats[action.repo] ?? emptySlice(),
            action.messages,
            action.chatState,
            action.runId,
            action.instructionsPending,
            action.pendingQuestion,
            state.settings?.folderMissing === true,
          ),
        },
        repos: state.repos.map((row) =>
          row.name === action.repo
            ? {
                ...row,
                state: action.chatState,
                pendingQuestion: action.pendingQuestion !== undefined,
                hasHistory: action.messages.length > 0,
              }
            : row,
        ),
      };
    case "repos":
      return { ...state, repos: mergeListedRepos(state, action.repos) };
    case "home-draft":
      return { ...state, homeDraft: action.draft };
    case "home-notice":
      return { ...state, homeNotice: action.notice };
    case "draft":
      return withSlice(state, action.repo, (slice) => ({ ...slice, draft: action.draft }));
    case "sending": {
      const current = state.chats[action.repo] ?? emptySlice();
      const slice: ChatSlice = {
        ...current,
        chatState: "streaming",
        draft: "",
        lastUserText: action.text,
        banner: null,
        notice: null,
      };
      return { ...placeSlice(state, action.repo, slice), homeDraft: "", homeNotice: null };
    }
    case "banner":
      return withSlice(state, action.repo, (slice) => ({ ...slice, banner: action.banner }));
    case "reset-chat": {
      const current = state.chats[action.repo] ?? emptySlice();
      const slice: ChatSlice = {
        ...current,
        items: [],
        draft: "",
        notice: null,
        banner: state.settings?.folderMissing ? folderBanner() : null,
        chatState: state.settings?.setupComplete ? "ready" : "needsSetup",
        activeRunId: null,
        sealedRunId: null,
        liveAgentId: null,
        lastUserText: null,
        pendingQuestionId: null,
        unseen: false,
      };
      return placeSlice(state, action.repo, slice, { hasHistory: false });
    }
    case "run-started": {
      const at = new Date().toISOString();
      const next = withSlice(state, action.repo, (slice) => ({
        ...slice,
        chatState: "streaming",
        activeRunId: action.runId,
        sealedRunId: null,
        liveAgentId: action.agentMessageId,
        notice: action.restored ? "Context restored from history" : null,
        instructionsPending: false,
        pendingQuestionId: null,
        banner: null,
        draft: "",
        lastUserText: action.text,
        items: [
          ...slice.items,
          { id: action.userMessageId, role: "user", text: action.text, at },
          { id: action.agentMessageId, role: "agent", text: "", at, status: "interrupted" },
        ],
      }));
      return {
        ...next,
        repos: next.repos.map((row) => (row.name === action.repo ? { ...row, state: "streaming", hasHistory: true } : row)),
      };
    }
    case "send-failed": {
      const current = state.chats[action.repo] ?? emptySlice();
      const items = toItems(action.messages, current.pendingQuestionId);
      const slice: ChatSlice = {
        ...current,
        items,
        chatState: action.chatState,
        banner: action.banner,
        activeRunId: null,
        liveAgentId: null,
        lastUserText: lastUserText(items) ?? current.lastUserText,
      };
      return placeSlice(state, action.repo, slice);
    }
    case "history": {
      const slice = state.chats[action.repo] ?? emptySlice();
      if (slice.activeRunId !== null && slice.sealedRunId !== slice.activeRunId) return state;
      const items = toItems(action.messages, slice.pendingQuestionId);
      return withSlice(state, action.repo, () => ({
        ...slice,
        items,
        lastUserText: lastUserText(items) ?? slice.lastUserText,
      }));
    }
    case "instructions-pending":
      return withSlice(state, action.repo, (slice) => ({ ...slice, instructionsPending: action.pending }));
    case "dismiss-banner":
      return withSlice(state, action.repo, (slice) => ({ ...slice, banner: null }));
    case "question-settled": {
      const current = state.chats[action.repo] ?? emptySlice();
      const slice: ChatSlice = {
        ...current,
        pendingQuestionId: current.pendingQuestionId === action.questionId ? null : current.pendingQuestionId,
        chatState: current.chatState === "awaitingAnswer" && current.pendingQuestionId === action.questionId ? "streaming" : current.chatState,
        items: current.items.map((item) => {
          if (item.role !== "question" || item.questionId !== action.questionId || item.cancelled) return item;
          return { ...item, open: false, cancelled: false, skipped: action.skipped, answers: action.answers };
        }),
      };
      return placeSlice(state, action.repo, slice);
    }
    case "event":
      return routeEvent(state, action.event);
    default:
      return state;
  }
}

export type Screen = "loading" | "setup" | "jira" | "githubPrs" | "githubProjects" | "instructions" | "home" | "chat";

export function screenOf(state: AppState): Screen {
  if (!state.booted || state.settings === null) return "loading";
  if (!state.settings.setupComplete || state.editing) return "setup";
  if (state.jiraOpen) return "jira";
  if (state.githubPrsOpen) return "githubPrs";
  if (state.githubProjectsOpen) return "githubProjects";
  if (state.instructionsOpen && state.view.kind === "repo") return "instructions";
  if (state.view.kind === "home") return "home";
  return "chat";
}

export function toItems(messages: readonly Message[], openQuestionId: string | null): Item[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { id: message.id, role: "user", text: message.text, at: message.at };
      case "agent":
        return { id: message.id, role: "agent", text: message.text, at: message.at, status: message.status };
      case "tool":
        return {
          id: message.id,
          role: "tool",
          name: message.name,
          summary: message.summary,
          status: message.status,
          at: message.at,
          ...(message.plan !== undefined ? { plan: message.plan } : {}),
          ...(message.truncated === true ? { truncated: true } : {}),
          ...(message.subagent !== undefined ? { subagent: message.subagent } : {}),
          ...(message.offset !== undefined ? { offset: message.offset } : {}),
        };
      case "question":
        return questionItem(message, openQuestionId);
      default:
        return assertNever(message);
    }
  });
}

function applyEvent(state: ChatSlice, event: FlowEvent): ChatSlice {
  if (event.type === "chat.state") {
    const busy = isBusyState(event.state);
    return {
      ...state,
      chatState: event.state,
      activeRunId: busy && event.runId !== "session" ? event.runId : state.activeRunId,
    };
  }
  if (event.type === "question.asked") {
    if (state.sealedRunId === event.runId) return state;
    if (state.activeRunId !== null && state.activeRunId !== event.runId) return state;
    const item = askedItem(event);
    return {
      ...state,
      chatState: state.chatState === "stopping" ? state.chatState : "awaitingAnswer",
      activeRunId: state.activeRunId ?? event.runId,
      pendingQuestionId: event.questionId,
      items: upsertQuestion(state.items, state.liveAgentId, item),
    };
  }
  if (event.type === "question.closed") {
    if (state.sealedRunId === event.runId) return state;
    if (state.activeRunId !== null && state.activeRunId !== event.runId) return state;
    return {
      ...state,
      pendingQuestionId: state.pendingQuestionId === event.questionId ? null : state.pendingQuestionId,
      items: state.items.map((item) => (item.role === "question" && item.questionId === event.questionId ? closeItem(item, event.reason) : item)),
    };
  }
  if (state.sealedRunId === event.runId) return state;
  if (state.activeRunId !== null && state.activeRunId !== event.runId) return state;
  if (event.type === "chat.delta") {
    const items = appendDelta(state.items, event.messageId, event.text);
    return { ...state, activeRunId: state.activeRunId ?? event.runId, liveAgentId: event.messageId, items };
  }
  if (event.type === "chat.tool") {
    const tool = {
      id: event.toolCallId,
      role: "tool" as const,
      name: event.name,
      summary: event.summary,
      status: event.status,
      at: new Date().toISOString(),
      ...(event.plan !== undefined ? { plan: event.plan } : {}),
      ...(event.truncated === true ? { truncated: true } : {}),
      ...(event.subagent !== undefined ? { subagent: event.subagent } : {}),
      ...(event.offset !== undefined ? { offset: event.offset } : {}),
    };
    return {
      ...state,
      activeRunId: state.activeRunId ?? event.runId,
      items: upsertTool(state.items, state.liveAgentId, tool),
    };
  }
  if (event.type === "chat.done") {
    return {
      ...state,
      sealedRunId: event.runId,
      pendingQuestionId: null,
      items: state.items.map((item) => {
        if (item.role === "question" && item.open) return { ...item, open: false, cancelled: true };
        if (item.id === event.messageId && item.role === "agent") {
          return { ...item, status: event.stopReason === "stopped" ? "stopped" : "done" };
        }
        return item;
      }),
    };
  }
  const agentId = state.liveAgentId;
  return {
    ...state,
    sealedRunId: event.runId,
    pendingQuestionId: null,
    banner: bannerFor(event.code, event.message, event.retryable),
    items: state.items.map((item) => {
      if (item.role === "question" && item.open) return { ...item, open: false, cancelled: true };
      if (item.id === agentId && item.role === "agent") return { ...item, status: "error" };
      return item;
    }),
  };
}

function routeEvent(state: AppState, event: FlowEvent): AppState {
  const known = state.repos.some((row) => row.name === event.repo) || state.chats[event.repo] !== undefined;
  if (!known) return state;
  const current = state.chats[event.repo] ?? emptySlice();
  const applied = applyEvent(current, event);
  if (applied === current) return state;
  let slice = applied;
  const onScreen =
    state.view.kind === "repo" &&
    state.view.repo === event.repo &&
    !paneOpen(state);
  if (!onScreen && (event.type === "chat.done" || event.type === "chat.error" || event.type === "question.asked")) {
    slice = { ...slice, unseen: true };
  }
  const markHistory =
    event.type === "chat.delta" ||
    event.type === "chat.tool" ||
    event.type === "chat.done" ||
    event.type === "chat.error" ||
    event.type === "question.asked";
  const finished = event.type === "chat.done" || event.type === "chat.error";
  const stateChanged = slice.chatState !== current.chatState;
  const questionChanged = stateChanged || slice.pendingQuestionId !== current.pendingQuestionId;
  return {
    ...state,
    chats: { ...state.chats, [event.repo]: slice },
    repos: state.repos.map((row) => {
      if (row.name !== event.repo) return row;
      const fromSlice = rowFromSlice(row, slice);
      return {
        ...fromSlice,
        state: stateChanged ? fromSlice.state : finished ? "ready" : row.state,
        pendingQuestion: finished ? false : questionChanged ? fromSlice.pendingQuestion : row.pendingQuestion,
        hasHistory: markHistory ? true : row.hasHistory,
      };
    }),
  };
}

function appendDelta(items: readonly Item[], messageId: string, text: string): Item[] {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== messageId || item.role !== "agent") return item;
    found = true;
    return { ...item, text: item.text + text };
  });
  if (found) return next;
  return [...next, { id: messageId, role: "agent", text, at: new Date().toISOString(), status: "interrupted" }];
}

function upsertTool(items: readonly Item[], agentId: string | null, tool: Extract<Item, { role: "tool" }>): Item[] {
  const index = items.findIndex((item) => item.id === tool.id);
  if (index >= 0) {
    const next = items.slice();
    const current = next[index];
    if (current?.role === "tool") {
      next[index] = {
        ...current,
        name: tool.name,
        summary: tool.summary !== "" ? tool.summary : current.summary,
        status: current.status !== "running" && tool.status === "running" ? current.status : tool.status,
        ...(tool.plan !== undefined ? { plan: tool.plan } : {}),
        ...(tool.truncated === true ? { truncated: true } : {}),
        ...mergedSubagent(current.subagent, tool.subagent),
        ...(current.offset === undefined && tool.offset !== undefined ? { offset: tool.offset } : {}),
      };
    }
    return next;
  }
  const agentIndex = agentId === null ? -1 : items.findIndex((item) => item.id === agentId);
  if (agentIndex === -1) return [...items, tool];
  return [...items.slice(0, agentIndex), tool, ...items.slice(agentIndex)];
}

function mergedSubagent(current: Subagent | undefined, next: Subagent | undefined): { subagent?: Subagent } {
  const subagent = mergeSubagent(current, next);
  return subagent !== undefined ? { subagent } : {};
}

export function bannerFor(code: string, message: string, retryable: boolean): Banner {
  if (code === "auth") return { title: "Key rejected", body: "The Cursor key was rejected. Replace it in setup.", retryable: false, setup: true };
  if (/folder is missing/i.test(message)) return folderBanner();
  if (code === "agent_error") return { title: "Agent error", body: message, retryable: true, setup: false };
  return { title: "The agent stopped", body: message, retryable, setup: false };
}

function folderBanner(): Banner {
  return { title: "Folder missing", body: "The chosen folder is gone. Pick it again.", retryable: false, setup: true };
}

function questionItem(message: Extract<Message, { role: "question" }>, openQuestionId: string | null): Extract<Item, { role: "question" }> {
  const open = openQuestionId === message.questionId && message.answers === null && !message.skipped;
  return {
    id: message.id,
    role: "question",
    questionId: message.questionId,
    ...(message.title !== undefined ? { title: message.title } : {}),
    ...(message.offset !== undefined ? { offset: message.offset } : {}),
    questions: message.questions,
    answers: message.answers,
    skipped: message.skipped,
    cancelled: !open && message.answers === null && !message.skipped,
    open,
    at: message.at,
  };
}

function askedItem(event: Extract<FlowEvent, { type: "question.asked" }>): Extract<Item, { role: "question" }> {
  return {
    id: event.questionId,
    role: "question",
    questionId: event.questionId,
    ...(event.title !== undefined ? { title: event.title } : {}),
    ...(event.offset !== undefined ? { offset: event.offset } : {}),
    questions: event.questions,
    answers: null,
    skipped: false,
    cancelled: false,
    open: true,
    at: new Date().toISOString(),
  };
}

function closeItem(item: Extract<Item, { role: "question" }>, reason: "answered" | "skipped" | "cancelled"): Extract<Item, { role: "question" }> {
  if (reason === "cancelled") return { ...item, open: false, cancelled: true };
  if (reason === "skipped") return { ...item, open: false, cancelled: false, skipped: true, answers: null };
  return { ...item, open: false, cancelled: false };
}

function withPending(items: Item[], pending: PendingQuestion | undefined, agentId: string | null): Item[] {
  if (pending === undefined) return items;
  if (items.some((item) => item.role === "question" && item.questionId === pending.questionId)) return items;
  return upsertQuestion(items, agentId, {
    id: pending.questionId,
    role: "question",
    questionId: pending.questionId,
    ...(pending.title !== undefined ? { title: pending.title } : {}),
    questions: pending.questions,
    answers: null,
    skipped: false,
    cancelled: false,
    open: true,
    at: new Date().toISOString(),
  });
}

function upsertQuestion(items: readonly Item[], agentId: string | null, question: Extract<Item, { role: "question" }>): Item[] {
  const index = items.findIndex((item) => item.role === "question" && item.questionId === question.questionId);
  if (index >= 0) {
    const next = items.slice();
    const current = next[index];
    next[index] = current?.role === "question" ? { ...question, at: current.at } : question;
    return next;
  }
  const agentIndex = agentId === null ? -1 : items.findIndex((item) => item.id === agentId);
  if (agentIndex === -1) return [...items, question];
  return [...items.slice(0, agentIndex), question, ...items.slice(agentIndex)];
}

function assertNever(value: never): never {
  throw new Error(`Unknown message ${JSON.stringify(value)}`);
}

function lastAgentId(items: readonly Item[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role === "agent") return item.id;
  }
  return null;
}

function lastUserText(items: readonly Item[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role === "user") return item.text;
  }
  return null;
}

function withSlice(state: AppState, repo: string, update: (slice: ChatSlice) => ChatSlice): AppState {
  const current = state.chats[repo] ?? emptySlice();
  return { ...state, chats: { ...state.chats, [repo]: update(current) } };
}

function placeSlice(state: AppState, repo: string, slice: ChatSlice, patch?: Partial<Pick<RepoListItem, "hasHistory">>): AppState {
  return {
    ...state,
    chats: { ...state.chats, [repo]: slice },
    repos: state.repos.map((row) => (row.name === repo ? { ...rowFromSlice(row, slice), ...patch } : row)),
  };
}

function mergeListedRepos(state: AppState, listed: readonly RepoListItem[]): RepoListItem[] {
  return listed.map((repo) => {
    const slice = state.chats[repo.name];
    if (slice === undefined || !sliceIsLive(slice)) return repo;
    return {
      ...rowFromSlice(repo, slice),
      hasHistory: repo.hasHistory || slice.items.length > 0,
    };
  });
}

function loadedSlice(
  base: ChatSlice,
  messages: readonly Message[],
  chatState: ChatStateName,
  runId: string | undefined,
  instructionsPending: boolean,
  pendingQuestion: PendingQuestion | undefined,
  folderMissing: boolean,
): ChatSlice {
  const pendingQuestionId = pendingQuestion?.questionId ?? null;
  const live = isBusyState(chatState);
  const stored = toItems(messages, pendingQuestionId);
  const items = withPending(stored, pendingQuestion, lastAgentId(stored));
  return {
    ...base,
    loaded: true,
    items,
    chatState,
    activeRunId: live && runId ? runId : null,
    liveAgentId: live ? lastAgentId(items) : null,
    lastUserText: lastUserText(items),
    instructionsPending,
    pendingQuestionId,
    banner: folderMissing ? folderBanner() : null,
  };
}

function viewForRepos(repos: readonly RepoListItem[]): View {
  const only = repos.length === 1 ? repos[0] : undefined;
  if (only === undefined) return { kind: "home" };
  return { kind: "repo", repo: only.name };
}
