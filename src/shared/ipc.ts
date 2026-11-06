// Zod contracts for the window and the main process. No I/O.
import { z } from "zod";
import { AnswersSchema, PendingQuestionSchema, QuestionSchema } from "./questions.js";

export const ErrorCodeSchema = z.enum([
  "not_allowed",
  "invalid_input",
  "not_ready",
  "not_found",
  "conflict",
  "auth",
  "agent_error",
  "io_error",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export type Failure = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

export const ThemeSchema = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const AgentModeSchema = z.enum(["agent", "plan"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const PLAN_TEXT_MAX = 200_000;

export const ChatStateSchema = z.enum(["needsSetup", "ready", "streaming", "stopping", "awaitingAnswer"]);
export type ChatStateName = z.infer<typeof ChatStateSchema>;

export const MAX_BUSY_REPOS = 7;

export const BUSY_CAP_MESSAGE = "Seven agents are already running. Stop one before starting another.";

export function busyRepoMessage(repoName: string): string {
  return repoName === "." ? "A message is already running" : `${repoName} already has a running agent. Open it or stop it first.`;
}

/** A direct child directory name, or "." when the workspace folder is the only repo. */
export const RepoNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) => name === "." || (name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0")),
    "Unknown repo",
  );

export const RepoListItemSchema = z.object({
  name: RepoNameSchema,
  state: ChatStateSchema,
  pendingQuestion: z.boolean(),
  hasHistory: z.boolean(),
});
export type RepoListItem = z.infer<typeof RepoListItemSchema>;

export const SettingsSchema = z.object({
  /** Workspace folder. Repos are its child git directories, or this folder when it is the only repo. */
  folder: z.string().nullable(),
  model: z.string().nullable(),
  mode: AgentModeSchema,
  theme: ThemeSchema,
  keySet: z.boolean(),
  /** The stored folder path is set, and that path is not a directory now. */
  folderMissing: z.boolean(),
  setupComplete: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const MessageSchema = z.discriminatedUnion("role", [
  z.object({
    id: z.string().min(1),
    role: z.literal("user"),
    text: z.string(),
    at: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    role: z.literal("agent"),
    text: z.string(),
    at: z.string().min(1),
    status: z.enum(["done", "stopped", "interrupted", "error"]),
  }),
  z.object({
    id: z.string().min(1),
    role: z.literal("tool"),
    name: z.string().min(1),
    summary: z.string(),
    status: z.enum(["ok", "error"]),
    at: z.string().min(1),
    plan: z.string().max(PLAN_TEXT_MAX).optional(),
    truncated: z.boolean().optional(),
    /** Characters of agent text that existed when this call first appeared. Absent in old chats. */
    offset: z.number().int().min(0).optional(),
  }),
  z.object({
    id: z.string().min(1),
    role: z.literal("question"),
    questionId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    questions: z.array(QuestionSchema).min(1).max(8),
    answers: AnswersSchema.nullable(),
    skipped: z.boolean(),
    at: z.string().min(1),
    /** Characters of agent text that existed when the question was asked. Absent in old chats. */
    offset: z.number().int().min(0).optional(),
  }),
]);
export type Message = z.infer<typeof MessageSchema>;

/** One path segment, 1–64 characters. The file service uses the same pattern. */
export const INSTRUCTION_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;

const NameSchema = z
  .string()
  .regex(INSTRUCTION_NAME, "Use a lowercase name: letters, numbers, and hyphens")
  .max(64);

export const RuleSummarySchema = z.object({
  name: NameSchema,
  description: z.string(),
  alwaysApply: z.boolean(),
});
export type RuleSummary = z.infer<typeof RuleSummarySchema>;

export const RuleSchema = z.object({
  name: NameSchema,
  description: z.string().max(4_000),
  alwaysApply: z.boolean(),
  globs: z.string().max(1_000),
  body: z.string().max(200_000),
});
export type Rule = z.infer<typeof RuleSchema>;

export const SkillSummarySchema = z.object({
  name: NameSchema,
  description: z.string(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillSchema = z.object({
  name: NameSchema,
  description: z.string().max(4_000),
  body: z.string().max(200_000),
});
export type Skill = z.infer<typeof SkillSchema>;

const None = z.object({}).strict();

const SendResultSchema = z.object({
  runId: z.string().min(1),
  userMessageId: z.string().min(1),
  agentMessageId: z.string().min(1),
  restored: z.boolean(),
});

export type { Answers, PendingQuestion, Question } from "./questions.js";

export const COMMANDS = {
  "flow:settings.get": { input: None, output: SettingsSchema },
  "flow:settings.save": {
    input: z
      .object({
        folder: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        mode: AgentModeSchema.optional(),
        theme: ThemeSchema.optional(),
      })
      .strict(),
    output: SettingsSchema,
  },
  "flow:key.set": { input: z.object({ key: z.string().trim().min(1).max(500) }).strict(), output: None },
  "flow:key.clear": { input: None, output: None },
  "flow:folder.pick": { input: None, output: z.object({ folder: z.string().nullable() }) },
  "flow:models.list": {
    input: None,
    output: z.object({ models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })) }),
  },
  "flow:repos.list": {
    input: None,
    output: z.object({ repos: z.array(RepoListItemSchema) }),
  },
  "flow:chat.send": {
    input: z.object({ repo: RepoNameSchema, text: z.string().trim().min(1).max(50_000) }).strict(),
    output: SendResultSchema,
  },
  "flow:chat.stop": { input: z.object({ repo: RepoNameSchema }).strict(), output: None },
  "flow:chat.history": {
    input: z.object({ repo: RepoNameSchema }).strict(),
    output: z.object({ messages: z.array(MessageSchema) }),
  },
  "flow:chat.reset": { input: z.object({ repo: RepoNameSchema }).strict(), output: None },
  "flow:chat.state": {
    input: z.object({ repo: RepoNameSchema }).strict(),
    output: z.object({
      state: ChatStateSchema,
      runId: z.string().min(1).optional(),
      instructionsPending: z.boolean(),
      pendingQuestion: PendingQuestionSchema.optional(),
    }),
  },
  "flow:question.answer": {
    input: z
      .object({ repo: RepoNameSchema, questionId: z.string().min(1).max(80), answers: AnswersSchema })
      .strict(),
    output: None,
  },
  "flow:question.skip": {
    input: z.object({ repo: RepoNameSchema, questionId: z.string().min(1).max(80) }).strict(),
    output: None,
  },
  "flow:rules.list": { input: z.object({ repo: RepoNameSchema }).strict(), output: z.array(RuleSummarySchema) },
  "flow:rules.read": { input: z.object({ repo: RepoNameSchema, name: NameSchema }).strict(), output: RuleSchema },
  "flow:rules.write": {
    input: RuleSchema.extend({ repo: RepoNameSchema }).strict(),
    output: RuleSchema,
  },
  "flow:rules.delete": { input: z.object({ repo: RepoNameSchema, name: NameSchema }).strict(), output: None },
  "flow:skills.list": { input: z.object({ repo: RepoNameSchema }).strict(), output: z.array(SkillSummarySchema) },
  "flow:skills.read": { input: z.object({ repo: RepoNameSchema, name: NameSchema }).strict(), output: SkillSchema },
  "flow:skills.write": {
    input: SkillSchema.extend({ repo: RepoNameSchema }).strict(),
    output: SkillSchema,
  },
  "flow:skills.delete": { input: z.object({ repo: RepoNameSchema, name: NameSchema }).strict(), output: None },
  "flow:agentsmd.read": { input: z.object({ repo: RepoNameSchema }).strict(), output: z.object({ body: z.string() }) },
  "flow:agentsmd.write": {
    input: z.object({ repo: RepoNameSchema, body: z.string().max(200_000) }).strict(),
    output: z.object({ body: z.string() }),
  },
} as const;

export type CommandChannel = keyof typeof COMMANDS;
export type InputOf<C extends CommandChannel> = z.infer<(typeof COMMANDS)[C]["input"]>;
export type OutputOf<C extends CommandChannel> = z.infer<(typeof COMMANDS)[C]["output"]>;

export const EVENT_CHANNEL = "flow:event";

const RunId = z.string().min(1);

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat.state"), repo: RepoNameSchema, runId: RunId, state: ChatStateSchema }),
  z.object({
    type: z.literal("chat.delta"),
    repo: RepoNameSchema,
    runId: RunId,
    messageId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("chat.tool"),
    repo: RepoNameSchema,
    runId: RunId,
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["running", "ok", "error"]),
    summary: z.string(),
    plan: z.string().max(PLAN_TEXT_MAX).optional(),
    truncated: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("chat.done"),
    repo: RepoNameSchema,
    runId: RunId,
    messageId: z.string().min(1),
    stopReason: z.enum(["end", "stopped"]),
  }),
  z.object({
    type: z.literal("chat.error"),
    repo: RepoNameSchema,
    runId: RunId,
    code: ErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({
    type: z.literal("question.asked"),
    repo: RepoNameSchema,
    runId: RunId,
    questionId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    questions: z.array(QuestionSchema).min(1).max(8),
    offset: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("question.closed"),
    repo: RepoNameSchema,
    runId: RunId,
    questionId: z.string().min(1),
    reason: z.enum(["answered", "skipped", "cancelled"]),
  }),
]);

export type FlowEvent = z.infer<typeof EventSchema>;

export function isCommandChannel(value: string): value is CommandChannel {
  return Object.prototype.hasOwnProperty.call(COMMANDS, value);
}

export function failure(code: ErrorCode, message: string, retryable: boolean): Result<never> {
  return { ok: false, error: { code, message, retryable } };
}
