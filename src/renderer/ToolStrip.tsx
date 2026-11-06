import { useEffect, useRef } from "react";
import { cleanSummary, toolPhase, type ToolItem } from "./segments.js";

export function ToolStrip({ tools, live }: { tools: readonly ToolItem[]; live: boolean }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || !live || !stickRef.current) return;
    strip.scrollTop = strip.scrollHeight;
  }, [tools, live]);

  return (
    <div
      className="tool-strip"
      ref={stripRef}
      role="list"
      aria-label="Tool calls"
      tabIndex={tools.length > 4 ? 0 : undefined}
      onScroll={() => {
        const strip = stripRef.current;
        if (strip === null) return;
        stickRef.current = strip.scrollHeight - strip.scrollTop - strip.clientHeight < 8;
      }}
    >
      {tools.map((tool) => {
        const detail = cleanSummary(tool.summary);
        const { phase, label } = toolPhase(tool.status, live);
        return (
          <div className="tool-line" role="listitem" data-phase={phase} key={tool.id}>
            <span className="tool-dot" aria-hidden="true" />
            <span className="tool-name">{tool.name}</span>
            <span className="tool-detail" title={detail}>
              {detail}
            </span>
            <span className="tool-status">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
