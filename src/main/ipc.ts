// Registers commands. Checks the sender, parses the input, and returns a Result.
import { dialog, ipcMain, type BrowserWindow } from "electron";
import { ZodError } from "zod";
import { COMMANDS, failure, type CommandChannel, type FlowEvent, type InputOf, type OutputOf, type Result } from "../shared/ipc.js";
import type { SessionManager } from "./session-manager.js";
import { SessionError } from "./chat-session.js";
import { JiraError, type JiraService } from "./jira-service.js";
import type { RulesSkills } from "./rules-skills-service.js";
import { FilesError } from "./rules-skills-service.js";

export type IpcHost = {
  window: BrowserWindow | null;
  senderId: number;
};

export function registerIpc(host: IpcHost, manager: SessionManager, files: RulesSkills, jira: JiraService): void {
  const channels = Object.keys(COMMANDS) as CommandChannel[];
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, input: unknown): Promise<Result<OutputOf<typeof channel>>> => {
      if (host.window === null || event.sender.id !== host.senderId) {
        return failure("not_allowed", "Wrong sender", false);
      }
      const parsed = COMMANDS[channel].input.safeParse(input);
      if (!parsed.success) return failure("invalid_input", issueMessage(parsed.error), false);
      try {
        const value = await run(channel, parsed.data, host, manager, files, jira);
        const checked = COMMANDS[channel].output.safeParse(value);
        if (!checked.success) return failure("io_error", "The app sent a bad response", false);
        return { ok: true, value: checked.data };
      } catch (error) {
        if (error instanceof SessionError) return failure(error.code, error.message, error.retryable);
        if (error instanceof FilesError) return failure(error.code, error.message, error.retryable);
        if (error instanceof JiraError) return failure(error.code, error.message, error.retryable);
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
  manager: SessionManager,
  files: RulesSkills,
  jira: JiraService,
): Promise<OutputOf<C>> {
  switch (channel) {
    case "flow:settings.get":
      return manager.view() as OutputOf<C>;
    case "flow:settings.save":
      return manager.save(saveInput(input as InputOf<"flow:settings.save">)) as Promise<OutputOf<C>>;
    case "flow:key.set":
      await manager.setKey((input as InputOf<"flow:key.set">).key);
      return {} as OutputOf<C>;
    case "flow:key.clear":
      await manager.clearKey();
      return {} as OutputOf<C>;
    case "flow:folder.pick":
      return pickFolder(host) as Promise<OutputOf<C>>;
    case "flow:models.list":
      return { models: await manager.listModels() } as OutputOf<C>;
    case "flow:repos.list":
      return { repos: manager.repos() } as OutputOf<C>;
    case "flow:chat.send": {
      const body = input as InputOf<"flow:chat.send">;
      return manager.send(body.repo, body.text) as Promise<OutputOf<C>>;
    }
    case "flow:chat.stop":
      await manager.stop((input as InputOf<"flow:chat.stop">).repo);
      return {} as OutputOf<C>;
    case "flow:chat.history":
      return manager.history((input as InputOf<"flow:chat.history">).repo) as OutputOf<C>;
    case "flow:chat.reset":
      await manager.reset((input as InputOf<"flow:chat.reset">).repo);
      return {} as OutputOf<C>;
    case "flow:chat.state":
      return manager.state((input as InputOf<"flow:chat.state">).repo) as OutputOf<C>;
    case "flow:question.answer": {
      const body = input as InputOf<"flow:question.answer">;
      manager.answer(body.repo, body.questionId, body.answers);
      return {} as OutputOf<C>;
    }
    case "flow:question.skip": {
      const body = input as InputOf<"flow:question.skip">;
      manager.skip(body.repo, body.questionId);
      return {} as OutputOf<C>;
    }
    case "flow:rules.list":
      return files.listRules(manager.repoPath((input as InputOf<"flow:rules.list">).repo)) as OutputOf<C>;
    case "flow:rules.read": {
      const body = input as InputOf<"flow:rules.read">;
      return files.readRule(manager.repoPath(body.repo), body.name) as OutputOf<C>;
    }
    case "flow:rules.write": {
      const body = input as InputOf<"flow:rules.write">;
      return files.writeRule(manager.repoPath(body.repo), {
        name: body.name,
        description: body.description,
        alwaysApply: body.alwaysApply,
        globs: body.globs,
        body: body.body,
      }) as OutputOf<C>;
    }
    case "flow:rules.delete": {
      const body = input as InputOf<"flow:rules.delete">;
      files.deleteRule(manager.repoPath(body.repo), body.name);
      return {} as OutputOf<C>;
    }
    case "flow:skills.list":
      return files.listSkills(manager.repoPath((input as InputOf<"flow:skills.list">).repo)) as OutputOf<C>;
    case "flow:skills.read": {
      const body = input as InputOf<"flow:skills.read">;
      return files.readSkill(manager.repoPath(body.repo), body.name) as OutputOf<C>;
    }
    case "flow:skills.write": {
      const body = input as InputOf<"flow:skills.write">;
      return files.writeSkill(manager.repoPath(body.repo), {
        name: body.name,
        description: body.description,
        body: body.body,
      }) as OutputOf<C>;
    }
    case "flow:skills.delete": {
      const body = input as InputOf<"flow:skills.delete">;
      files.deleteSkill(manager.repoPath(body.repo), body.name);
      return {} as OutputOf<C>;
    }
    case "flow:agentsmd.read":
      return files.readAgents(manager.repoPath((input as InputOf<"flow:agentsmd.read">).repo)) as OutputOf<C>;
    case "flow:agentsmd.write": {
      const body = input as InputOf<"flow:agentsmd.write">;
      return files.writeAgents(manager.repoPath(body.repo), body.body) as OutputOf<C>;
    }
    case "flow:jira.status":
      return jira.status() as OutputOf<C>;
    case "flow:jira.save": {
      const body = input as InputOf<"flow:jira.save">;
      return jira.saveAccount({
        email: body.email,
        site: body.site,
        ...(body.token !== undefined ? { token: body.token } : {}),
      }) as OutputOf<C>;
    }
    case "flow:jira.clear":
      return jira.clear() as OutputOf<C>;
    case "flow:jira.issues":
      return (await jira.issues(input as InputOf<"flow:jira.issues">)) as OutputOf<C>;
    case "flow:jira.open":
      await jira.open((input as InputOf<"flow:jira.open">).key);
      return {} as OutputOf<C>;
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

function saveInput(input: InputOf<"flow:settings.save">): { folder?: string; model?: string; mode?: "agent" | "plan"; theme?: "system" | "light" | "dark" } {
  const partial: { folder?: string; model?: string; mode?: "agent" | "plan"; theme?: "system" | "light" | "dark" } = {};
  if (input.folder !== undefined) partial.folder = input.folder;
  if (input.model !== undefined) partial.model = input.model;
  if (input.mode !== undefined) partial.mode = input.mode;
  if (input.theme !== undefined) partial.theme = input.theme;
  return partial;
}

function assertNever(value: never): never {
  throw new Error(`Unknown command ${String(value)}`);
}
