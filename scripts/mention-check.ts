// Checks @repo parsing. No network and no Electron.
//   node --experimental-strip-types scripts/mention-check.ts
import assert from "node:assert/strict";
import test from "node:test";
import { filterRepoNames, mentionQuery, parseMention } from "../src/shared/mention.ts";

const repos = ["api", "web"];

test("an exact mention is removed and the rest is the prompt", () => {
  assert.deepEqual(parseMention("@api add a ping route", repos), {
    ok: true,
    repo: "api",
    text: "add a ping route",
  });
});

test("a mention in the middle of a sentence matches", () => {
  assert.deepEqual(parseMention("please @web check the logs", repos), {
    ok: true,
    repo: "web",
    text: "please check the logs",
  });
});

test("no mention, a prefix, and the wrong case do not match", () => {
  assert.deepEqual(parseMention("hello", repos), { ok: false, reason: "none" });
  assert.deepEqual(parseMention("@ap hello", repos), { ok: false, reason: "none" });
  assert.deepEqual(parseMention("@API hello", repos), { ok: false, reason: "none" });
});

test("two different repos are refused", () => {
  assert.deepEqual(parseMention("@api and @web", repos), { ok: false, reason: "many" });
});

test("the same repo named twice is one target", () => {
  const parsed = parseMention("@api then @api again", repos);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.repo, "api");
  assert.equal(parsed.text, "then @api again");
});

test("an email address is not a mention", () => {
  assert.deepEqual(parseMention("mail user@api.com", repos), { ok: false, reason: "none" });
  assert.equal(mentionQuery("mail user@api.com", "mail user@api.com".length), null);
});

test("the open query follows the caret", () => {
  const text = "see @ap";
  assert.deepEqual(mentionQuery(text, text.length), { start: 4, query: "ap" });
  assert.equal(mentionQuery("@api ", 5), null);
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
});

test("the popup filters by prefix and hides the root repo name", () => {
  assert.deepEqual(filterRepoNames(["api", "web", "."], "a"), ["api"]);
  assert.deepEqual(filterRepoNames(["api", "web"], ""), ["api", "web"]);
});

test("a name with a space is not a mention and is not listed as a match", () => {
  assert.deepEqual(parseMention("@my repo", ["my repo", "api"]), { ok: false, reason: "none" });
  assert.deepEqual(filterRepoNames(["my repo", "api"], "my"), []);
});

test("an indented multi-line body keeps its indentation", () => {
  const body = "fix this:\n    if (x) {\n\treturn;\n    }";
  assert.deepEqual(parseMention(`@api ${body}`, repos), {
    ok: true,
    repo: "api",
    text: body,
  });
});
