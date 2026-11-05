// Phase 0 gap spike. Mango already measured the overlapping checks, so this script does not repeat them:
//   S1  streaming, cancel, usage (2026-11-02)
//   S3  settingSources: ["project"] loads project hooks (2026-11-02)
//   S8  Agent.resume after a kill mid-run fails with "already has active run" (2026-11-04)
//   S22 the SDK runs in Electron's main process (2026-11-03)
//
// This script checks only what those did not:
//   rules-skill   a project rule is followed and a project skill is visible
//   custom-tool   ask_user_question waits 5s and its return value reaches the agent
//   ask-question  native askQuestion appears in the stream, and whether the run blocks
//   resume        a second process resumes a finished agent and keeps the secret word
//   resume-reread the rule file is changed before that resume, and the new ending is used
//
// Needs CURSOR_API_KEY. Put it in .env (gitignored) or export it. The key is passed as the apiKey option and is never printed.
//   npm run spike
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, CursorAgentError, FileCredentialStore, type Run, type RunResult, type SDKMessage } from "@cursor/sdk";
import { z } from "zod";

const SECRET = "marigold";
const TOKEN = "pebble-4821";
const RULE_END = "ANCHOR";
const NEW_END = "BEACON";
const MODEL = { id: "composer-2.5" } as const;

const QuestionInput = z.object({
  questions: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        options: z.array(z.object({ id: z.string(), label: z.string() })),
        allow_multiple: z.boolean().optional(),
      }),
    )
    .optional(),
});

type ToolHit = { name: string; status: string };

type Observed = {
  text: string;
  tools: ToolHit[];
  timedOut: boolean;
  status: string;
  error?: string;
};

type CreateReport = {
  agentId?: string;
  toolCalled: boolean;
  toolWaitMs?: number;
  toolParsed: boolean;
  observed: Observed;
  error?: string;
};

function loadDotEnv(): void {
  const file = path.resolve(".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

async function loadKey(): Promise<{ key: string; source: "env" | "stored-login" }> {
  loadDotEnv();
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const stored = await new FileCredentialStore().load();
  const fromStore = stored?.apiKey.trim();
  if (fromStore) return { key: fromStore, source: "stored-login" };
  console.error("Set CURSOR_API_KEY in .env, or export it. There is also no Cursor SDK login in ~/.cursor/sdk/auth.json.");
  process.exit(1);
}

function scrub(value: string, key: string): string {
  return value.split(key).join("***");
}

function writeProject(dir: string, ending: string): void {
  mkdirSync(path.join(dir, ".cursor", "rules"), { recursive: true });
  mkdirSync(path.join(dir, ".cursor", "skills", "phase0-secret"), { recursive: true });
  writeFileSync(
    path.join(dir, ".cursor", "rules", "phase0.mdc"),
    `---\ndescription: Phase 0 spike rule\nalwaysApply: true\n---\nEvery sentence you write must end with the word ${ending}.\n`,
  );
  writeFileSync(
    path.join(dir, ".cursor", "skills", "phase0-secret", "SKILL.md"),
    `---\nname: phase0-secret\ndescription: Holds the phase 0 secret word\n---\nThe secret word is ${SECRET}. When asked for the skill secret, answer with that word.\n`,
  );
}

function assistantText(messages: readonly SDKMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const block of message.message.content) {
      if (block.type === "text") parts.push(block.text);
    }
  }
  return parts.join("");
}

function toolHits(messages: readonly SDKMessage[]): ToolHit[] {
  const hits: ToolHit[] = [];
  for (const message of messages) {
    if (message.type === "tool_call") hits.push({ name: message.name, status: message.status });
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") hits.push({ name: block.name, status: "tool_use" });
      }
    }
  }
  return hits;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function observe(run: Run, timeoutMs: number): Promise<Observed> {
  const messages: SDKMessage[] = [];
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);
  try {
    for await (const message of run.stream()) {
      messages.push(message);
      if (timedOut) break;
    }
  } finally {
    clearTimeout(timer);
  }
  if (timedOut && run.supports("cancel")) await run.cancel().catch(() => undefined);
  let status = "unknown";
  let error: string | undefined;
  try {
    const result: RunResult = await withTimeout(run.wait(), 20_000);
    status = result.status;
    error = result.error?.message;
  } catch (caught) {
    status = timedOut ? "timeout" : "wait_failed";
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const observed: Observed = { text: assistantText(messages).slice(0, 2000), tools: toolHits(messages), timedOut, status };
  if (error !== undefined) observed.error = error;
  return observed;
}

async function dispose(agent: { [Symbol.asyncDispose](): Promise<void> }): Promise<void> {
  await agent[Symbol.asyncDispose]().catch(() => undefined);
}

