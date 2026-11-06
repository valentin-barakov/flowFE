// Checks how one run's text and tool calls are put in order. No network, no Electron, no React.
//   node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/segments-check.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildBlocks, cleanSummary, toolPhase, type Block } from "../src/renderer/segments.ts";
import type { Item } from "../src/renderer/state.ts";

const at = "2026-11-06T00:00:00.000Z";

function user(id: string): Item {
  return { id, role: "user", text: "go", at };
}

function agent(id: string, text: string, status: "done" | "stopped" | "interrupted" | "error" = "done"): Item {
  return { id, role: "agent", text, at, status };
}

function tool(id: string, offset?: number, extra: { plan?: string } = {}): Item {
  return {
    id,
    role: "tool",
    name: "read",
    summary: "a.ts",
    status: "ok",
    at,
    ...(offset === undefined ? {} : { offset }),
    ...(extra.plan === undefined ? {} : { plan: extra.plan }),
  };
}

function question(id: string, offset?: number): Item {
  return {
    id,
    role: "question",
    questionId: id,
    questions: [],
    answers: null,
    skipped: false,
    cancelled: false,
    open: true,
    at,
    ...(offset === undefined ? {} : { offset }),
  };
}

function shape(blocks: Block[]): string[] {
  return blocks.map((block) => {
    if (block.kind === "text") return `text:${block.text}${block.header ? ":h" : ""}${block.last ? ":l" : ""}`;
    if (block.kind === "tools") return `tools:${block.tools.map((item) => item.id).join(",")}`;
    if (block.kind === "plan") return `plan:${block.item.id}`;
    return `${block.kind}:${block.key}`;
  });
}

test("text is cut at the offset of a tool call", () => {
  const items = [user("u1"), tool("t1", 13), agent("a1", "Before tools. After tools.")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "text:Before tools.:h", "tools:t1", "text:After tools.:l"]);
});

test("tools without an offset (an old chat) come first, then all the text", () => {
  const items = [user("u1"), tool("t1"), tool("t2"), agent("a1", "Hi")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "tools:t1,t2", "text:Hi:h:l"]);
});

test("neighbouring calls form one group and text splits groups", () => {
  const items = [user("u1"), tool("t1", 0), tool("t2", 0), tool("t3", 5), agent("a1", "HelloWorld")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "tools:t1,t2", "text:Hello:h", "tools:t3", "text:World:l"]);
});

test("a question card sits under the text written before it", () => {
  const items = [user("u1"), question("q1", 4), agent("a1", "AAAABBBB")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "text:AAAA:h", "question:q1", "text:BBBB:l"]);
});

test("a question with no offset (an old chat) uses the offset of the item before it", () => {
  const items = [user("u1"), tool("t1", 4), question("q1"), agent("a1", "AAAABBBB")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "text:AAAA:h", "tools:t1", "question:q1", "text:BBBB:l"]);
});

test("a plan card sits under the text before it and the text after it follows", () => {
  const items = [user("u1"), tool("t1", 11, { plan: "# P" }), agent("a1", "Here it is.Anything else?")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "text:Here it is.:h", "plan:t1", "text:Anything else?:l"]);
});

test("a question and then a tool call keep their order and offsets", () => {
  const items = [user("u1"), question("q1", 3), tool("t1", 6), agent("a1", "OneTwoThree")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "text:One:h", "question:q1", "text:Two", "tools:t1", "text:Three:l"]);
});

test("a run with only tools keeps an empty last text block for the working note", () => {
  const items = [user("u1"), tool("t1", 0), agent("a1", "")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "tools:t1", "text::h:l"]);
});

test("an offset past the end of the text is clamped", () => {
  const items = [user("u1"), tool("t1", 99), agent("a1", "Hi")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "text:Hi:h", "tools:t1", "text::l"]);
});

test("a finished plan is its own block and the next call starts a new group", () => {
  const items = [user("u1"), tool("t1", 0, { plan: "# P" }), tool("t2", 0), agent("a1", "")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "plan:t1", "tools:t2", "text::h:l"]);
});

test("calls with no agent message before the next user message are still shown", () => {
  const items = [user("u1"), tool("t1", 0), user("u2")];
  assert.deepEqual(shape(buildBlocks(items)), ["user:u1", "tools:t1", "user:u2"]);
});

test("the same input gives the same keys, so React keeps the segments mounted", () => {
  const first = buildBlocks([user("u1"), agent("a1", "Hello")]);
  const second = buildBlocks([user("u1"), agent("a1", "Hello world")]);
  assert.deepEqual(first.map((block) => block.key), second.map((block) => block.key));
});

test("a JSON summary from an old chat is hidden", () => {
  assert.equal(cleanSummary('{"status":"success"}'), "");
  assert.equal(cleanSummary("[1,2]"), "");
  assert.equal(cleanSummary("  src/a.ts "), "src/a.ts");
});

test("a tool still stored as running is shown as stopped when the run is not live", () => {
  assert.deepEqual(toolPhase("running", false), { phase: "stopped", label: "stopped" });
  assert.deepEqual(toolPhase("running", true), { phase: "running", label: "running" });
  assert.deepEqual(toolPhase("ok", false), { phase: "finished", label: "done" });
  assert.deepEqual(toolPhase("error", true), { phase: "failed", label: "failed" });
});
