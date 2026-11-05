// Allowlisted reads and writes for the chosen folder. Nothing outside it.
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import type { Rule, RuleSummary, Skill, SkillSummary } from "../shared/ipc.js";

// Keep this identical to INSTRUCTION_NAME in src/shared/ipc.ts.
const NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const MAX_DESCRIPTION = 4_000;
const MAX_GLOBS = 1_000;
const MAX_BODY = 200_000;

export class FilesError extends Error {
  readonly code: "not_ready" | "not_found" | "not_allowed" | "conflict" | "io_error";
  readonly retryable = false;

  constructor(code: FilesError["code"], message: string) {
    super(message);
    this.name = "FilesError";
    this.code = code;
  }
}

export type RulesSkills = {
  listRules(): RuleSummary[];
  readRule(name: string): Rule;
  writeRule(rule: Rule): Rule;
  deleteRule(name: string): void;
  listSkills(): SkillSummary[];
  readSkill(name: string): Skill;
  writeSkill(skill: Skill): Skill;
  deleteSkill(name: string): void;
  readAgents(): { body: string };
  writeAgents(body: string): { body: string };
  seenDirty(folder: string): number;
  clearDirty(folder: string, seen: number): void;
};

export function createRulesSkills(options: { folder(): string | null }): RulesSkills {
  const dirty = new Map<string, number>();
  let clock = 0;

  function touch(root: string): void {
    clock += 1;
    dirty.set(root, clock);
  }

  function seenDirty(folder: string): number {
    try {
      return dirty.get(realpathSync(folder)) ?? 0;
    } catch {
      return 0;
    }
  }

  function clearDirty(folder: string, seen: number): void {
    if (seen === 0) return;
    try {
      const root = realpathSync(folder);
      if (dirty.get(root) === seen) dirty.delete(root);
    } catch {
      // A missing folder cannot match a later real path.
    }
  }

  function listRules(): RuleSummary[] {
    const root = projectRoot(options.folder());
    const dir = existingDir(root, [".cursor", "rules"]);
    if (dir === null) return [];
    const summaries: RuleSummary[] = [];
    for (const name of listFiles(dir, ".mdc")) {
      try {
        const rule = parseRule(name, readText(root, dir, `${name}.mdc`));
        summaries.push({ name, description: rule.description, alwaysApply: rule.alwaysApply });
      } catch {
        // One unreadable file stays out of the list. Opening it by name still reports the error.
      }
    }
    return summaries;
  }

  function readRule(name: string): Rule {
    assertName(name);
    const root = projectRoot(options.folder());
    const dir = existingDir(root, [".cursor", "rules"]);
    if (dir === null) throw new FilesError("not_found", "That rule is missing");
    return parseRule(name, readText(root, dir, `${name}.mdc`));
  }

  function writeRule(rule: Rule): Rule {
    assertName(rule.name);
    assertSize(rule.description, rule.globs, rule.body);
    const root = projectRoot(options.folder());
    const dir = ensureInside(root, [".cursor", "rules"]);
    const stored: Rule = {
      name: rule.name,
      description: rule.description.trim(),
      alwaysApply: rule.alwaysApply,
      globs: rule.globs.trim(),
      body: rule.body,
    };
    commitFile(root, dir, `${rule.name}.mdc`, renderRule(stored), touch);
    return parseRule(rule.name, readText(root, dir, `${rule.name}.mdc`));
  }

  function deleteRule(name: string): void {
    assertName(name);
    const root = projectRoot(options.folder());
    const dir = existingDir(root, [".cursor", "rules"]);
    if (dir === null) throw new FilesError("not_found", "That rule is missing");
    removeFile(root, dir, `${name}.mdc`, "That rule is missing");
    touch(root);
  }

  function listSkills(): SkillSummary[] {
    const root = projectRoot(options.folder());
    const dir = existingDir(root, [".cursor", "skills"]);
    if (dir === null) return [];
    const summaries: SkillSummary[] = [];
    for (const name of listDirs(dir)) {
      try {
        const skill = parseSkill(name, readText(root, path.join(dir, name), "SKILL.md"));
        summaries.push({ name, description: skill.description });
      } catch {
        // A skill folder without a readable SKILL.md is not listed.
      }
    }
    return summaries;
  }

  function readSkill(name: string): Skill {
    assertName(name);
    const root = projectRoot(options.folder());
    const dir = skillDir(root, name);
    return parseSkill(name, readText(root, dir, "SKILL.md"));
  }

  function writeSkill(skill: Skill): Skill {
    assertName(skill.name);
    assertSize(skill.description, "", skill.body);
    const root = projectRoot(options.folder());
    const dir = ensureInside(root, [".cursor", "skills", skill.name]);
    const stored: Skill = { name: skill.name, description: skill.description.trim(), body: skill.body };
    commitFile(root, dir, "SKILL.md", renderSkill(stored), touch);
    return parseSkill(skill.name, readText(root, dir, "SKILL.md"));
  }

  function deleteSkill(name: string): void {
    assertName(name);
    const root = projectRoot(options.folder());
    const skillsRoot = existingDir(root, [".cursor", "skills"]);
    if (skillsRoot === null) throw new FilesError("not_found", "That skill is missing");
    const dir = path.join(skillsRoot, name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(dir);
    } catch {
      throw new FilesError("not_found", "That skill is missing");
    }
    if (info.isSymbolicLink()) throw new FilesError("not_allowed", "That path is a symlink");
    if (!info.isDirectory()) throw new FilesError("not_found", "That skill is missing");
    const real = realpathSync(dir);
    assertContained(root, real);
    if (path.relative(skillsRoot, real) !== name) {
      throw new FilesError("not_allowed", "That path is outside the skills folder");
    }
    const skillFile = path.join(real, "SKILL.md");
    let skillInfo: ReturnType<typeof lstatSync>;
    try {
      skillInfo = lstatSync(skillFile);
    } catch {
      throw new FilesError("not_found", "That skill is missing");
    }
    if (skillInfo.isSymbolicLink()) throw new FilesError("not_allowed", "That path is a symlink");
    if (!skillInfo.isFile()) throw new FilesError("not_found", "That skill is missing");
    assertContained(root, realpathSync(skillFile));
    rmSync(real, { recursive: true });
    touch(root);
  }

  function readAgents(): { body: string } {
    const root = projectRoot(options.folder());
    const target = path.join(root, "AGENTS.md");
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink()) throw new FilesError("not_allowed", "That path is a symlink");
      if (!info.isFile()) return { body: "" };
    } catch (error) {
      if (error instanceof FilesError) throw error;
      return { body: "" };
    }
    return { body: stripFinalNewline(readText(root, root, "AGENTS.md")) };
  }

  function writeAgents(body: string): { body: string } {
    if (body.length > MAX_BODY) throw new FilesError("io_error", "That file is too large to edit here");
    const root = projectRoot(options.folder());
    const contents = body.length === 0 ? "" : `${stripFinalNewline(body)}\n`;
    commitFile(root, root, "AGENTS.md", contents, touch);
    return readAgents();
  }

  return {
    listRules,
    readRule,
    writeRule,
    deleteRule,
    listSkills,
    readSkill,
    writeSkill,
    deleteSkill,
    readAgents,
    writeAgents,
    seenDirty,
    clearDirty,
  };
}

