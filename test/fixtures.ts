import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let clock = 1_700_000_000_000;
let callCounter = 0;

/** A session built through Pi's real SessionManager. */
export class Transcript {
  readonly session = SessionManager.inMemory("/tmp");

  user(text: string): string {
    return this.session.appendMessage({
      role: "user",
      content: text,
      timestamp: clock++,
    });
  }

  assistant(text: string): string {
    return this.session.appendMessage(
      assistantMessage([{ type: "text", text }]),
    );
  }

  /** Appends one assistant tool call and its result; returns the result entry ID. */
  tool(
    name: string,
    args: Record<string, string | number>,
    output: string | (TextContent | ImageContent)[],
    isError = false,
  ): string {
    const id = `call_${++callCounter}`;
    this.session.appendMessage(
      assistantMessage([{ type: "toolCall", id, name, arguments: args }]),
    );
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content:
        typeof output === "string" ? [{ type: "text", text: output }] : output,
      isError,
      timestamp: clock++,
    };
    return this.session.appendMessage(result);
  }

  entries() {
    return this.session.buildSessionProjection().entries;
  }

  branch() {
    return this.session.getBranch();
  }
}

function assistantMessage(
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: clock++,
  };
}

/** Text of roughly `tokens` tokens under Pi's chars/4 estimate. */
export function filler(tokens: number, seed = "x"): string {
  return seed.repeat(tokens * 4);
}
