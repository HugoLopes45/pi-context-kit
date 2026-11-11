import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { type Edit, messageTokens, withContent } from "./context.ts";
import { newestToolResults, type ToolResult } from "./tool-calls.ts";

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
  const edits: Edit[] = [];
  let seen = 0;
  let savings = 0;

  for (const result of newestToolResults(entries)) {
    const tokens = messageTokens(result.message);
    const protectedByWindow = seen < options.protectTokens;
    seen += tokens;
    if (
      protectedByWindow ||
      tokens < options.minTokens ||
      edited.has(result.id) ||
      isSkillFile(result.args)
    ) {
      continue;
    }
    const edit = pruneEdit(result, tokens);
    if (!edit) continue;
    savings += edit.saved;
    edits.push(edit.edit);
  }
  return savings >= options.minSavings ? edits.reverse() : [];
}

function pruneEdit(
  { id, message }: ToolResult,
  tokens: number,
): { edit: Edit; saved: number } | undefined {
  const content = [
    {
      type: "text" as const,
      text: `[Output pruned: about ${tokens} tokens. Call recall with entryId "${id}" to read it.]`,
    },
  ];
  const saved = tokens - messageTokens(withContent(message, content));
  return saved > 0 ? { edit: { targetId: id, content }, saved } : undefined;
}

function isSkillFile(args: Record<string, unknown> | undefined): boolean {
  const path = args?.path;
  return typeof path === "string" && /(^|[\\/])SKILL\.md$/.test(path);
}
