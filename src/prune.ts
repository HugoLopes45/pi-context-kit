import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type Edit,
  editableMessage,
  messageTokens,
  withContent,
} from "./context.ts";
import { toolCallsById } from "./tool-calls.ts";

export interface PruneOptions {
  /** Newest tool-output tokens that are never pruned. */
  protectTokens: number;
  /** Prune nothing unless the total savings reach this many tokens. */
  minSavings: number;
  /** Outputs smaller than this are never pruned. */
  minTokens: number;
}

/** Replaces old tool outputs with a short notice that points to `recall`. */
export function pruneToolOutputs(
  entries: readonly ProjectedSessionEntry[],
  edited: ReadonlySet<string>,
  options: PruneOptions,
): Edit[] {
  const calls = toolCallsById(entries);
  const edits: Edit[] = [];
  let seen = 0;
  let savings = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = entry && editableMessage(entry);
    if (!entry || message?.role !== "toolResult") continue;
    const tokens = messageTokens(message);
    const protectedByWindow = seen < options.protectTokens;
    seen += tokens;
    const id = entry.sourceEntry.id;
    if (
      protectedByWindow ||
      tokens < options.minTokens ||
      edited.has(id) ||
      isSkillFile(calls.get(message.toolCallId)?.arguments)
    ) {
      continue;
    }
    const content = [
      {
        type: "text" as const,
        text: `[Output pruned: about ${tokens} tokens. Call recall with entryId "${id}" to read it.]`,
      },
    ];
    const saved = tokens - messageTokens(withContent(message, content));
    if (saved <= 0) continue;
    savings += saved;
    edits.push({ targetId: id, content });
  }
  return savings >= options.minSavings ? edits.reverse() : [];
}

function isSkillFile(args: Record<string, unknown> | undefined): boolean {
  const path = args?.path;
  return typeof path === "string" && /(^|[\\/])SKILL\.md$/.test(path);
}
