// Options for react-markdown. The window and scripts/plan-check.ts share them.
// GFM gives tables, strikethrough, task lists, and autolinks.
// An image is not drawn (the page CSP blocks remote images). Its alt text is shown, or nothing when alt is empty.
// Raw HTML is not enabled, so it is shown as text.
import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";

export const markdownOptions = {
  remarkPlugins: [remarkGfm],
  components: {
    img({ alt }) {
      return alt === undefined || alt === "" ? null : alt;
    },
  },
} satisfies Options;

/** The diagram source when a fenced block is marked `mermaid`, otherwise null. */
export function mermaidSource(className: string | undefined, text: string): string | null {
  if (className === undefined || !/(^|\s)language-mermaid(\s|$)/.test(className)) return null;
  const source = text.replace(/\n$/, "");
  return source.trim() === "" ? null : source;
}
