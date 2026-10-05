import type { TextContent } from "@earendil-works/pi-ai";
import type {
  ContextEditableContent,
  ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type Edit,
  type EditableMessage,
  editableMessage,
  messageTokens,
  withContent,
} from "./context.ts";

export interface ShakeOptions {
  /** Newest context tokens that are never shaken. */
  protectTokens: number;
  /** Shake nothing unless the total savings reach this many tokens. */
  minSavings: number;
  /** Fenced or XML blocks smaller than this stay. */
  blockMinTokens: number;
}

export const AUTO_SHAKE: ShakeOptions = {
  protectTokens: 16_000,
  minSavings: 4_000,
  blockMinTokens: 400,
};

/** A fenced code block, or an XML-like element with a matching closing tag. */
const BLOCK =
  /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1|<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\2>/g;

/**
 * Elides large blocks and images from older messages. Tool calls and thinking stay intact,
 * so every tool call keeps its result and signed reasoning stays valid.
 */
export function shake(
  entries: readonly ProjectedSessionEntry[],
  options: ShakeOptions,
): Edit[] {
  const edits: Edit[] = [];
  let seen = 0;
  let savings = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    const isProtected = seen < options.protectTokens;
    for (const message of entry.messages) {
      if (message.role !== "system") seen += messageTokens(message);
    }
    const message = editableMessage(entry);
    if (isProtected || !message) continue;

    const content = shakeContent(message, entry.sourceEntry.id, options);
    if (content === undefined) continue;
    const saved =
      messageTokens(message) - messageTokens(withContent(message, content));
    if (saved <= 0) continue;
    savings += saved;
    edits.push({ targetId: entry.sourceEntry.id, content });
  }
  return savings >= options.minSavings && edits.length > 0
    ? edits.reverse()
    : [];
}

function shakeContent(
  message: EditableMessage,
  id: string,
  options: ShakeOptions,
): ContextEditableContent | undefined {
  const text = (value: string) =>
    elideBlocks(value, id, options.blockMinTokens);

  if (typeof message.content === "string") {
    const next = text(message.content);
    return next === message.content ? undefined : next;
  }
  let changed = false;
  const next = message.content.map((block) => {
    if (block.type === "text") {
      const replaced = text(block.text);
      if (replaced === block.text) return block;
      changed = true;
      return { ...block, text: replaced };
    }
    if (block.type === "image") {
      changed = true;
      return imageNotice(id);
    }
    return block;
  });
  // Blocks keep their kind, and images only occur where text is also allowed.
  return changed ? (next as ContextEditableContent) : undefined;
}

function elideBlocks(text: string, id: string, minTokens: number): string {
  return text.replace(BLOCK, (block) => {
    const tokens = Math.ceil(block.length / 4);
    return tokens < minTokens
      ? block
      : `[Elided block: about ${tokens} tokens. Call recall with entryId "${id}" to read it.]`;
  });
}

function imageNotice(id: string): TextContent {
  return {
    type: "text",
    text: `[Image elided. Call recall with entryId "${id}" to see its metadata.]`,
  };
}
