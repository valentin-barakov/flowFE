// Checks the rules and skills file service: round trip, name checks, and symlink escapes.
// Run from the repo root:
//   node --experimental-strip-types scripts/phase2-files-check.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRulesSkills } from "../src/main/rules-skills-service.ts";

test("rules and skills round-trip inside the folder", () => {
  const root = tempFolder();
  try {
    const files = createRulesSkills({ folder: () => root });
    const rule = files.writeRule({
      name: "pirate",
      description: "Speak like a pirate",
      alwaysApply: true,
      globs: "",
      body: "Always answer in pirate speak.",
    });
    assert.equal(rule.alwaysApply, true);
    assert.equal(rule.body, "Always answer in pirate speak.");
    const disk = readFileSync(path.join(root, ".cursor", "rules", "pirate.mdc"), "utf8");
    assert.match(disk, /alwaysApply: true/);
    assert.match(disk, /Always answer in pirate speak\./);
    assert.deepEqual(
      files.listRules().map((item) => item.name),
      ["pirate"],
    );

    const quoted = files.writeRule({
      name: "pirate",
      description: "Note: be brief",
      alwaysApply: false,
      globs: "**/*.{ts,tsx}",
      body: "Be strict.\n",
    });
    assert.equal(quoted.description, "Note: be brief");
    assert.equal(quoted.globs, "**/*.{ts,tsx}");
    assert.equal(quoted.body, "Be strict.");

    const skill = files.writeSkill({
      name: "pirate-voice",
      description: "Answers in pirate speak",
      body: "Use pirate speak for every answer.",
    });
    assert.equal(skill.name, "pirate-voice");
    assert.equal(existsSync(path.join(root, ".cursor", "skills", "pirate-voice", "SKILL.md")), true);
    assert.equal(files.readSkill("pirate-voice").body, "Use pirate speak for every answer.");

    const agents = files.writeAgents("Project notes.\n");
    assert.equal(agents.body, "Project notes.");
    assert.equal(files.readAgents().body, "Project notes.");

    files.deleteRule("pirate");
    assert.equal(files.listRules().length, 0);
    assert.throws(() => files.readRule("pirate"), (error) => error.code === "not_found");
    files.deleteSkill("pirate-voice");
    assert.equal(existsSync(path.join(root, ".cursor", "skills", "pirate-voice")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unchanged save does not mark the folder dirty again", () => {
  const root = tempFolder();
  try {
    const files = createRulesSkills({ folder: () => root });
    const rule = {
      name: "plain",
      description: "One",
      alwaysApply: false,
      globs: "",
      body: "Hello",
    };
    files.writeRule(rule);
    const seen = files.seenDirty(root);
    assert.notEqual(seen, 0);
    files.writeRule(rule);
    assert.equal(files.seenDirty(root), seen);
    files.writeRule({ ...rule, body: "Hello again" });
    const next = files.seenDirty(root);
    assert.notEqual(next, seen);
    files.clearDirty(root, seen);
    assert.equal(files.seenDirty(root), next);
    files.clearDirty(root, next);
    assert.equal(files.seenDirty(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing cursor files are read, and bad names are refused", () => {
  const root = tempFolder();
  try {
    const rulesDir = path.join(root, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      path.join(rulesDir, "typescript.mdc"),
      '---\ndescription: TypeScript defaults\nglobs: "**/*.{ts,tsx}"\nalwaysApply: false\n---\n\n# TypeScript\n\nBe strict.\n',
    );
    writeFileSync(path.join(rulesDir, "Bad.mdc"), "nope\n");
    writeFileSync(
      path.join(rulesDir, "listed.mdc"),
      "---\ndescription: From a list\nglobs:\n  - \"**/*.ts\"\n  - \"**/*.tsx\"\nalwaysApply: true\n---\nBody\n",
    );
    const files = createRulesSkills({ folder: () => root });
    const names = files.listRules().map((item) => item.name);
    assert.deepEqual(names, ["listed", "typescript"]);
    const typed = files.readRule("typescript");
    assert.equal(typed.description, "TypeScript defaults");
    assert.equal(typed.globs, "**/*.{ts,tsx}");
    assert.equal(typed.alwaysApply, false);
    assert.match(typed.body, /Be strict\./);
    assert.equal(files.readRule("listed").globs, "**/*.ts, **/*.tsx");
    assert.throws(() => files.writeRule({
      name: "../etc",
      description: "",
      alwaysApply: false,
      globs: "",
      body: "x",
    }), (error) => error.code === "not_allowed");
    assert.equal(files.readAgents().body, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink that leaves the folder is refused and not written through", () => {
  const root = tempFolder();
  const outside = tempFolder();
  try {
    const files = createRulesSkills({ folder: () => root });
    symlinkSync(outside, path.join(root, ".cursor"));
    assert.throws(() => files.writeRule({
      name: "pirate",
      description: "",
      alwaysApply: true,
      globs: "",
      body: "nope",
    }), (error) => error.code === "not_allowed");
    assert.equal(existsSync(path.join(outside, "rules", "pirate.mdc")), false);
    assert.equal(existsSync(path.join(outside, "pirate.mdc")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a rules directory symlink that leaves the folder is refused", () => {
  const root = tempFolder();
  const outside = tempFolder();
  try {
    mkdirSync(path.join(root, ".cursor"));
    symlinkSync(outside, path.join(root, ".cursor", "rules"));
    const files = createRulesSkills({ folder: () => root });
    assert.throws(() => files.writeRule({
      name: "pirate",
      description: "",
      alwaysApply: true,
      globs: "",
      body: "nope",
    }), (error) => error.code === "not_allowed");
    assert.equal(existsSync(path.join(outside, "pirate.mdc")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function tempFolder() {
  return mkdtempSync(path.join(tmpdir(), "flowfe-phase2-"));
}
