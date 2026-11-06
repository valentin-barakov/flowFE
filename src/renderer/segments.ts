// Rebuilds the order of one run for display: text, tool calls, text, and so on.
// Pure. It reads the items the reducer holds and never changes them.
import type { Item } from "./state.js";

export type UserItem = Extract<Item, { role: "user" }>;
export type AgentItem = Extract<Item, { role: "agent" }>;
export type ToolItem = Extract<Item, { role: "tool" }>;
export type QuestionItem = Extract<Item, { role: "question" }>;

export type Block =
  | { kind: "user"; key: string; item: UserItem }
  | { kind: "question"; key: string; item: QuestionItem }
  | { kind: "plan"; key: string; item: ToolItem; plan: string }
  | { kind: "tools"; key: string; tools: ToolItem[]; agentId: string | null }
  | { kind: "text"; key: string; agent: AgentItem; text: string; header: boolean; last: boolean };

type Part = ToolItem | QuestionItem;

/**
 * Tool calls and questions are stored just before the agent message of their run, in the order they
 * happened. Each one knows how much agent text existed when it appeared (`offset`). An item without
 * an offset (an old chat) uses the offset of the item before it, or 0 for the first one, so all the
 * text comes after it. Plans and questions are cards placed at their offset, under the text before them.
 */
export function buildBlocks(items: readonly Item[]): Block[] {
  const blocks: Block[] = [];
  let parts: Part[] = [];
  for (const item of items) {
    if (item.role === "tool" || item.role === "question") {
      parts.push(item);
      continue;
    }
    if (item.role === "agent") {
      expandRun(blocks, parts, item);
      parts = [];
      continue;
    }
    expandRun(blocks, parts, null);
    parts = [];
    blocks.push({ kind: "user", key: item.id, item });
  }
  expandRun(blocks, parts, null);
  return blocks;
}

/** A stored tool summary from before this change can be a JSON dump. Show nothing for it. */
export function cleanSummary(summary: string): string {
  const text = summary.trim();
  return text.startsWith("{") || text.startsWith("[") ? "" : text;
}

const FILE_TOOLS = new Set(["read", "edit", "write", "delete"]);

/** Read and edit rows show the file name. The full path stays available as the title. */
export function displayDetail(name: string, summary: string): string {
  const text = cleanSummary(summary);
  if (text === "" || !FILE_TOOLS.has(name.toLowerCase())) return text;
  const slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return slash === -1 ? text : text.slice(slash + 1);
}

const TOOL_PHASE = {
  running: { phase: "running", label: "running" },
  ok: { phase: "finished", label: "done" },
  error: { phase: "failed", label: "failed" },
} as const;

/**
 * How a tool row is drawn. A call still stored as `running` is shown as stopped once its run is
 * not live. The stored status is left unchanged.
 */
export function toolPhase(
  status: ToolItem["status"],
  live: boolean,
): { phase: "running" | "finished" | "failed" | "stopped"; label: "running" | "done" | "failed" | "stopped" } {
  if (status === "running" && !live) return { phase: "stopped", label: "stopped" };
  return TOOL_PHASE[status];
}

function expandRun(blocks: Block[], parts: readonly Part[], agent: AgentItem | null): void {
  const text = agent === null ? "" : agent.text;
  const agentId = agent === null ? null : agent.id;
  let cut = 0;
  let offset = 0;
  let wroteText = false;
  for (const part of parts) {
    if (part.offset !== undefined) offset = part.offset;
    const at = Math.min(Math.max(offset, cut), text.length);
    if (agent !== null && at > cut) {
      const piece = text.slice(cut, at).trim();
      if (piece !== "") {
        blocks.push({ kind: "text", key: `${agent.id}:${cut}`, agent, text: piece, header: !wroteText, last: false });
        wroteText = true;
      }
      cut = at;
    }
    pushPart(blocks, part, agentId);
  }
  if (agent !== null) {
    blocks.push({ kind: "text", key: `${agent.id}:${cut}`, agent, text: text.slice(cut).trim(), header: !wroteText, last: true });
  }
}

function pushPart(blocks: Block[], part: Part, agentId: string | null): void {
  if (part.role === "question") {
    blocks.push({ kind: "question", key: part.questionId, item: part });
    return;
  }
  if (part.status === "ok" && part.plan !== undefined && part.plan !== "") {
    blocks.push({ kind: "plan", key: part.id, item: part, plan: part.plan });
    return;
  }
  const previous = blocks[blocks.length - 1];
  if (previous !== undefined && previous.kind === "tools" && previous.agentId === agentId) {
    previous.tools.push(part);
    return;
  }
  blocks.push({ kind: "tools", key: `tools:${part.id}`, tools: [part], agentId });
}
