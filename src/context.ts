import {
  type ContextEditableContent,
  type ContextEditEntryDraft,
  estimateTokens,
  type ProjectedSessionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type AgentMessage = ProjectedSessionEntry["messages"][number];
export type EditableMessage = Extract<
  AgentMessage,
  { role: "user" | "assistant" | "toolResult" | "custom" }
>;

/** A replacement of one entry's model-visible content. */
export interface Edit {
  targetId: string;
  content: ContextEditableContent;
}

const EDITABLE_ROLES = new Set(["user", "assistant", "toolResult", "custom"]);

/** The single editable message an entry contributes, if any. */
export function editableMessage(
  entry: ProjectedSessionEntry,
): EditableMessage | undefined {
  if (entry.messages.length !== 1) return undefined;
  const [message] = entry.messages;
  return message && EDITABLE_ROLES.has(message.role)
    ? (message as EditableMessage)
    : undefined;
}

/** Same rule as Pi's projected estimate: the current system message plus every other message. */
export function contextTokens(messages: readonly AgentMessage[]): number {
  let system: AgentMessage | undefined;
  let tokens = 0;
  for (const message of messages) {
    if (message.role === "system") system = message;
    else tokens += estimateTokens(message);
  }
  return tokens + (system ? estimateTokens(system) : 0);
}

export function messageTokens(message: AgentMessage): number {
  return estimateTokens(message);
}

/** Tokens from each entry through the end of the projected context. */
export function suffixTokens(
  entries: readonly ProjectedSessionEntry[],
): number[] {
  const suffix = new Array<number>(entries.length).fill(0);
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    for (const message of entries[i]?.messages ?? []) {
      if (message.role !== "system") total += estimateTokens(message);
    }
    suffix[i] = total;
  }
  return suffix;
}

export function withContent(
  message: EditableMessage,
  content: ContextEditableContent,
): EditableMessage {
  return { ...message, content } as EditableMessage;
}

/** Applies edits to projected entries without mutating them. */
export function applyEdits(
  entries: readonly ProjectedSessionEntry[],
  edits: readonly Edit[],
): ProjectedSessionEntry[] {
  if (edits.length === 0) return [...entries];
  const byId = new Map(edits.map((edit) => [edit.targetId, edit.content]));
  return entries.map((entry) => {
    const content = byId.get(entry.sourceEntry.id);
    const message = editableMessage(entry);
    return content !== undefined && message
      ? { ...entry, messages: [withContent(message, content)] }
      : entry;
  });
}

export function projectedMessages(
  entries: readonly ProjectedSessionEntry[],
): AgentMessage[] {
  return entries.flatMap((entry) => entry.messages);
}

/** Entry IDs that already have a context edit on the branch. */
export function editedEntryIds(branch: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "context_edit") ids.add(entry.targetId);
  }
  return ids;
}

export function toDrafts(edits: readonly Edit[]): ContextEditEntryDraft[] {
  return edits.map((edit) => ({
    type: "context_edit",
    targetId: edit.targetId,
    replacement: { content: edit.content },
  }));
}
