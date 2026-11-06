import type { ModelChoice } from "./state.js";
import { subagentPhase, type ToolItem } from "./segments.js";

export function SubagentCard({
  item,
  live,
  models,
  selectedModel,
}: {
  item: ToolItem;
  live: boolean;
  models: readonly ModelChoice[];
  selectedModel: string;
}) {
  const { phase, label } = subagentPhase(item.status, live);
  const title = item.subagent?.description?.trim() || "Subagent";
  const model = modelLabel(item.subagent?.model, models, selectedModel);
  const activity = item.subagent?.activity?.trim() ?? "";
  const showActivity = activity !== "" && !(activity === "Thinking" && phase !== "running");
  return (
    <article className="subagent-card" data-phase={phase} aria-label={`Subagent: ${title}`}>
      <span className="subagent-mark" aria-hidden="true">
        <span className="tool-dot" />
        ::
      </span>
      <span className="subagent-title">{title}</span>
      {model !== "" ? <span className="subagent-model">{model}</span> : <span />}
      {showActivity ? <span className="subagent-activity">{activity}</span> : null}
      <span className="subagent-status">{label}</span>
    </article>
  );
}

function modelLabel(specified: string | undefined, models: readonly ModelChoice[], selected: string): string {
  const id = specified !== undefined && specified.trim() !== "" ? specified.trim() : selected;
  if (id === "") return "";
  const known = models.find((model) => model.id === id);
  return known !== undefined ? known.label : id;
}
