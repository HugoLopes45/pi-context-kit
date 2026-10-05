import type { ToolCall } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

/** Tool calls in the projected context, by tool call ID. */
export function toolCallsById(
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
