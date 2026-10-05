import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Note } from "./background.ts";
import { handoffContext, handoffNote } from "./handoff.ts";

export interface NoteRequest {
  registry: ModelRegistry;
  model: Model<Api>;
  sessionId: string;
  /** The live LLM context, so the provider can reuse its prompt cache. */
  messages: readonly Message[];
  focus?: string;
  signal: AbortSignal;
  maxTokens?: number;
}

/** Asks the session model for a handoff note. Tools stay declared to keep the cached prefix, but tool use is disabled. */
export async function requestNote(
  request: NoteRequest,
): Promise<Note | undefined> {
  const context = handoffContext(request.messages, request.focus);
  const response = await request.registry
    .streamSimple(request.model, context, {
      toolChoice: "none",
      maxTokens: request.maxTokens,
      signal: request.signal,
      sessionId: request.sessionId,
    })
    .result();
  const note = handoffNote(response);
  return note === undefined ? undefined : { note, usage: response.usage };
}
