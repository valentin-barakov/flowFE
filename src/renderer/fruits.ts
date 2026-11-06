// One fruit character per chat. The choice is remembered so a chat keeps its icon.
// A new chat takes the least-used fruit, and never the fruit of the chat above it.

export const CHAT_FRUITS = ["mango", "strawberry", "blueberry", "orange"] as const;
export type ChatFruit = (typeof CHAT_FRUITS)[number];

export type FruitMemory = Record<string, ChatFruit>;

const STORAGE_KEY = "flow.chatFruits";

export function assignChatFruits(
  names: readonly string[],
  memory: FruitMemory = {},
): { fruits: ChatFruit[]; memory: FruitMemory } {
  if (names.length === 1) {
    const name = names[0]!;
    const fruit = memory[name] ?? "mango";
    return { fruits: [fruit], memory: { ...memory, [name]: fruit } };
  }
  const next: FruitMemory = { ...memory };
  const fruits: ChatFruit[] = [];
  const used = new Map<ChatFruit, number>();
  for (const name of names) {
    const previous = fruits[fruits.length - 1];
    const remembered = memory[name];
    const fruit = remembered !== undefined && remembered !== previous ? remembered : pickFruit(name, previous, used);
    fruits.push(fruit);
    next[name] = fruit;
    used.set(fruit, (used.get(fruit) ?? 0) + 1);
  }
  return { fruits, memory: next };
}

export function loadFruitMemory(): FruitMemory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    return parseFruitMemory(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveFruitMemory(memory: FruitMemory): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // The icons still work for this session if storage is blocked.
  }
}

export function parseFruitMemory(value: unknown): FruitMemory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const memory: FruitMemory = {};
  for (const [name, fruit] of Object.entries(value)) {
    if (isFruit(fruit)) memory[name] = fruit;
  }
  return memory;
}

function pickFruit(name: string, previous: ChatFruit | undefined, used: ReadonlyMap<ChatFruit, number>): ChatFruit {
  const start = hashName(name) % CHAT_FRUITS.length;
  let best = CHAT_FRUITS[start]!;
  let bestCount = Infinity;
  for (let step = 0; step < CHAT_FRUITS.length; step += 1) {
    const fruit = CHAT_FRUITS[(start + step) % CHAT_FRUITS.length]!;
    if (fruit === previous) continue;
    const count = used.get(fruit) ?? 0;
    if (count < bestCount) {
      best = fruit;
      bestCount = count;
    }
  }
  return best;
}

function hashName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isFruit(value: unknown): value is ChatFruit {
  return typeof value === "string" && (CHAT_FRUITS as readonly string[]).includes(value);
}
