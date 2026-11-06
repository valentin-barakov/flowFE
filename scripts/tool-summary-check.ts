// Checks the one-line tool summary, and that a question tool emits no tool event.
// No network and no Electron. emitMessage is called directly and does not start an agent.
//   node --disable-warning=ExperimentalWarning --experimental-strip-types --import ./scripts/repos-check-resolve.mjs scripts/tool-summary-check.ts
import assert from "node:assert/strict";
import test from "node:test";
import { emitMessage, type AgentStreamEvent } from "../src/main/agent-service.ts";
import { toolDetail } from "../src/main/tool-summary.ts";

const cwd = "/w/repo";

test("a path inside the repo is shown relative to it", () => {
  assert.equal(toolDetail({ path: "/w/repo/src/a.ts" }, cwd), "src/a.ts");
  assert.equal(toolDetail({ path: "/w/repo" }, cwd), ".");
});

test("a path outside the repo stays absolute", () => {
  assert.equal(toolDetail({ path: "/etc/hosts" }, cwd), "/etc/hosts");
});

test("a shell command is one line", () => {
  assert.equal(toolDetail({ command: "npm run typecheck\n" }, cwd), "npm run typecheck");
  assert.equal(toolDetail({ command: "echo   a\n  b" }, cwd), "echo a b");
});

test("a search shows the pattern, not the folder", () => {
  assert.equal(toolDetail({ pattern: "foo", path: "/w/repo" }, cwd), "foo");
  assert.equal(toolDetail({ globPattern: "**/*.ts", targetDirectory: "/w/repo" }, cwd), "**/*.ts");
});

test("several paths show the first and a count", () => {
  assert.equal(toolDetail({ paths: ["/w/repo/a.ts", "/w/repo/b.ts", "/w/repo/c.ts"] }, cwd), "a.ts +2");
});

test("unknown arguments and a result-shaped object give an empty detail", () => {
  assert.equal(toolDetail({ status: "success", value: { linesAdded: 6 } }, cwd), "");
  assert.equal(toolDetail(undefined, cwd), "");
  assert.equal(toolDetail(null, cwd), "");
  assert.equal(toolDetail(42, cwd), "");
});

function eventsFor(name: string, args: unknown): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  emitMessage(
    { type: "tool_call", agent_id: "agent", run_id: "run", call_id: "call", name, status: "running", args },
    "",
    cwd,
    (_next, event) => {
      if (event) events.push(event);
    },
  );
  return events;
}

test("a question tool emits no tool event", () => {
  assert.deepEqual(eventsFor("ask_user_question", {}), []);
  assert.deepEqual(eventsFor("read", { toolName: "ask_user_question" }), []);
});

test("a wrapped read or edit call shows the file path", () => {
  assert.equal(toolDetail({ args: { path: "/w/repo/src/a.ts" } }, cwd, "read"), "src/a.ts");
  assert.equal(toolDetail({ type: "edit", args: { path: "/w/repo/src/Chat.tsx" } }, cwd, "edit"), "src/Chat.tsx");
  assert.equal(toolDetail({ fileName: "notes.md" }, cwd, "read"), "notes.md");
});

test("an mcp call shows the server and the tool", () => {
  assert.equal(
    toolDetail({ providerIdentifier: "github", toolName: "list_issues", args: { query: "bug" } }, cwd, "mcp"),
    "github list_issues",
  );
  assert.equal(toolDetail({ serverIdentifier: "user-Figma", toolName: "get_screenshot" }, cwd, "mcp"), "user-Figma get_screenshot");
  assert.equal(toolDetail({ toolName: "search" }, cwd, "mcp"), "search");
  assert.equal(toolDetail({ name: "linear", toolName: "list_issues" }, cwd, "mcp"), "linear list_issues");
});

test("a long command is cut at 160 characters", () => {
  const detail = toolDetail({ command: "x".repeat(500) }, cwd);
  assert.equal(detail.length, 160);
  assert.equal(detail.endsWith("…"), true);
});
