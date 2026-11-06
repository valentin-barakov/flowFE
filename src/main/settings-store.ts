// settings.json, chats/<folderId>.json, and the encrypted key.
// Writes go through writeAtomic in atomic-write.ts (temp file, mode 0600, then rename).
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeAtomic } from "./atomic-write.js";
import {
  MessageSchema,
  type AgentMode,
  type Message,
  type Settings,
  type Theme,
} from "../shared/ipc.js";

export type SecretBox = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

type SettingsFile = {
  folder: string | null;
  model: string | null;
  mode: AgentMode;
  theme: Theme;
};

type ChatFile = {
  agentId: string | null;
  messages: Message[];
};

const SettingsFileSchema = z.object({
  folder: z.string().nullable(),
  model: z.string().nullable(),
  mode: z.enum(["agent", "plan"]).default("agent"),
  theme: z.enum(["system", "light", "dark"]),
});

const ChatFileSchema = z.object({
  agentId: z.string().nullable(),
  messages: z.array(MessageSchema),
});

const EMPTY_SETTINGS: SettingsFile = { folder: null, model: null, mode: "agent", theme: "system" };
const EMPTY_CHAT: ChatFile = { agentId: null, messages: [] };

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// EMPTY_CHAT_BYTES depends on serialize.
const EMPTY_CHAT_BYTES = Buffer.byteLength(serialize(EMPTY_CHAT));

export type RepoRecord = { name: string; path: string };

export type SettingsStore = {
  view(): Settings;
  save(partial: { folder?: string; model?: string; mode?: AgentMode; theme?: Theme }): Settings;
  setKey(key: string): void;
  clearKey(): void;
  readKey(): string | null;
  listRepos(root: string): RepoRecord[];
  readChat(repoPath: string): ChatFile;
  writeChat(repoPath: string, chat: ChatFile): void;
  /** True when the chat file is larger than an empty chat and is not only an agentId with no messages. */
  hasChatHistory(repoPath: string): boolean;
};

