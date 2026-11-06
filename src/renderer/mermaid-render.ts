// Draws one mermaid diagram to an SVG string. The library is loaded on the first call.
import type MermaidApi from "mermaid";
import { mermaidConfig } from "./mermaid-config.js";

type Mermaid = typeof MermaidApi;

const CACHE_LIMIT = 50;
const cache = new Map<string, string>();
let loading: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function load(): Promise<Mermaid> {
  loading ??= import("mermaid")
    .then((module) => module.default)
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

/** Draws are queued one at a time, because mermaid keeps global state while it renders. */
export function renderDiagram(code: string, dark: boolean): Promise<string> {
  const key = `${dark ? "dark" : "light"}:${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const job = queue.then(async () => {
    const mermaid = await load();
    mermaid.initialize(mermaidConfig(dark));
    // parse throws on bad input and, unlike render, leaves nothing in the page.
    await mermaid.parse(code);
    counter += 1;
    const id = `mermaid-${counter}`;
    try {
      const { svg } = await mermaid.render(id, code);
      cache.set(key, svg);
      if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return svg;
    } catch (error) {
      document.getElementById(`d${id}`)?.remove();
      throw error;
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
