import { useEffect, useState } from "react";
import { useDarkMode } from "./dark-mode.js";
import { svgDataUrl, svgWidth } from "./mermaid-config.js";
import { renderDiagram } from "./mermaid-render.js";

type Drawn = { kind: "loading" } | { kind: "ready"; url: string; width: number | null } | { kind: "failed" };

/** `live` is true while the message is still streaming: the source may be half written, so show it as code. */
export function MermaidBlock({ code, live }: { code: string; live: boolean }) {
  const dark = useDarkMode();
  const [drawn, setDrawn] = useState<Drawn>({ kind: "loading" });

  useEffect(() => {
    if (live) return;
    let cancelled = false;
    setDrawn({ kind: "loading" });
    renderDiagram(code, dark).then(
      (svg) => {
        if (!cancelled) setDrawn({ kind: "ready", url: svgDataUrl(svg), width: svgWidth(svg) });
      },
      () => {
        if (!cancelled) setDrawn({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, dark, live]);

  if (live || drawn.kind === "failed") {
    return (
      <div className="md-diagram">
        <pre>
          <code>{code}</code>
        </pre>
        {live ? null : <p className="md-diagram-note">This diagram could not be drawn.</p>}
      </div>
    );
  }
  if (drawn.kind === "loading") {
    return <div className="md-diagram md-diagram-note">Drawing diagram…</div>;
  }
  return (
    <div className="md-diagram">
      <img
        src={drawn.url}
        alt="Diagram"
        style={drawn.width === null ? undefined : { width: drawn.width }}
        onError={() => setDrawn({ kind: "failed" })}
      />
    </div>
  );
}
