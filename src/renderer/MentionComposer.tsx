import { useEffect, useRef, useState } from "react";
import { filterRepoNames, mentionQuery } from "../shared/mention.js";

type MentionComposerProps = {
  id: string;
  value: string;
  repos: readonly string[];
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: () => void;
};

export function MentionComposer({ id, value, repos, disabled, placeholder, onChange, onSend }: MentionComposerProps) {
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<number | null>(null);
  const query = open ? mentionQuery(value, caret) : null;
  const matches = query === null ? [] : filterRepoNames(repos, query.query);
  const shown = open && query !== null && matches.length > 0;
  const active = Math.min(selected, Math.max(matches.length - 1, 0));
  const listId = `${id}-mentions`;
  const activeId = shown ? `${id}-option-${active}` : undefined;

  useEffect(() => {
    const node = area.current;
    const cursor = caretAfter.current;
    if (node === null || cursor === null) return;
    caretAfter.current = null;
    node.setSelectionRange(cursor, cursor);
  }, [value]);

  function choose(name: string): void {
    if (query === null) return;
    const inserted = `@${name} `;
    const next = `${value.slice(0, query.start)}${inserted}${value.slice(caret)}`;
    caretAfter.current = query.start + inserted.length;
    onChange(next);
    setCaret(caretAfter.current);
    setOpen(false);
  }

  return (
    <div className="mention">
      {shown ? (
        <ul className="mention-list" id={listId} role="listbox">
          {matches.map((name, index) => (
            <li
              key={name}
              id={`${id}-option-${index}`}
              role="option"
              className={index === active ? "mention-hit active" : "mention-hit"}
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(name);
              }}
            >
              @{name}
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={area}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={activeId}
        rows={2}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setOpen(true);
          setSelected(0);
        }}
        onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onClick={(event) => {
          setCaret(event.currentTarget.selectionStart ?? 0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (shown && event.key === "ArrowDown") {
            event.preventDefault();
            if (matches.length === 0) return;
            setSelected((active + 1) % matches.length);
            return;
          }
          if (shown && event.key === "ArrowUp") {
            event.preventDefault();
            if (matches.length === 0) return;
            setSelected((active - 1 + matches.length) % matches.length);
            return;
          }
          if (shown && (event.key === "Tab" || event.key === "Enter")) {
            const name = matches[active];
            if (name === undefined) return;
            event.preventDefault();
            choose(name);
            return;
          }
          if (event.key === "Escape") {
            setOpen(false);
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!disabled) onSend();
          }
        }}
        onBlur={() => setOpen(false)}
      />
    </div>
  );
}
