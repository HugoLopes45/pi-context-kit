import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SearchOptions {
  query: string;
  regex?: boolean;
  offset?: number;
  limit?: number;
}

export interface ReadOptions {
  offset?: number;
  limit?: number;
}

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;
const MAX_CHARS = 50_000;
const DEFAULT_CHARS = 20_000;
const SNIPPET_CHARS = 160;

/** Searches the raw text of every entry on the branch, including compacted and edited ones. */
export function searchEntries(
  branch: readonly SessionEntry[],
  options: SearchOptions,
): string {
  const matcher = createMatcher(options);
  const hits: string[] = [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    const text = entryText(entry);
    const index = text ? matcher(text) : -1;
    if (index >= 0)
      hits.push(`${entry.id} ${entryLabel(entry)}: ${snippet(text, index)}`);
  }
  if (hits.length === 0) return "No entries match.";
  const offset = clamp(options.offset, 0, hits.length, 0);
  const limit = clamp(options.limit, 1, MAX_RESULTS, DEFAULT_RESULTS);
  const page = hits.slice(offset, offset + limit);
  const end = offset + page.length;
  if (end < hits.length)
    page.push(`[${hits.length} matches. Use offset=${end} for more.]`);
  return page.join("\n");
}

/** Returns one entry's raw text, paged by characters. */
export function readEntry(
  branch: readonly SessionEntry[],
  entryId: string,
  options: ReadOptions,
): string {
  const entry = branch.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error(`No entry ${entryId} on the current branch.`);
  const text = entryText(entry);
  const offset = clamp(options.offset, 0, text.length, 0);
  const limit = clamp(options.limit, 1, MAX_CHARS, DEFAULT_CHARS);
  const end = Math.min(text.length, offset + limit);
  const page = text.slice(offset, end);
  return end < text.length
    ? `${page}\n\n[Showing characters ${offset}-${end} of ${text.length}. Use offset=${end} to continue.]`
    : page;
}

function createMatcher(options: SearchOptions): (text: string) => number {
  if (!options.regex) {
    const needle = options.query.toLowerCase();
    return (text) => text.toLowerCase().indexOf(needle);
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(options.query, "i");
  } catch (error) {
    throw new Error(
      `Invalid regex: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return (text) => text.search(pattern);
}

function entryLabel(entry: SessionEntry): string {
  if (entry.type !== "message") return entry.type;
  const { message } = entry;
  return message.role === "toolResult"
    ? `toolResult ${message.toolName}`
    : message.role;
}

function entryText(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return messageText(entry.message);
    case "custom_message":
      return contentText(entry.content);
    case "compaction":
    case "branch_summary":
      return entry.summary;
    default:
      return "";
  }
}

function messageText(
  message: Extract<SessionEntry, { type: "message" }>["message"],
): string {
  switch (message.role) {
    case "user":
    case "custom":
      return contentText(message.content);
    case "assistant":
      return message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "thinking") return `[thinking] ${block.thinking}`;
          return `[tool call ${block.name} ${JSON.stringify(block.arguments)}]`;
        })
        .join("\n");
    case "toolResult":
      return `[${message.toolName} result${message.isError ? " error" : ""}]\n${contentText(message.content)}`;
    case "system":
      return "";
    default:
      return JSON.stringify(message);
  }
}

function contentText(
  content: string | readonly (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      block.type === "text" ? block.text : `[image ${block.mimeType}]`,
    )
    .join("\n");
}

function snippet(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_CHARS / 2);
  const flat = text
    .slice(start, start + SNIPPET_CHARS)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${flat}${start + SNIPPET_CHARS < text.length ? "…" : ""}`;
}

function clamp(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
