import type { Answers, ChatStateName, FlowEvent, Message, PendingQuestion, Question, Settings } from "../shared/ipc.js";

export type Item =
  | { id: string; role: "user"; text: string; at: string }
  | { id: string; role: "agent"; text: string; at: string; status: "done" | "stopped" | "interrupted" | "error" }
  | { id: string; role: "tool"; name: string; summary: string; status: "running" | "ok" | "error"; at: string }
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
    };

export type Banner = {
  title: string;
  body: string;
  retryable: boolean;
  setup: boolean;
};

export type ModelChoice = { id: string; label: string };

export type AppState = {
  booted: boolean;
  editing: boolean;
  settings: Settings | null;
  items: Item[];
  chatState: ChatStateName;
  activeRunId: string | null;
  sealedRunId: string | null;
  liveAgentId: string | null;
  draft: string;
  notice: string | null;
  banner: Banner | null;
  models: ModelChoice[];
  modelsError: string | null;
  lastUserText: string | null;
  instructionsOpen: boolean;
  instructionsPending: boolean;
  pendingQuestionId: string | null;
};

export type Action =
  | {
      type: "loaded";
      settings: Settings;
      messages: Message[];
      chatState: ChatStateName;
      runId?: string;
      instructionsPending: boolean;
      pendingQuestion?: PendingQuestion;
    }
  | { type: "settings"; settings: Settings }
  | { type: "models"; models: ModelChoice[] }
  | { type: "models-error"; message: string; code?: string }
  | { type: "reset-chat" }
  | { type: "draft"; draft: string }
  | { type: "sending"; text: string }
  | { type: "banner"; banner: Banner | null }
  | { type: "edit-setup" }
  | { type: "close-setup" }
  | { type: "open-instructions" }
  | { type: "close-instructions" }
  | { type: "instructions-pending"; pending: boolean }
  | { type: "dismiss-banner" }
  | {
      type: "run-started";
      runId: string;
      userMessageId: string;
      agentMessageId: string;
      text: string;
      restored: boolean;
    }
  | { type: "send-failed"; messages: Message[]; chatState: ChatStateName; banner: Banner }
  | { type: "history"; messages: Message[] }
  | { type: "question-settled"; questionId: string; answers: Answers | null; skipped: boolean }
  | { type: "event"; event: FlowEvent };

export const initialState: AppState = {
  booted: false,
  editing: false,
  settings: null,
  items: [],
  chatState: "needsSetup",
  activeRunId: null,
  sealedRunId: null,
  liveAgentId: null,
  draft: "",
  notice: null,
  banner: null,
  models: [],
  modelsError: null,
  lastUserText: null,
  instructionsOpen: false,
  instructionsPending: false,
  pendingQuestionId: null,
};

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "loaded": {
      const pendingQuestionId = action.pendingQuestion?.questionId ?? null;
      const live = action.chatState === "streaming" || action.chatState === "stopping" || action.chatState === "awaitingAnswer";
      const stored = toItems(action.messages, pendingQuestionId);
      const items = withPending(stored, action.pendingQuestion, lastAgentId(stored));
      return {
        ...state,
        booted: true,
        settings: action.settings,
        items,
        chatState: action.chatState,
        activeRunId: live && action.runId ? action.runId : null,
        liveAgentId: live ? lastAgentId(items) : null,
        lastUserText: lastUserText(items),
        instructionsPending: action.instructionsPending,
        pendingQuestionId,
        banner: action.settings.folderMissing ? folderBanner() : null,
      };
    }
    case "settings": {
      const folderChanged = state.settings?.folder !== action.settings.folder;
      const becameMissing = action.settings.folderMissing && state.settings?.folderMissing !== true;
      return {
        ...state,
        settings: action.settings,
        editing: action.settings.setupComplete ? state.editing : false,
        instructionsOpen: folderChanged ? false : state.instructionsOpen,
        instructionsPending: folderChanged ? false : state.instructionsPending,
        items: folderChanged ? [] : state.items,
        notice: folderChanged ? null : state.notice,
        banner: folderChanged || becameMissing ? (action.settings.folderMissing ? folderBanner() : null) : state.banner,
        activeRunId: folderChanged ? null : state.activeRunId,
        liveAgentId: folderChanged ? null : state.liveAgentId,
        sealedRunId: folderChanged ? null : state.sealedRunId,
        pendingQuestionId: folderChanged ? null : state.pendingQuestionId,
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
    case "reset-chat":
      return {
        ...state,
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
      };
    case "draft":
      return { ...state, draft: action.draft };
    case "sending":
      return { ...state, chatState: "streaming", draft: "", lastUserText: action.text, banner: null, notice: null };
    case "banner":
      return { ...state, banner: action.banner };
    case "edit-setup":
      return { ...state, editing: true, instructionsOpen: false };
    case "close-setup":
      return { ...state, editing: false };
    case "open-instructions":
      return { ...state, instructionsOpen: true };
    case "close-instructions":
      return { ...state, instructionsOpen: false };
    case "instructions-pending":
      return { ...state, instructionsPending: action.pending };
    case "dismiss-banner":
      return { ...state, banner: null };
    case "run-started": {
      const at = new Date().toISOString();
      return {
        ...state,
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
          ...state.items,
          { id: action.userMessageId, role: "user", text: action.text, at },
          { id: action.agentMessageId, role: "agent", text: "", at, status: "interrupted" },
        ],
      };
    }
    case "send-failed": {
      const items = toItems(action.messages, state.pendingQuestionId);
      return {
        ...state,
        items,
        chatState: action.chatState,
        banner: action.banner,
        activeRunId: null,
        liveAgentId: null,
        lastUserText: lastUserText(items) ?? state.lastUserText,
      };
    }
    case "question-settled":
      return {
        ...state,
        pendingQuestionId: state.pendingQuestionId === action.questionId ? null : state.pendingQuestionId,
        chatState: state.chatState === "awaitingAnswer" && state.pendingQuestionId === action.questionId ? "streaming" : state.chatState,
        items: state.items.map((item) => {
          if (item.role !== "question" || item.questionId !== action.questionId || item.cancelled) return item;
          return { ...item, open: false, cancelled: false, skipped: action.skipped, answers: action.answers };
        }),
      };
    case "history": {
      if (state.activeRunId !== null && state.sealedRunId !== state.activeRunId) return state;
      const items = toItems(action.messages, state.pendingQuestionId);
      return { ...state, items, lastUserText: lastUserText(items) ?? state.lastUserText };
    }
    case "event":
      return applyEvent(state, action.event);
    default:
      return state;
  }
}

export function screenOf(state: AppState): "loading" | "setup" | "chat" | "instructions" {
  if (!state.booted || state.settings === null) return "loading";
  if (!state.settings.setupComplete || state.editing) return "setup";
  if (state.instructionsOpen) return "instructions";
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
        return { id: message.id, role: "tool", name: message.name, summary: message.summary, status: message.status, at: message.at };
      case "question":
        return questionItem(message, openQuestionId);
      default:
        return assertNever(message);
    }
  });
}

function applyEvent(state: AppState, event: FlowEvent): AppState {
  if (event.type === "chat.state") {
    const busy = event.state === "streaming" || event.state === "stopping" || event.state === "awaitingAnswer";
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
    if (current?.role === "tool") next[index] = { ...current, name: tool.name, summary: tool.summary, status: tool.status };
    return next;
  }
  const agentIndex = agentId === null ? -1 : items.findIndex((item) => item.id === agentId);
  if (agentIndex === -1) return [...items, tool];
  return [...items.slice(0, agentIndex), tool, ...items.slice(agentIndex)];
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
