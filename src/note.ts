import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Note } from "./background.ts";
import { handoffContext, handoffNote } from "./handoff.ts";

export interface NoteRequest {
  registry: ModelRegistry;
  model: Model<Api>;
  sessionId: string;
  /** Live context without reserialization; prompt-cache reuse is provider-dependent. */
  messages: readonly Message[];
  /** The session's level: Anthropic drops the cached messages when thinking differs. */
  reasoning: ThinkingLevel | undefined;
  focus?: string;
  signal: AbortSignal;
  maxTokens?: number;
}

/** Sends the turn's tool_choice too: Anthropic drops the cached messages when it differs. */
export async function requestNote(
  request: NoteRequest,
): Promise<Note | undefined> {
  const context = handoffContext(request.messages, request.focus);
  const response = await request.registry
    .streamSimple(request.model, context, {
      reasoning: request.reasoning,
      maxTokens: request.maxTokens,
      signal: request.signal,
      sessionId: request.sessionId,
    })
    .result();
  const note = handoffNote(response);
  return note === undefined ? undefined : { note, usage: response.usage };
}
