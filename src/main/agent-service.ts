// The only file that imports @cursor/sdk. It turns SDK messages into Mango events.
import {
  Agent,
  AuthenticationError,
  Cursor,
  CursorAgentError,
  type AgentOptions,
  type Run,
  type SDKCustomTool,
  type SDKJsonValue,
  type SDKMessage,
  type SendOptions,
} from "@cursor/sdk";
import { parseToolQuestion, QuestionRejected, type AskUser } from "../shared/questions.js";

const RESUME_TIMEOUT_MS = 10_000;

export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

export class AgentCallError extends Error {
  readonly code: "auth" | "agent_error";
  readonly retryable: boolean;

  constructor(code: "auth" | "agent_error", message: string, retryable: boolean) {
    super(message);
    this.name = "AgentCallError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type AgentStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; toolCallId: string; name: string; status: "running" | "ok" | "error"; summary: string }
  | { type: "done"; stopReason: "end" | "stopped" }
  | { type: "error"; code: "auth" | "agent_error"; message: string; retryable: boolean };

type EnsureInput = {
  apiKey: string;
  modelId: string;
  cwd: string;
  agentId: string | null;
  /** Skip the in-memory agent and Agent.resume so the next create reads the project files again. */
  fresh: boolean;
};

type SendInput = {
  apiKey: string;
  modelId: string;
  prompt: string;
  onEvent: (event: AgentStreamEvent) => void;
};

export type AgentService = {
  prepare(): void;
  listModels(apiKey: string): Promise<{ id: string; label: string }[]>;
  ensure(input: EnsureInput): Promise<{ agentId: string; restored: boolean }>;
  beginSend(input: SendInput): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
};

export function createAgentService(hooks: { ask: AskUser }): AgentService {
  let holder: { agent: { agentId: string; send: SendFn; [Symbol.asyncDispose](): Promise<void> }; cwd: string } | null = null;
  let activeRun: Run | null = null;
  let cancelRequested = false;
  let epoch = 0;

  function prepare(): void {
    cancelRequested = false;
  }

  async function listModels(apiKey: string): Promise<{ id: string; label: string }[]> {
    try {
      const models = await Cursor.models.list({ apiKey });
      const seen = new Set<string>();
      const listed: { id: string; label: string }[] = [];
      for (const model of models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        listed.push({ id: model.id, label: model.displayName.trim() === "" ? model.id : model.displayName });
      }
      listed.sort((a, b) => a.label.localeCompare(b.label));
      return listed;
    } catch (error) {
      throw translate(error, apiKey);
    }
  }

  async function ensure(input: EnsureInput): Promise<{ agentId: string; restored: boolean }> {
    const seen = epoch;
    if (!input.fresh && holder && holder.cwd === input.cwd) {
      return { agentId: holder.agent.agentId, restored: false };
    }
    if (holder) await disposeHolder();
    if (cancelRequested || seen !== epoch) throw new Cancelled();

    const options = agentOptions(input, hooks.ask);
    if (!input.fresh && input.agentId !== null) {
      try {
        const agent = await resumeWithTimeout(input.agentId, options, RESUME_TIMEOUT_MS);
        if (cancelRequested || seen !== epoch) {
          await agent[Symbol.asyncDispose]().catch(() => undefined);
          throw new Cancelled();
        }
        holder = { agent, cwd: input.cwd };
        return { agentId: agent.agentId, restored: false };
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        if (seen !== epoch) throw new Cancelled();
      }
    }

    if (cancelRequested || seen !== epoch) throw new Cancelled();
    let agent: Awaited<ReturnType<typeof Agent.create>>;
    try {
      agent = await Agent.create(options);
    } catch (error) {
      throw translate(error, input.apiKey);
    }
    if (cancelRequested || seen !== epoch) {
      await agent[Symbol.asyncDispose]().catch(() => undefined);
      throw new Cancelled();
    }
    holder = { agent, cwd: input.cwd };
    return { agentId: agent.agentId, restored: !input.fresh && input.agentId !== null };
  }

  async function beginSend(input: SendInput): Promise<void> {
    const seen = epoch;
    const current = holder;
    if (current === null) throw new AgentCallError("agent_error", "The agent is not open", true);
    if (cancelRequested) throw new Cancelled();
    let run: Run;
    try {
      run = await current.agent.send(input.prompt, {
        model: { id: input.modelId },
        local: { customTools: questionTools(hooks.ask) },
      });
    } catch (error) {
      throw translate(error, input.apiKey);
    }
    if (cancelRequested || seen !== epoch || holder !== current) {
      if (run.supports("cancel")) await run.cancel().catch(() => undefined);
      throw new Cancelled();
    }
    activeRun = run;
    void consume(run, input.apiKey, input.onEvent).finally(() => {
      if (activeRun === run) activeRun = null;
    });
  }

  async function cancel(): Promise<void> {
    cancelRequested = true;
    const run = activeRun;
    if (run && run.supports("cancel")) await run.cancel().catch(() => undefined);
  }

  async function dispose(): Promise<void> {
    epoch += 1;
    cancelRequested = true;
    const run = activeRun;
    activeRun = null;
    if (run && run.supports("cancel")) await run.cancel().catch(() => undefined);
    await disposeHolder();
    cancelRequested = false;
  }

  async function disposeHolder(): Promise<void> {
    const current = holder;
    holder = null;
    if (current) await current.agent[Symbol.asyncDispose]().catch(() => undefined);
  }

  return { prepare, listModels, ensure, beginSend, cancel, dispose };
}

type SendFn = (message: string, options?: SendOptions) => Promise<Run>;

const ASK_TOOL_DESCRIPTION =
  "Ask the user to choose and wait for their answer. Use this for any decision that needs the user. " +
  "Pass questions: each has id, prompt, options (id and label), and allow_multiple when several options may be chosen. " +
  "An optional title is shown above the form. " +
  'The result is JSON. A skip is {"skipped":true}. An answer is an object keyed by question id, each value {"selected":[option ids],"other"?:string}.';

const ASK_INPUT_SCHEMA: Record<string, SDKJsonValue> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short heading above the questions." },
    questions: {
      type: "array",
      description: "One or more questions shown together on one form.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          prompt: { type: "string" },
          allow_multiple: { type: "boolean", description: "When true the user may pick more than one option." },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "string" }, label: { type: "string" } },
              required: ["id", "label"],
            },
          },
        },
        required: ["id", "prompt", "options"],
      },
    },
  },
  required: ["questions"],
};