function projectRoot(folder: string | null): string {
  if (folder === null || folder.trim() === "") throw new FilesError("not_ready", "Choose a folder first");
  try {
    const root = realpathSync(folder);
    if (!statSync(root).isDirectory()) throw new FilesError("not_ready", "Choose a folder, not a file");
    return root;
  } catch (error) {
    if (error instanceof FilesError) throw error;
    throw new FilesError("not_ready", "That folder is missing");
  }
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new FilesError("not_allowed", "Use a lowercase name: letters, numbers, and hyphens");
}

function isName(name: string): boolean {
  return NAME.test(name);
}

function assertSize(description: string, globs: string, body: string): void {
  if (description.length > MAX_DESCRIPTION) throw new FilesError("io_error", "The description is too long");
  if (globs.length > MAX_GLOBS) throw new FilesError("io_error", "The globs value is too long");
  if (body.length > MAX_BODY) throw new FilesError("io_error", "That file is too large to edit here");
}

function assertContained(root: string, candidate: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new FilesError("not_allowed", "That path is outside the project folder");
  }
}

function existingDir(root: string, parts: readonly string[]): string | null {
  let current = root;
  for (const part of parts) {
    const next = path.join(current, part);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(next);
    } catch {
      return null;
    }
    if (info.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(next);
      } catch {
        throw new FilesError("not_allowed", "That path is a symlink");
      }
      assertContained(root, real);
      if (!statSync(real).isDirectory()) return null;
      current = real;
      continue;
    }
    if (!info.isDirectory()) return null;
    current = realpathSync(next);
    assertContained(root, current);
  }
  return current;
}

