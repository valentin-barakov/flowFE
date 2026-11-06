import { MentionComposer } from "./MentionComposer.js";

type NewChatProps = {
  repos: readonly string[];
  draft: string;
  notice: string | null;
  pending: boolean;
  onDraft: (draft: string) => void;
  onSend: () => void;
};

export function NewChat({ repos, draft, notice, pending, onDraft, onSend }: NewChatProps) {
  return (
    <section className="home">
      <div className="titles">
        <h2>New chat</h2>
        <p className="lead">Type @ and a repo name. The agent runs in that repo.</p>
      </div>
      {notice ? <p className="notice">{notice}</p> : null}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) onSend();
        }}
      >
        <label className="sr" htmlFor="home-draft">
          Message
        </label>
        <MentionComposer
          id="home-draft"
          value={draft}
          repos={repos}
          disabled={pending}
          placeholder="Message a repo with @api"
          onChange={onDraft}
          onSend={onSend}
        />
        <button type="submit" className="btn primary" disabled={pending || draft.trim() === ""}>
          Send
        </button>
      </form>
    </section>
  );
}
