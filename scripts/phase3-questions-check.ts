// Checks question parsing and answer validation. No network and no Electron.
import assert from "node:assert/strict";
import { answerJson, checkAnswers, parseToolQuestion, skipJson, type Question } from "../src/shared/questions.ts";

const questions: Question[] = [
  {
    id: "stack",
    prompt: "Which stack?",
    options: [
      { id: "react", label: "React" },
      { id: "vue", label: "Vue" },
    ],
  },
  {
    id: "extras",
    prompt: "Anything else?",
    allow_multiple: true,
    options: [
      { id: "tests", label: "Tests" },
      { id: "docs", label: "Docs" },
    ],
  },
];

const parsed = parseToolQuestion({
  title: "Pick one",
  questions,
});
assert.equal(parsed.ok, true);
if (!parsed.ok) throw new Error("parse failed");
assert.equal(parsed.value.title, "Pick one");
assert.equal(parsed.value.questions.length, 2);

assert.equal(parseToolQuestion({ questions: [] }).ok, false);
assert.equal(parseToolQuestion({ questions: [{ id: "a", prompt: "A", options: [] }] }).ok, false);
assert.equal(
  parseToolQuestion({
    questions: [
      { id: "same", prompt: "A", options: [{ id: "one", label: "One" }] },
      { id: "same", prompt: "B", options: [{ id: "two", label: "Two" }] },
    ],
  }).ok,
  false,
);

const chosen = checkAnswers(questions, {
  stack: { selected: ["react"] },
  extras: { selected: ["tests", "docs"], other: "  notes  " },
});
assert.equal(chosen.ok, true);
if (!chosen.ok) throw new Error("answers failed");
assert.deepEqual(JSON.parse(answerJson(chosen.value)), {
  stack: { selected: ["react"] },
  extras: { selected: ["tests", "docs"], other: "notes" },
});

const otherOnly = checkAnswers(questions, {
  stack: { selected: [], other: "Svelte" },
  extras: { selected: ["tests"] },
});
assert.equal(otherOnly.ok, true);
if (!otherOnly.ok) throw new Error("other failed");
assert.deepEqual(otherOnly.value.stack, { selected: [], other: "Svelte" });

assert.equal(checkAnswers(questions, { stack: { selected: ["react", "vue"] }, extras: { selected: ["tests"] } }).ok, false);
assert.equal(checkAnswers(questions, { stack: { selected: ["nope"] }, extras: { selected: ["tests"] } }).ok, false);
assert.equal(checkAnswers(questions, { stack: { selected: [] }, extras: { selected: [] } }).ok, false);
assert.equal(checkAnswers(questions, { stack: { selected: ["react"] } }).ok, false);
assert.equal(skipJson(), '{"skipped":true}');

console.log("phase3 question checks passed");
