// settings.json, chats/<folderId>.json, and the encrypted key. One writer. Temp file, then rename.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MessageSchema, type Message, type Settings, type Theme } from "../shared/ipc.js";

export type SecretBox = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

type SettingsFile = {
  folder: string | null;
  model: string | null;
  theme: Theme;
};

type ChatFile = {
  agentId: string | null;
  messages: Message[];
};

const SettingsFileSchema = z.object({
  folder: z.string().nullable(),
  model: z.string().nullable(),
  theme: z.enum(["system", "light", "dark"]),
});

const ChatFileSchema = z.object({
  agentId: z.string().nullable(),
  messages: z.array(MessageSchema),
});

const EMPTY_SETTINGS: SettingsFile = { folder: null, model: null, theme: "system" };
const EMPTY_CHAT: ChatFile = { agentId: null, messages: [] };

export type SettingsStore = {
  view(): Settings;
  save(partial: { folder?: string; model?: string; theme?: Theme }): Settings;
  setKey(key: string): void;
  clearKey(): void;
  readKey(): string | null;
  readChat(): ChatFile;
  writeChat(chat: ChatFile): void;
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
      theme: file.theme,
      keySet,
      folderMissing: file.folder !== null && !folderOk,
      setupComplete: keySet && folderOk && file.model !== null,
    };
  }

  function save(partial: { folder?: string; model?: string; theme?: Theme }): Settings {
    const current = readSettings();
    const next: SettingsFile = {
      folder: partial.folder === undefined ? current.folder : resolveFolder(partial.folder),
      model: partial.model === undefined ? current.model : partial.model,
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

  function chatFile(): string | null {
    const folder = readSettings().folder;
    if (folder === null || !isDirectory(folder)) return null;
    return path.join(chatsDir, `${folderId(folder)}.json`);
  }

  function readChat(): ChatFile {
    const file = chatFile();
    if (file === null) return EMPTY_CHAT;
    return readJson(file, ChatFileSchema, EMPTY_CHAT);
  }

  function writeChat(chat: ChatFile): void {
    const file = chatFile();
    if (file === null) throw new Error("Choose a folder before saving the chat.");
    writeJson(file, chat);
  }

  return { view, save, setKey, clearKey, readKey, readChat, writeChat };
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
  writeAtomic(file, JSON.stringify(value, null, 2));
}

function writeBytes(file: string, data: Buffer): void {
  writeAtomic(file, data);
}

function writeAtomic(file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function quarantine(file: string): void {
  try {
    renameSync(file, `${file}.${Date.now()}.corrupt`);
  } catch {
    // The next successful write replaces the file. Until then reads use the fallback.
  }
}
