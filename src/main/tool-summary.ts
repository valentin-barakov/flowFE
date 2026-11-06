// Turns the arguments of an SDK tool call into the one short line the chat shows.
// No SDK import, no I/O. agent-service.ts calls it.

/** First key found wins. Shell commands come first, then searches, then paths. */
const KEYS = [
  "command",
  "cmd",
  "query",
  "searchTerm",
  "pattern",
  "globPattern",
  "glob_pattern",
  "glob",
  "url",
  "path",
  "file_path",
  "filePath",
  "filename",
  "fileName",
  "target_file",
  "targetFile",
  "relative_workspace_path",
  "relativeWorkspacePath",
  "file",
  "targetDirectory",
  "target_directory",
] as const;

const MAX_DETAIL = 160;

export function toolDetail(args: unknown, cwd: string, toolName = ""): string {
  const record = flatten(asRecord(args));
  if (isMcp(toolName, record)) {
    const label = mcpLabel(record);
    if (label !== "") return clip(label, MAX_DETAIL);
  }
  const text = firstText(record ?? args).replace(/\s+/g, " ").trim();
  if (text === "") return "";
  return clip(relativeTo(text, cwd), MAX_DETAIL);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      return asRecord(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The SDK sometimes wraps the call as `{ args: { path } }`. Outer fields win over the inner bag. */
function flatten(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (record === null) return null;
  const inner = asRecord(record.args);
  if (inner === null) return record;
  return { ...inner, ...record };
}

function isMcp(toolName: string, record: Record<string, unknown> | null): boolean {
  if (toolName.toLowerCase().includes("mcp")) return true;
  if (record === null) return false;
  return typeof record.providerIdentifier === "string" || typeof record.serverIdentifier === "string";
}

function mcpLabel(record: Record<string, unknown> | null): string {
  if (record === null) return "";
  const server = textAt(record, ["providerIdentifier", "serverIdentifier", "serverName", "server"]);
  const tool = textAt(record, ["toolName"]);
  const named = textAt(record, ["name"]);
  const serverLabel = server !== "" ? server : named !== "" && named !== tool ? named : "";
  if (serverLabel !== "" && tool !== "" && serverLabel !== tool) return `${serverLabel} ${tool}`;
  if (tool !== "") return tool;
  return serverLabel;
}

function textAt(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const item = record[key];
    if (typeof item === "string" && item.trim() !== "") return item.trim();
  }
  return "";
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of KEYS) {
    const item = record[key];
    if (typeof item === "string" && item.trim() !== "") return item;
  }
  const paths = record["paths"];
  if (Array.isArray(paths)) {
    const names = paths.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    const first = names[0];
    if (first !== undefined) return names.length > 1 ? `${first} +${names.length - 1}` : first;
  }
  return "";
}

function relativeTo(text: string, cwd: string): string {
  if (cwd === "") return text;
  if (text === cwd) return ".";
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
