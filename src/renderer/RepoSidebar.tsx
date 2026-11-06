export type SidebarRow = {
  name: string;
  status: "idle" | "running" | "waiting" | "error";
  unseen: boolean;
  active: boolean;
};

type RepoSidebarProps = {
  rows: SidebarRow[];
  onOpen: (name: string) => void;
  onNew: () => void;
};

export function RepoSidebar({ rows, onOpen, onNew }: RepoSidebarProps) {
  return (
    <aside className="sidebar">
      <button type="button" className="btn" onClick={onNew}>
        New chat
      </button>
      <ul className="repo-list">
        {rows.map((row) => (
          <li key={row.name}>
            <button
              type="button"
              className={row.active ? "repo-row active" : "repo-row"}
              aria-current={row.active ? "page" : undefined}
              onClick={() => onOpen(row.name)}
            >
              <span className={`dot ${row.status}`} />
              <span className="sr">{statusText(row.status)}</span>
              <span>{row.name}</span>
              {row.unseen ? <span className="unseen">new</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function statusText(status: SidebarRow["status"]): string {
  if (status === "running") return "Running";
  if (status === "waiting") return "Waiting";
  if (status === "error") return "Error";
  return "Idle";
}
