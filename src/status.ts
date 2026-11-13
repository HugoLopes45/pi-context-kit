const NOTE_LABEL = {
  writing: "writing summary",
  ready: "summary ready",
} as const;

export interface StatusInput {
  tokens: number;
  /** Where compaction starts, or +Infinity when nothing compacts. */
  limit: number;
  contextWindow: number;
  note?: keyof typeof NOTE_LABEL;
}

/** The footer text: context use and threshold as shares of the window, then the background note. */
export function statusText(input: StatusInput): string {
  const share = (tokens: number) => percent(tokens, input.contextWindow);
  const limit = Number.isFinite(input.limit)
    ? `cleanup at ${share(input.limit)}`
    : "no automatic cleanup";
  const note = input.note ? ` · ${NOTE_LABEL[input.note]}` : "";
  return `Context ${share(input.tokens)} · ${limit}${note}`;
}

/** The notice after context edits, which Pi does not show by itself. */
export function freedNotice(
  before: number,
  after: number,
  contextWindow: number,
): string {
  const freed = before - after;
  return `pi-context-kit freed ${percent(freed, contextWindow)} of the context (${tokenCount(freed)} tokens). The agent can still look up what was removed.`;
}

/** Rounded down, so 100% means the window is full. */
function percent(tokens: number, contextWindow: number): string {
  return `${Math.floor((tokens * 100) / contextWindow)}%`;
}

function tokenCount(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}
