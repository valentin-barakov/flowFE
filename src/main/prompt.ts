// The text Mango sends to the agent. The stored user message stays the user's own words.
import type { Message } from "../shared/ipc.js";

export const PROJECT_WINS =
  "When a user-level instruction and a project instruction conflict, follow the project one.";

export const ASK_USER =
  "When a decision needs the user, call the ask_user_question tool and wait for its result. Do not ask them to type the choice in the chat.";

const SEED_LIMIT = 20;
const SEED_CLIP = 8_000;

export type SeedMessage = { role: "user" | "agent"; text: string };

export function selectSeed(messages: readonly Message[]): SeedMessage[] {
  const text: SeedMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "agent") continue;
    if (message.text.trim() === "") continue;
    text.push({ role: message.role, text: message.text });
  }
  return text.slice(-SEED_LIMIT);
}

export function buildPrompt(userText: string, seed: readonly SeedMessage[] | null): string {
  const parts = [PROJECT_WINS, ASK_USER];
  if (seed !== null && seed.length > 0) {
    parts.push("Earlier conversation, text only. Continue from it.");
    for (const message of seed) {
      const who = message.role === "user" ? "User" : "Agent";
      parts.push(`${who}: ${clip(message.text, SEED_CLIP)}`);
    }
  }
  parts.push(userText);
  return parts.join("\n\n");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
