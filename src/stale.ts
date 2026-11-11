import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { type Edit, messageTokens, withContent } from "./context.ts";
import { newestToolResults, type ToolResult } from "./tool-calls.ts";

export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

interface ReadKey {
  path: string;
  /** Undefined for a read of the whole file. */
  range: string | undefined;
}

interface NewerReads {
  anyRead: boolean;
  fullSuccess: boolean;
  successRanges: Set<string>;
}

/**
 * Replaces read results that a newer read of the same file makes redundant.
 * A newer full read covers every older read; a newer ranged read covers only the same range;
 * a failed read covers only older failed reads.
 */
export function supersededReads(
  entries: readonly ProjectedSessionEntry[],
  edited: ReadonlySet<string>,
): Edit[] {
  const newer = new Map<string, NewerReads>();
  const edits: Edit[] = [];

  for (const result of newestToolResults(entries)) {
    const key = result.message.toolName === "read" && readKey(result.args);
    if (!key) continue;
    const seen = newer.get(key.path) ?? {
      anyRead: false,
      fullSuccess: false,
      successRanges: new Set<string>(),
    };
    if (!edited.has(result.id) && isSuperseded(result, key, seen)) {
      const edit = supersededEdit(result);
      if (edit) edits.push(edit);
    }
    recordRead(seen, result, key);
    newer.set(key.path, seen);
  }
  return edits.reverse();
}

function isSuperseded(
  { message }: ToolResult,
  key: ReadKey,
  seen: NewerReads,
): boolean {
  if (message.isError) return seen.anyRead;
  return (
    seen.fullSuccess ||
    (key.range !== undefined && seen.successRanges.has(key.range))
  );
}

function supersededEdit({ id, message }: ToolResult): Edit | undefined {
  const content = [{ type: "text" as const, text: SUPERSEDED_NOTICE }];
  return messageTokens(withContent(message, content)) < messageTokens(message)
    ? { targetId: id, content }
    : undefined;
}

function recordRead(
  seen: NewerReads,
  { message }: ToolResult,
  key: ReadKey,
): void {
  seen.anyRead = true;
  if (message.isError || isTruncatedRead(message.content)) return;
  if (key.range === undefined) seen.fullSuccess = true;
  else seen.successRanges.add(key.range);
}

function isTruncatedRead(content: ToolResultMessage["content"]): boolean {
  return content.some(
    (block) =>
      block.type === "text" &&
      /\[(?:Showing lines |\d+ more lines in file|Line \d+ is )/.test(
        block.text,
      ),
  );
}

function readKey(
  args: Record<string, unknown> | undefined,
): ReadKey | undefined {
  const path = args?.path;
  if (typeof path !== "string" || path.length === 0) return undefined;
  const { offset, limit } = args ?? {};
  const ranged = offset !== undefined || limit !== undefined;
  return {
    path,
    range: ranged ? `${String(offset ?? 1)}:${String(limit ?? "")}` : undefined,
  };
}