function questionTools(ask: AskUser): Record<string, SDKCustomTool> {
  return { ask_user_question: questionTool(ask) };
}

function questionTool(ask: AskUser): SDKCustomTool {
  return {
    description: ASK_TOOL_DESCRIPTION,
    inputSchema: ASK_INPUT_SCHEMA,
    execute: async (args, context) => {
      const parsed = parseToolQuestion(args);
      if (!parsed.ok) return toolError(parsed.message);
      const toolCallId = context.toolCallId;
      try {
        return await ask({
          questions: parsed.value.questions,
          ...(parsed.value.title ? { title: parsed.value.title } : {}),
          ...(toolCallId ? { toolCallId } : {}),
        });
      } catch (error) {
        if (error instanceof QuestionRejected) return toolError(error.message);
        const message = error instanceof Error && error.message.trim() !== "" ? error.message : "The question failed";
        return toolError(message.slice(0, 400));
      }
    },
  };
}

function toolError(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

function agentOptions(input: EnsureInput, ask: AskUser): AgentOptions {
  const settingSources: Array<"project"> = ["project"];
  return {
    apiKey: input.apiKey,
    model: { id: input.modelId },
    local: { cwd: input.cwd, settingSources, customTools: questionTools(ask) },
  };
}

async function resumeWithTimeout(agentId: string, options: AgentOptions, ms: number) {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await new Promise<Awaited<ReturnType<typeof Agent.resume>>>((resolve, reject) => {
    timer = setTimeout(() => {
      settled = true;
      reject(new Error("resume timed out"));
    }, ms);
    Agent.resume(agentId, options).then(
      (agent) => {
        if (settled) {
          void agent[Symbol.asyncDispose]().catch(() => undefined);
          return;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(agent);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function consume(run: Run, secret: string, onEvent: (event: AgentStreamEvent) => void): Promise<void> {
  let accumulated = "";
  try {
    for await (const message of run.stream()) {
      emitMessage(message, accumulated, (next, event) => {
        accumulated = next;
        if (event) onEvent(event);
      });
    }
    const result = await run.wait();
    if (result.status === "cancelled") {
      onEvent({ type: "done", stopReason: "stopped" });
      return;
    }
    if (result.status === "error") {
      onEvent({
        type: "error",
        code: "agent_error",
        message: scrub(result.error?.message ?? "The run failed", secret),
        retryable: false,
      });
      return;
    }
    onEvent({ type: "done", stopReason: "end" });
  } catch (error) {
    if (error instanceof Cancelled) {
      onEvent({ type: "done", stopReason: "stopped" });
      return;
    }
    const failure = translate(error, secret);
    onEvent({ type: "error", code: failure.code, message: failure.message, retryable: failure.retryable });
  }
}

function emitMessage(
  message: SDKMessage,
  accumulated: string,
  emit: (accumulated: string, event: AgentStreamEvent | null) => void,
): void {
  if (message.type === "assistant") {
    let next = accumulated;
    for (const block of message.message.content) {
      if (block.type !== "text" || block.text === "") continue;
      const piece = block.text.startsWith(next) ? block.text.slice(next.length) : block.text;
      next = block.text.startsWith(next) ? block.text : next + block.text;
      if (piece !== "") emit(next, { type: "delta", text: piece });
    }
    return;
  }
  if (message.type !== "tool_call") return;
  const name = message.name.trim() === "" ? "tool" : message.name;
  const toolCallId = message.call_id.trim() === "" ? `${name}-call` : message.call_id;
  const status = message.status === "completed" ? "ok" : message.status === "error" ? "error" : "running";
  const raw = message.status === "running" ? message.args : (message.result ?? message.args);
  emit(accumulated, {
    type: "tool",
    toolCallId,
    name,
    status,
    summary: questionLine(name, status, raw) ?? summarize(raw),
  });
}

function questionLine(name: string, status: "running" | "ok" | "error", value: unknown): string | null {
  if (!isQuestionTool(name, value)) return null;
  if (status === "running") return "Waiting for an answer";
  if (status === "error") return "The question closed";
  return "Answered";
}

function isQuestionTool(name: string, value: unknown): boolean {
  if (name.toLowerCase().replaceAll("-", "_").includes("ask_user_question")) return true;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of ["toolName", "name", "tool"]) {
    const item = record[key];
    if (typeof item === "string" && item.includes("ask_user_question")) return true;
  }
  return false;
}

function summarize(value: unknown): string {
  return clip(brief(value), 160);
}

function brief(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["command", "cmd", "path", "file_path", "target_file", "query", "pattern", "glob"]) {
      const item = record[key];
      if (typeof item === "string" && item.trim() !== "") return item.replace(/\s+/g, " ").trim();
    }
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function translate(error: unknown, secret: string): AgentCallError {
  if (error instanceof Cancelled || error instanceof AgentCallError) {
    if (error instanceof AgentCallError) return error;
    throw error;
  }
  if (error instanceof AuthenticationError) return new AgentCallError("auth", "Key rejected", false);
  const retryable = error instanceof CursorAgentError ? error.isRetryable : false;
  const message = error instanceof Error ? error.message : "The agent failed";
  return new AgentCallError("agent_error", scrub(message, secret), retryable);
}

function scrub(message: string, secret: string): string {
  const cleaned = secret === "" ? message : message.split(secret).join("[redacted]");
  return cleaned.slice(0, 400);
}
