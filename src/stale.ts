import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type Edit,
  editableMessage,
  messageTokens,
  suffixTokens,
  withContent,
} from "./context.ts";
import { toolCallsById } from "./tool-calls.ts";

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
 * a failed read covers only older failed reads. A candidate and its newer messages must fit
 * within `suffixLimit` tokens.
 */
export function supersededReads(
  entries: readonly ProjectedSessionEntry[],
  edited: ReadonlySet<string>,
  suffixLimit: number,
): Edit[] {
  const calls = toolCallsById(entries);
  const suffix = suffixTokens(entries);
  const newer = new Map<string, NewerReads>();
  const edits: Edit[] = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = entry && editableMessage(entry);
    if (!entry || message?.role !== "toolResult" || message.toolName !== "read")
      continue;
    const key = readKey(calls.get(message.toolCallId)?.arguments);
    if (!key) continue;

    const seen = newer.get(key.path) ?? {
      anyRead: false,
      fullSuccess: false,
      successRanges: new Set<string>(),
    };
    const readCoversOutput =
      !message.isError && !isTruncatedRead(message.content);
    const superseded = message.isError
      ? seen.anyRead
      : seen.fullSuccess ||
        (key.range !== undefined && seen.successRanges.has(key.range));

    if (
      superseded &&
      !edited.has(entry.sourceEntry.id) &&
      (suffix[i] ?? Number.POSITIVE_INFINITY) <= suffixLimit
    ) {
      const content = [{ type: "text" as const, text: SUPERSEDED_NOTICE }];
      if (
        messageTokens(withContent(message, content)) < messageTokens(message)
      ) {
        edits.push({ targetId: entry.sourceEntry.id, content });
      }
    }

    seen.anyRead = true;
    if (readCoversOutput) {
      if (key.range === undefined) seen.fullSuccess = true;
      else seen.successRanges.add(key.range);
    }
    newer.set(key.path, seen);
  }
  return edits.reverse();
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
