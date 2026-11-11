import type { ToolCall } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { type EditableMessage, editableMessage } from "./context.ts";

export interface ToolResult {
  id: string;
  message: Extract<EditableMessage, { role: "toolResult" }>;
  args: Record<string, unknown> | undefined;
}

/** Tool calls in the projected context, by tool call ID. */
function toolCallsById(
  entries: readonly ProjectedSessionEntry[],
): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const entry of entries) {
    for (const message of entry.messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type === "toolCall") calls.set(block.id, block);
      }
    }
  }
  return calls;
}

/** Editable tool results, newest first, with the arguments of their tool call. */
export function* newestToolResults(
  entries: readonly ProjectedSessionEntry[],
): Generator<ToolResult> {
  const calls = toolCallsById(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = entry && editableMessage(entry);
    if (!entry || message?.role !== "toolResult") continue;
    const args = calls.get(message.toolCallId)?.arguments;
    yield { id: entry.sourceEntry.id, message, args };
  }
}