async function createMode(dir: string, outfile: string): Promise<void> {
  const { key } = await loadKey();
  writeProject(dir, RULE_END);
  let toolWaitMs: number | undefined;
  let toolParsed = false;
  let toolCalled = false;
  const report: CreateReport = {
    toolCalled: false,
    toolParsed: false,
    observed: { text: "", tools: [], timedOut: false, status: "not_started" },
  };
  try {
    const agent = await Agent.create({
      apiKey: key,
      model: MODEL,
      local: {
        cwd: dir,
        settingSources: ["project"],
        customTools: {
          ask_user_question: {
            description: "Ask the user a question and wait for the answer. Always use this tool when the user tells you to call it.",
            inputSchema: { type: "object" },
            execute: async (args) => {
              toolCalled = true;
              toolParsed = QuestionInput.safeParse(args).success;
              const started = Date.now();
              await new Promise((resolve) => setTimeout(resolve, 5_000));
              toolWaitMs = Date.now() - started;
              return TOKEN;
            },
          },
        },
      },
    });
    report.agentId = agent.agentId;
    try {
      const run = await agent.send(
        [
          "Follow the project rule and the project skill.",
          "Call the tool named ask_user_question once. Then reply with exactly three lines and no other text:",
          "SKILL <the secret word from the project skill>",
          "TOOL <the token string the tool returned>",
          "RULE <one short sentence that obeys the project rule>",
        ].join("\n"),
      );
      report.observed = await observe(run, 120_000);
    } finally {
      await dispose(agent);
    }
  } catch (caught) {
    report.error = caught instanceof CursorAgentError ? `startup: ${caught.message}` : caught instanceof Error ? caught.message : String(caught);
  }
  report.toolCalled = toolCalled;
  report.toolParsed = toolParsed;
  if (toolWaitMs !== undefined) report.toolWaitMs = toolWaitMs;
  writeFileSync(outfile, JSON.stringify(report));
}

function isAskQuestion(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll("_", "");
  return normalized.includes("askquestion");
}

async function main(): Promise<void> {
  const { key, source } = await loadKey();
  const createFlag = process.argv.indexOf("--create");
  if (createFlag !== -1) {
    const dir = process.argv[createFlag + 1];
    const outfile = process.argv[createFlag + 2];
    if (dir === undefined || outfile === undefined) throw new Error("--create needs a directory and an output file");
    await createMode(dir, outfile);
    return;
  }

  const root = mkdtempSync(path.join(tmpdir(), "flowfe-phase0-"));
  const project = path.join(root, "project");
  const outfile = path.join(root, "create.json");
  mkdirSync(project);

  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", import.meta.filename, "--create", project, outfile], {
    stdio: "inherit",
    env: process.env,
  });
  const childCode = await withTimeout(
    new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1))),
    240_000,
  ).catch(() => {
    child.kill("SIGKILL");
    return -1;
  });

  const created: CreateReport = childCode === 0 ? (JSON.parse(readFileSync(outfile, "utf8")) as CreateReport) : { toolCalled: false, toolParsed: false, observed: { text: "", tools: [], timedOut: false, status: "child_failed" }, error: `create process exited ${childCode}` };

  let resume: Observed | undefined;
  let resumeError: string | undefined;
  if (created.agentId !== undefined) {
    writeProject(project, NEW_END);
    try {
      const agent = await Agent.resume(created.agentId, {
        apiKey: key,
        model: MODEL,
        local: { cwd: project, settingSources: ["project"] },
      });
      try {
        const run = await agent.send(
          ["Reply with exactly two lines and no other text:", "WORD <the secret word you reported last turn>", "SENTENCE <one short sentence that obeys the current project rule>"].join("\n"),
        );
        resume = await observe(run, 120_000);
      } finally {
        await dispose(agent);
      }
    } catch (caught) {
      resumeError = caught instanceof Error ? caught.message : String(caught);
    }
  }

  const askDir = path.join(root, "ask");
  mkdirSync(askDir);
  writeFileSync(path.join(askDir, "README.md"), "empty project for the askQuestion check\n");
  let ask: Observed | undefined;
  let askError: string | undefined;
  try {
    const agent = await Agent.create({
      apiKey: key,
      model: MODEL,
      local: { cwd: askDir, settingSources: ["project"] },
    });
    try {
      const run = await agent.send(
        "Use the askQuestion tool before you answer. Ask which of these two options to use: oak or pine. Do not pick one yourself. If you cannot call that tool, reply with exactly NO_ASK_TOOL.",
      );
      ask = await observe(run, 45_000);
    } finally {
      await dispose(agent);
    }
  } catch (caught) {
    askError = caught instanceof Error ? caught.message : String(caught);
  }

  const text = created.observed.text;
  const resumeText = resume?.text ?? "";
  const askTools = (ask?.tools ?? []).filter((tool) => isAskQuestion(tool.name));
  const report = {
    keySource: source,
    reusedFromMango: ["S1", "S3", "S8", "S22"],
    rulesSkill: {
      sawSecret: text.includes(SECRET),
      obeyedRule: text.includes(RULE_END),
    },
    customTool: {
      called: created.toolCalled,
      parsed: created.toolParsed,
      waitMs: created.toolWaitMs ?? null,
      waitedAtLeast5s: (created.toolWaitMs ?? 0) >= 4_500,
      tokenReachedAgent: text.includes(TOKEN),
    },
    askQuestion: {
      appeared: askTools.length > 0,
      names: askTools.map((tool) => tool.name),
      statuses: askTools.map((tool) => tool.status),
      runTimedOut: ask?.timedOut ?? false,
      runStatus: ask?.status ?? "not_started",
      repliedNoTool: (ask?.text ?? "").includes("NO_ASK_TOOL"),
      error: askError ?? ask?.error ?? null,
    },
    resume: {
      keptSecret: resumeText.includes(SECRET),
      rereadNewRule: resumeText.includes(NEW_END),
      keptOldRule: resumeText.includes(RULE_END),
      status: resume?.status ?? "not_started",
      error: resumeError ?? resume?.error ?? null,
    },
    createError: created.error ?? created.observed.error ?? null,
    childCode,
  };

  const outDir = path.resolve(".spike");
  mkdirSync(outDir, { recursive: true });
  const written = scrub(JSON.stringify(report, null, 2), key);
  writeFileSync(path.join(outDir, "phase0-result.json"), written);
  console.log(written);
  rmSync(root, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
