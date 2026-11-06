import type { ReactNode } from "react";
import { TICKET_COLUMNS, type TicketColumn } from "../shared/jira.js";

/** The three columns and the Load more button. The caller loads the rows and draws each card. */
export function TicketBoard<T>({
  columns,
  renderCard,
  next,
  loadingMore,
  onLoadMore,
}: {
  columns: Record<TicketColumn, T[]>;
  renderCard: (item: T) => ReactNode;
  next: string | null;
  loadingMore: boolean;
  onLoadMore: (page: string) => void;
}) {
  return (
    <>
      <div className="ticket-board">
        {TICKET_COLUMNS.map((column) => (
          <section key={column.id} className="ticket-column" aria-label={column.label}>
            <h3>
              {column.label}
              <span className="ticket-count">{columns[column.id].length}</span>
            </h3>
            {columns[column.id].length === 0 ? (
              <p className="ticket-column-empty">None</p>
            ) : (
              <ul className="ticket-list">{columns[column.id].map((item) => renderCard(item))}</ul>
            )}
          </section>
        ))}
      </div>
      {next !== null ? (
        <p className="actions">
          <button type="button" className="btn" disabled={loadingMore} onClick={() => onLoadMore(next)}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </p>
      ) : null}
    </>
  );
}
