type BotProps = {
  kind: "agent" | "user";
  running?: boolean;
  large?: boolean;
};

export function Bot({ kind, running = false, large = false }: BotProps) {
  const size = large ? "lg" : "";
  if (kind === "user") {
    return (
      <span className={["bot", "you", size].filter(Boolean).join(" ")} aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <circle className="body" cx="32" cy="32" r="18" />
          <circle className="head" cx="32" cy="26" r="6" />
          <path className="shoulders" d="M18 48c2-8 8-12 14-12s12 4 14 12" />
        </svg>
      </span>
    );
  }
  const cls = ["bot", "orchestrator", running ? "running" : "idle", size].filter(Boolean).join(" ");
  return (
    <span className={cls} style={{ ["--hue" as string]: "32", ["--lag" as string]: "0.70s" }} aria-hidden="true">
      <svg viewBox="0 0 64 64">
        {running ? <circle className="halo" cx="32" cy="34" r="24" /> : null}
        <ellipse className="body" cx="32" cy="36" rx="16" ry="18" />
        <ellipse className="shine" cx="26" cy="29" rx="5" ry="7" />
        <g className="leaf">
          <path d="M33 20c1-10 13-12 15-4-8 0-13 4-15 8z" />
          <path className="stem" d="M32 22V13" />
        </g>
        <g className="eyes">
          <ellipse cx="26" cy="36" rx="2.3" ry="2.8" />
          <ellipse cx="38" cy="36" rx="2.3" ry="2.8" />
        </g>
        <path className="smile" d="M26 44q6 5 12 0" />
        <ellipse className="cheek" cx="20" cy="42" rx="2.6" ry="1.5" />
        <ellipse className="cheek" cx="44" cy="42" rx="2.6" ry="1.5" />
      </svg>
    </span>
  );
}