function ensureInside(root: string, parts: readonly string[]): string {
  let current = root;
  for (const part of parts) {
    if (part !== ".cursor" && part !== "rules" && part !== "skills" && !isName(part)) {
      throw new FilesError("not_allowed", "That path is outside the project folder");
    }
    const next = path.join(current, part);
    let info: ReturnType<typeof lstatSync> | null = null;
    try {
      info = lstatSync(next);
    } catch {
      info = null;
    }
    if (info === null) {
      try {
        mkdirSync(next, { mode: 0o755 });
      } catch (error) {
        throw new FilesError("io_error", ioMessage(error));
      }
    } else if (info.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(next);
      } catch {
        throw new FilesError("not_allowed", "That path is a symlink");
      }
      assertContained(root, real);
      if (!statSync(real).isDirectory()) throw new FilesError("conflict", "That name is not a folder");
      current = real;
      continue;
    } else if (!info.isDirectory()) {
      throw new FilesError("conflict", "That name is not a folder");
    }
    try {
      current = realpathSync(next);
    } catch (error) {
      throw new FilesError("io_error", ioMessage(error));
    }
    assertContained(root, current);
  }
  return current;
}

function skillDir(root: string, name: string): string {
  const skillsRoot = existingDir(root, [".cursor", "skills"]);
  if (skillsRoot === null) throw new FilesError("not_found", "That skill is missing");
  const dir = path.join(skillsRoot, name);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(dir);
  } catch {
    throw new FilesError("not_found", "That skill is missing");
  }
  if (info.isSymbolicLink()) throw new FilesError("not_allowed", "That path is a symlink");
  if (!info.isDirectory()) throw new FilesError("not_found", "That skill is missing");
  const real = realpathSync(dir);
  assertContained(root, real);
  if (path.relative(skillsRoot, real) !== name) {
    throw new FilesError("not_allowed", "That path is outside the skills folder");
  }
  return real;
}

function listFiles(dir: string, extension: string): string[] {
  const names: string[] = [];
  for (const entry of readDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    const name = entry.name.slice(0, -extension.length);
    if (isName(name)) names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

function listDirs(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readDir(dir)) {
    if (entry.isDirectory() && isName(entry.name)) names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

function readDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new FilesError("io_error", ioMessage(error));
  }
}

function readText(root: string, dir: string, filename: string): string {
  const target = checkedFile(root, dir, filename, "That file is missing");
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch (error) {
    throw new FilesError("io_error", ioMessage(error));
  }
  if (text.length > MAX_BODY) throw new FilesError("io_error", "That file is too large to edit here");
  return text;
}

function removeFile(root: string, dir: string, filename: string, missing: string): void {
  const target = checkedFile(root, dir, filename, missing);
  try {
    rmSync(target);
  } catch (error) {
    throw new FilesError("io_error", ioMessage(error));
  }
}

function checkedFile(root: string, dir: string, filename: string, missing: string): string {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    throw new FilesError("not_allowed", "That name is not allowed");
  }
  const target = path.join(dir, filename);
  assertContained(root, target);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(target);
  } catch {
    throw new FilesError("not_found", missing);
  }
  if (info.isSymbolicLink()) throw new FilesError("not_allowed", "That path is a symlink");
  if (!info.isFile()) throw new FilesError("not_found", missing);
  assertContained(root, realpathSync(target));
  return target;
}