export function createSettingsStore(options: { userDataDir: string; secrets: SecretBox }): SettingsStore {
  const settingsPath = path.join(options.userDataDir, "settings.json");
  const secretsPath = path.join(options.userDataDir, "secrets.bin");
  const chatsDir = path.join(options.userDataDir, "chats");

  function readSettings(): SettingsFile {
    return readJson(settingsPath, SettingsFileSchema, EMPTY_SETTINGS);
  }

  function view(): Settings {
    const file = readSettings();
    const folderOk = file.folder !== null && isDirectory(file.folder);
    const keySet = readKey() !== null;
    return {
      folder: file.folder,
      model: file.model,
      mode: file.mode,
      theme: file.theme,
      keySet,
      folderMissing: file.folder !== null && !folderOk,
      setupComplete: keySet && folderOk && file.model !== null,
    };
  }

  function save(partial: { folder?: string; model?: string; mode?: AgentMode; theme?: Theme }): Settings {
    const current = readSettings();
    const next: SettingsFile = {
      folder: partial.folder === undefined ? current.folder : resolveFolder(partial.folder),
      model: partial.model === undefined ? current.model : partial.model,
      mode: partial.mode === undefined ? current.mode : partial.mode,
      theme: partial.theme === undefined ? current.theme : partial.theme,
    };
    writeJson(settingsPath, next);
    return view();
  }

  function setKey(key: string): void {
    if (!options.secrets.isEncryptionAvailable()) {
      throw new Error("This Mac cannot encrypt the key right now.");
    }
    writeBytes(secretsPath, options.secrets.encryptString(key));
  }

  function clearKey(): void {
    if (!existsSync(secretsPath)) return;
    try {
      renameSync(secretsPath, `${secretsPath}.${Date.now()}.cleared`);
    } catch {
      // A failed rename leaves the old key in place. The next setKey overwrites it.
    }
  }

  function readKey(): string | null {
    if (!existsSync(secretsPath)) return null;
    if (!options.secrets.isEncryptionAvailable()) return null;
    try {
      const encrypted = readFileSync(secretsPath);
      if (encrypted.length === 0) return null;
      const key = options.secrets.decryptString(encrypted).trim();
      return key === "" ? null : key;
    } catch {
      return null;
    }
  }

  function listRepos(root: string): RepoRecord[] {
    let resolved: string;
    try {
      resolved = realpathSync(root);
    } catch {
      return [];
    }
    if (!isDirectory(resolved)) return [];
    if (hasGit(resolved)) return [{ name: ".", path: resolved }];
    let entries: Dirent[];
    try {
      entries = readdirSync(resolved, { withFileTypes: true });
    } catch {
      return [{ name: ".", path: resolved }];
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const found: RepoRecord[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\\") || /[\s@]/.test(entry.name)) continue;
      const child = path.join(resolved, entry.name);
      let real: string;
      try {
        real = realpathSync(child);
      } catch {
        continue;
      }
      if (!isDirectory(real) || !hasGit(real) || seen.has(real)) continue;
      seen.add(real);
      found.push({ name: entry.name, path: real });
    }
    if (found.length === 0) return [{ name: ".", path: resolved }];
    return found;
  }

  function chatPath(repoPath: string): string | null {
    let resolved: string;
    try {
      resolved = realpathSync(repoPath);
    } catch {
      return null;
    }
    if (!isDirectory(resolved)) return null;
    return path.join(chatsDir, `${folderId(resolved)}.json`);
  }

  function readChat(repoPath: string): ChatFile {
    const file = chatPath(repoPath);
    if (file === null) return EMPTY_CHAT;
    return readJson(file, ChatFileSchema, EMPTY_CHAT);
  }

  function writeChat(repoPath: string, chat: ChatFile): void {
    const file = chatPath(repoPath);
    if (file === null) throw new Error("Choose a folder before saving the chat.");
    writeJson(file, chat);
  }

  function hasChatHistory(repoPath: string): boolean {
    const file = chatPath(repoPath);
    if (file === null) return false;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return false;
    }
    if (size <= EMPTY_CHAT_BYTES) return false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (hasMessages(parsed)) return true;
      if (isAgentIdOnly(parsed)) return false;
    } catch {
      // Larger than an empty chat, and not an agentId with no messages.
    }
    return true;
  }

  return { view, save, setKey, clearKey, readKey, listRepos, readChat, writeChat, hasChatHistory };
}

function resolveFolder(folder: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(folder);
  } catch {
    throw new Error("That folder is missing.");
  }
  if (!isDirectory(resolved)) throw new Error("Choose a folder, not a file.");
  return resolved;
}

function isDirectory(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function hasGit(dir: string): boolean {
  try {
    statSync(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

function folderId(folder: string): string {
  return createHash("sha256").update(folder).digest("hex");
}

function readJson<T>(file: string, schema: z.ZodType<T>, fallback: T): T {
  if (!existsSync(file)) return fallback;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    // Move the unreadable file aside and use the fallback.
  }
  quarantine(file);
  return fallback;
}

function writeJson(file: string, value: unknown): void {
  writeAtomic(file, serialize(value));
}

function hasMessages(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const messages = (value as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.length > 0;
}

function isAgentIdOnly(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { agentId?: unknown; messages?: unknown };
  if (typeof record.agentId !== "string") return false;
  if (!Array.isArray(record.messages) || record.messages.length !== 0) return false;
  const keys = Object.keys(record);
  return keys.length === 2 && keys.includes("agentId") && keys.includes("messages");
}

function writeBytes(file: string, data: Buffer): void {
  writeAtomic(file, data);
}

function quarantine(file: string): void {
  try {
    renameSync(file, `${file}.${Date.now()}.corrupt`);
  } catch {
    // The next successful write replaces the file. Until then reads use the fallback.
  }
}
