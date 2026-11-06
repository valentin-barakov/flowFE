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
  "target_file",
  "targetFile",
  "relative_workspace_path",
  "relativeWorkspacePath",
  "file",
  "targetDirectory",
  "target_directory",
] as const;

const MAX_DETAIL = 160;

export function toolDetail(args: unknown, cwd: string): string {
  const text = firstText(args).replace(/\s+/g, " ").trim();
  if (text === "") return "";
  return clip(relativeTo(text, cwd), MAX_DETAIL);
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
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
