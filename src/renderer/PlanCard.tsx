import { Markdown } from "./Markdown.js";

export function PlanCard({ markdown, truncated }: { markdown: string; truncated: boolean }) {
  return (
    <article className="plan-card">
      <p className="plan-label">Plan</p>
      <div className="plan-body">
        <Markdown text={markdown} />
      </div>
      {truncated ? <p className="plan-note">This plan was cut off.</p> : null}
    </article>
  );
}