function commitFile(root: string, dir: string, filename: string, contents: string, touch: (root: string) => void): void {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    throw new FilesError("not_allowed", "That name is not allowed");
  }
  const target = path.join(dir, filename);
  assertContained(root, target);
  let existing: string | null = null;
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new FilesError("not_allowed", "That path is a symlink");
    if (!info.isFile()) throw new FilesError("conflict", "That name is not a file");
    assertContained(root, realpathSync(target));
    existing = readFileSync(target, "utf8");
  } catch (error) {
    if (error instanceof FilesError) throw error;
    existing = null;
  }
  if (existing === contents) return;
  const tmp = path.join(dir, `.${filename}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o644 });
    renameSync(tmp, target);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The next save uses a new temp name. This leftover is not a rule or a skill file.
    }
    throw new FilesError("io_error", ioMessage(error));
  }
  touch(root);
}

function parseRule(name: string, text: string): Rule {
  const split = splitFrontmatter(text);
  return {
    name,
    description: clip(split.fields.description ?? "", MAX_DESCRIPTION),
    alwaysApply: (split.fields.alwaysApply ?? "").toLowerCase() === "true",
    globs: clip(split.fields.globs ?? "", MAX_GLOBS),
    body: stripFinalNewline(split.body),
  };
}

function parseSkill(name: string, text: string): Skill {
  const split = splitFrontmatter(text);
  return {
    name,
    description: clip(split.fields.description ?? "", MAX_DESCRIPTION),
    body: stripFinalNewline(split.body),
  };
}

function renderRule(rule: Rule): string {
  const lines = ["---", `description: ${yamlString(rule.description)}`];
  if (rule.globs !== "") lines.push(`globs: ${yamlString(rule.globs)}`);
  lines.push(`alwaysApply: ${rule.alwaysApply ? "true" : "false"}`, "---", "");
  return `${lines.join("\n")}${stripFinalNewline(rule.body)}\n`;
}

function renderSkill(skill: Skill): string {
  const lines = ["---", `name: ${skill.name}`, `description: ${yamlString(skill.description)}`, "---", ""];
  return `${lines.join("\n")}${stripFinalNewline(skill.body)}\n`;
}

function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { fields: {}, body: normalized };
  const close = normalized.indexOf("\n---", 3);
  if (close === -1) return { fields: {}, body: normalized };
  const raw = normalized.slice(normalized.indexOf("\n") + 1, close);
  let rest = normalized.slice(close + 4);
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n")) rest = rest.slice(1);
  return { fields: parseFields(raw), body: rest };
}

function parseFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && current !== null) {
      const piece = unquote(item[1] ?? "");
      const previous = fields[current] ?? "";
      fields[current] = previous === "" ? piece : `${previous}, ${piece}`;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      current = null;
      continue;
    }
    current = match[1] ?? null;
    if (current === null) continue;
    fields[current] = unquote((match[2] ?? "").trim());
  }
  return fields;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function yamlString(value: string): string {
  if (value === "") return "\"\"";
  if (/^(true|false|null|yes|no|~)$/i.test(value)) return JSON.stringify(value);
  if (/[\n:#]|^\s|\s$|[{}[\],&*!|>%@`]/.test(value)) return JSON.stringify(value);
  return value;
}

function stripFinalNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function ioMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return `Could not update that file (${error.code})`;
  }
  return "Could not update that file";
}
