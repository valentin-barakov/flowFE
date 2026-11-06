import { Children, isValidElement, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { markdownOptions, mermaidSource } from "./markdown-config.js";
import { MermaidBlock } from "./MermaidBlock.js";

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

// The window refuses navigation and has no open-external command, so a link is styled text.
function makeComponents(live: boolean): Components {
  return {
    a({ href, children }) {
      return (
        <span className="md-link" title={href}>
          {children}
        </span>
      );
    },
    table({ children }) {
      return (
        <div className="md-table">
          <table>{children}</table>
        </div>
      );
    },
    pre({ children }) {
      const child = Children.toArray(children)[0];
      if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        const source = mermaidSource(child.props.className, textOf(child.props.children));
        if (source !== null) return <MermaidBlock code={source} live={live} />;
      }
      return <pre>{children}</pre>;
    },
  };
}

export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  const components = useMemo(() => makeComponents(live), [live]);
  return (
    <div className={live ? "md md-live" : "md"}>
      <ReactMarkdown {...markdownOptions} components={{ ...markdownOptions.components, ...components }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
