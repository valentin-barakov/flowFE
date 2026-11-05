// Registers commands. Checks the sender, parses the input, and returns a Result.
import { dialog, ipcMain, type BrowserWindow } from "electron";
import { ZodError } from "zod";
import { COMMANDS, failure, type CommandChannel, type FlowEvent, type InputOf, type OutputOf, type Result } from "../shared/ipc.js";
import type { ChatSession } from "./chat-session.js";
import { SessionError } from "./chat-session.js";
import type { RulesSkills } from "./rules-skills-service.js";
import { FilesError } from "./rules-skills-service.js";

export type IpcHost = {
  window: BrowserWindow | null;
  senderId: number;
};

export function registerIpc(host: IpcHost, session: ChatSession, files: RulesSkills): void {
  const channels = Object.keys(COMMANDS) as CommandChannel[];
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, input: unknown): Promise<Result<OutputOf<typeof channel>>> => {
      if (host.window === null || event.sender.id !== host.senderId) {
        return failure("not_allowed", "Wrong sender", false);
      }
      const parsed = COMMANDS[channel].input.safeParse(input);
      if (!parsed.success) return failure("invalid_input", issueMessage(parsed.error), false);
      try {
        const value = await run(channel, parsed.data, host, session, files);
        const checked = COMMANDS[channel].output.safeParse(value);
        if (!checked.success) return failure("io_error", "The app sent a bad response", false);
        return { ok: true, value: checked.data };
      } catch (error) {
        if (error instanceof SessionError) return failure(error.code, error.message, error.retryable);
        if (error instanceof FilesError) return failure(error.code, error.message, error.retryable);
        return failure("io_error", "Something went wrong", false);
      }
    });
  }
}

export function publish(host: IpcHost, event: FlowEvent): void {
  const window = host.window;
  if (window === null || window.isDestroyed()) return;
  window.webContents.send("flow:event", event);
}

async function run<C extends CommandChannel>(
  channel: C,
  input: InputOf<C>,
  host: IpcHost,
  session: ChatSession,
  files: RulesSkills,
): Promise<OutputOf<C>> {
  switch (channel) {
    case "flow:settings.get":
      return session.view() as OutputOf<C>;
    case "flow:settings.save":
      return session.save(saveInput(input as InputOf<"flow:settings.save">)) as Promise<OutputOf<C>>;
    case "flow:key.set":
      await session.setKey((input as InputOf<"flow:key.set">).key);
      return {} as OutputOf<C>;
    case "flow:key.clear":
      await session.clearKey();
      return {} as OutputOf<C>;
    case "flow:folder.pick":
      return pickFolder(host) as Promise<OutputOf<C>>;
    case "flow:models.list":
      return { models: await session.listModels() } as OutputOf<C>;
    case "flow:chat.send":
      return session.send((input as InputOf<"flow:chat.send">).text) as Promise<OutputOf<C>>;
    case "flow:chat.stop":
      await session.stop();
      return {} as OutputOf<C>;
    case "flow:chat.history":
      return session.history() as OutputOf<C>;
    case "flow:chat.reset":
      await session.reset();
      return {} as OutputOf<C>;
    case "flow:chat.state":
      return session.state() as OutputOf<C>;
    case "flow:question.answer": {
      const body = input as InputOf<"flow:question.answer">;
      session.answer(body.questionId, body.answers);
      return {} as OutputOf<C>;
    }
    case "flow:question.skip":
      session.skip((input as InputOf<"flow:question.skip">).questionId);
      return {} as OutputOf<C>;
    case "flow:rules.list":
      return files.listRules() as OutputOf<C>;
    case "flow:rules.read":
      return files.readRule((input as InputOf<"flow:rules.read">).name) as OutputOf<C>;
    case "flow:rules.write":
      return files.writeRule(input as InputOf<"flow:rules.write">) as OutputOf<C>;
    case "flow:rules.delete":
      files.deleteRule((input as InputOf<"flow:rules.delete">).name);
      return {} as OutputOf<C>;
    case "flow:skills.list":
      return files.listSkills() as OutputOf<C>;
    case "flow:skills.read":
      return files.readSkill((input as InputOf<"flow:skills.read">).name) as OutputOf<C>;
    case "flow:skills.write":
      return files.writeSkill(input as InputOf<"flow:skills.write">) as OutputOf<C>;
    case "flow:skills.delete":
      files.deleteSkill((input as InputOf<"flow:skills.delete">).name);
      return {} as OutputOf<C>;
    case "flow:agentsmd.read":
      return files.readAgents() as OutputOf<C>;
    case "flow:agentsmd.write":
      return files.writeAgents((input as InputOf<"flow:agentsmd.write">).body) as OutputOf<C>;
    default:
      return assertNever(channel);
  }
}

async function pickFolder(host: IpcHost): Promise<{ folder: string | null }> {
  const window = host.window;
  if (window === null) return { folder: null };
  const result = await dialog.showOpenDialog(window, {
    title: "Choose a folder",
    properties: ["openDirectory", "createDirectory"],
  });
  const folder = result.filePaths[0];
  if (result.canceled || folder === undefined) return { folder: null };
  return { folder };
}

function issueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? "Invalid input";
}

function saveInput(input: InputOf<"flow:settings.save">): { folder?: string; model?: string; theme?: "system" | "light" | "dark" } {
  const partial: { folder?: string; model?: string; theme?: "system" | "light" | "dark" } = {};
  if (input.folder !== undefined) partial.folder = input.folder;
  if (input.model !== undefined) partial.model = input.model;
  if (input.theme !== undefined) partial.theme = input.theme;
  return partial;
}

function assertNever(value: never): never {
  throw new Error(`Unknown command ${String(value)}`);
}
