import type { Subagent } from "./ipc.js";

/** The SDK names a subagent launch `task`. `Task` is accepted too. */
export function isTask(name: string): boolean {
  return name.toLowerCase().replaceAll("_", "").replaceAll("-", "") === "task";
}

/**
 * A later event fills in whatever it carries and keeps the rest.
 * An empty string does not wipe a value already shown.
 */
export function mergeSubagent(current: Subagent | undefined, next: Subagent | undefined): Subagent | undefined {
  if (next === undefined) return current;
  const description = filled(next.description) ?? current?.description;
  const model = filled(next.model) ?? current?.model;
  const activity = filled(next.activity) ?? current?.activity;
  if (description === undefined && model === undefined && activity === undefined) return undefined;
  return {
    ...(description !== undefined ? { description } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(activity !== undefined ? { activity } : {}),
  };
}

function filled(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}
