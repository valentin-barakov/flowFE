import type { ChatFruit } from "./fruits.js";

type BotProps = {
  kind: "agent" | "user";
  running?: boolean;
  large?: boolean;
  fruit?: ChatFruit;
};

const FRUIT_MOTION: Record<ChatFruit, { hue: string; lag: string }> = {
  mango: { hue: "32", lag: "0.70s" },
  strawberry: { hue: "350", lag: "0.15s" },
  blueberry: { hue: "226", lag: "1.35s" },
  orange: { hue: "16", lag: "2.10s" },
};

export function Bot({ kind, running = false, large = false, fruit = "mango" }: BotProps) {
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
  const motion = FRUIT_MOTION[fruit];
  const cls = ["bot", "orchestrator", running ? "running" : "idle", size].filter(Boolean).join(" ");
  return (
    <span
      className={cls}
      data-fruit={fruit}
      style={{ ["--hue" as string]: motion.hue, ["--lag" as string]: motion.lag }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64">
        {running ? <circle className="halo" cx="32" cy="34" r="24" /> : null}
        <FruitBody fruit={fruit} />
        <Face />
      </svg>
    </span>
  );
}

function Face() {
  return (
    <>
      <g className="eyes">
        <ellipse cx="26" cy="36" rx="2.3" ry="2.8" />
        <ellipse cx="38" cy="36" rx="2.3" ry="2.8" />
      </g>
      <path className="smile" d="M26 44q6 5 12 0" />
      <ellipse className="cheek" cx="20" cy="42" rx="2.6" ry="1.5" />
      <ellipse className="cheek" cx="44" cy="42" rx="2.6" ry="1.5" />
    </>
  );
}

function FruitBody({ fruit }: { fruit: ChatFruit }) {
  if (fruit === "strawberry") return <Strawberry />;
  if (fruit === "blueberry") return <Blueberry />;
  if (fruit === "orange") return <Orange />;
  return <Mango />;
}

function Mango() {
  return (
    <>
      <ellipse className="body" cx="32" cy="36" rx="16" ry="18" />
      <ellipse className="shine" cx="26" cy="29" rx="5" ry="7" />
      <g className="leaf">
        <path d="M33 20c1-10 13-12 15-4-8 0-13 4-15 8z" />
        <path className="stem" d="M32 22V13" />
      </g>
    </>
  );
}

function Strawberry() {
  return (
    <>
      <path className="body" d="M32 56C24 52 15 46 14 35 13 24 20 17 32 16 44 17 51 24 50 35 49 46 40 52 32 56Z" />
      <ellipse className="shine" cx="25" cy="28" rx="4.2" ry="5.5" />
      <g className="pits">
        <ellipse cx="24" cy="27" rx="1.15" ry="1.7" transform="rotate(-28 24 27)" />
        <ellipse cx="33" cy="24" rx="1.15" ry="1.7" transform="rotate(6 33 24)" />
        <ellipse cx="41" cy="28" rx="1.15" ry="1.7" transform="rotate(26 41 28)" />
        <ellipse cx="19" cy="35" rx="1.1" ry="1.55" transform="rotate(-42 19 35)" />
        <ellipse cx="45" cy="36" rx="1.1" ry="1.55" transform="rotate(40 45 36)" />
        <ellipse cx="26" cy="49" rx="1.05" ry="1.45" transform="rotate(-18 26 49)" />
        <ellipse cx="37" cy="50" rx="1.05" ry="1.45" transform="rotate(16 37 50)" />
      </g>
      <g className="leaf">
        <path d="M32 18C28 10 18 11 20 17c3.4-.2 8-.2 12 1z" />
        <path d="M32 17c1-9 9-11 10-4-3.6.4-7 1.6-10 4.2z" />
        <path d="M32 18c3-8 12-7 12-1-4.2-.2-8.2-.2-12 1.4z" />
      </g>
    </>
  );
}

function Blueberry() {
  return (
    <>
      <circle className="body" cx="32" cy="36" r="17.5" />
      <ellipse className="shine" cx="25" cy="28" rx="6.2" ry="4.4" />
      <g className="leaf">
        <path d="M32 11.2l1.8 5 5.2.3-4 3.3 1.4 5-4.4-2.8-4.4 2.8 1.4-5-4-3.3 5.2-.3z" />
      </g>
    </>
  );
}

function Orange() {
  return (
    <>
      <ellipse className="body" cx="32" cy="36" rx="18" ry="16" />
      <ellipse className="shine" cx="25" cy="29" rx="4.6" ry="6" />
      <g className="pits">
        <circle cx="18" cy="33" r="1.15" />
        <circle cx="46" cy="34" r="1.15" />
        <circle cx="16" cy="41" r="1" />
        <circle cx="48" cy="42" r="1" />
        <circle cx="24" cy="49" r="1.05" />
        <circle cx="40" cy="49" r="1.05" />
      </g>
      <g className="leaf">
        <path d="M34 21c1-9 12-10 13-3-7.4.3-11 2-13 6.6z" />
        <path className="stem" d="M33 22c-1-6 2-9 4-10" />
      </g>
    </>
  );
}
