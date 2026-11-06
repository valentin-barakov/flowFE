// Which fruit a chat keeps, and that two chats one above the other never share one.
//   node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/fruits-check.ts
import assert from "node:assert/strict";
import test from "node:test";
import { assignChatFruits, parseFruitMemory, type ChatFruit } from "../src/renderer/fruits.ts";

function neighborsDiffer(fruits: readonly ChatFruit[]): void {
  for (let i = 1; i < fruits.length; i += 1) assert.notEqual(fruits[i], fruits[i - 1]);
}

test("a single chat stays the mango", () => {
  const first = assignChatFruits(["only"]);
  assert.deepEqual(first.fruits, ["mango"]);
  const again = assignChatFruits(["only"], first.memory);
  assert.deepEqual(again.fruits, ["mango"]);
});

test("a second chat gets a different fruit and the first keeps the mango", () => {
  const one = assignChatFruits(["only"]);
  const two = assignChatFruits(["only", "other"], one.memory);
  assert.equal(two.fruits[0], "mango");
  assert.notEqual(two.fruits[1], "mango");
  const kept = assignChatFruits(["only", "other"], two.memory);
  assert.deepEqual(kept.fruits, two.fruits);
});

test("the first chats in a list each get a different fruit", () => {
  const names = ["api", "docs", "web", "worker"];
  const { fruits, memory } = assignChatFruits(names);
  assert.equal(new Set(fruits).size, 4);
  neighborsDiffer(fruits);
  assert.deepEqual(assignChatFruits(names, memory).fruits, fruits);
});

test("a longer list never puts the same fruit on two neighboring chats", () => {
  const names = Array.from({ length: 8 }, (_, index) => `repo-${index}`);
  const { fruits } = assignChatFruits(names);
  neighborsDiffer(fruits);
  assert.equal(new Set(fruits).size, 4);
});

test("adding a chat above keeps the fruits that do not collide", () => {
  const first = assignChatFruits(["b", "c"]);
  const added = assignChatFruits(["a", "b", "c"], { ...first.memory, a: first.fruits[0]! });
  neighborsDiffer(added.fruits);
  assert.equal(added.fruits[0], first.fruits[0]);
  assert.notEqual(added.fruits[1], first.fruits[0]);
  if (added.fruits[1] !== first.fruits[1]) assert.equal(added.fruits[2], first.fruits[1]);
});

test("a remembered fruit that matches the chat above is replaced", () => {
  const { fruits } = assignChatFruits(["top", "next"], { top: "blueberry", next: "blueberry" });
  assert.equal(fruits[0], "blueberry");
  assert.notEqual(fruits[1], "blueberry");
});

test("stored junk is ignored", () => {
  assert.deepEqual(parseFruitMemory({ api: "mango", web: "kiwi", n: 1, ok: "orange" }), {
    api: "mango",
    ok: "orange",
  });
  assert.deepEqual(parseFruitMemory(null), {});
  assert.deepEqual(parseFruitMemory(["mango"]), {});
});
