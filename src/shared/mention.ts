// Pure @repo parsing. No I/O. The renderer and scripts/mention-check.ts both use this.

const MENTION = /(^|\s)@([^\s@]+)/g;
const OPEN_QUERY = /(^|\s)@([^\s@]*)$/;

export type MentionHit = { name: string; start: number; end: number };

export type ParsedMention =
  | { ok: true; repo: string; text: string }
  | { ok: false; reason: "none" | "many" };

export function findMentions(text: string): MentionHit[] {
  const hits: MentionHit[] = [];
  MENTION.lastIndex = 0;
  let match: RegExpExecArray | null = MENTION.exec(text);
  while (match !== null) {
    const lead = match[1] ?? "";
    const name = match[2] ?? "";
    const start = match.index + lead.length;
    hits.push({ name, start, end: start + 1 + name.length });
    match = MENTION.exec(text);
  }
  return hits;
}

export function parseMention(text: string, repos: readonly string[]): ParsedMention {
  const known = new Set(repos);
  const matched = findMentions(text).filter((hit) => known.has(hit.name));
  const names = [...new Set(matched.map((hit) => hit.name))];
  if (names.length === 0) return { ok: false, reason: "none" };
  if (names.length > 1) return { ok: false, reason: "many" };
  const repo = names[0];
  const hit = matched[0];
  if (repo === undefined || hit === undefined) return { ok: false, reason: "none" };
  return { ok: true, repo, text: textWithoutMention(text, hit) };
}

function textWithoutMention(text: string, hit: MentionHit): string {
  const before = text.slice(0, hit.start);
  const after = text.slice(hit.end);
  const left = before.at(-1);
  const right = after[0];
  const bothSpaceOrTab = (left === " " || left === "\t") && (right === " " || right === "\t");
  const joined = bothSpaceOrTab ? `${before.slice(0, -1)}${after}` : `${before}${after}`;
  return joined.trim();
}

export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, caret));
  const match = OPEN_QUERY.exec(before);
  if (match === null) return null;
  const query = match[2] ?? "";
  return { start: before.length - query.length - 1, query };
}

export function filterRepoNames(repos: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  return repos.filter((name) => name !== "." && !/[\s@]/.test(name) && name.toLowerCase().startsWith(needle));
}
