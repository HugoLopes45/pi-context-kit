import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Note } from "./background.ts";
import { handoffContext, handoffNote } from "./handoff.ts";

export interface NoteRequest {
  registry: ModelRegistry;
  model: Model<Api>;
  sessionId: string;
  /** Live context without reserialization; prompt-cache reuse is provider-dependent. */
  messages: readonly Message[];
  focus?: string;
  signal: AbortSignal;
  maxTokens?: number;
}

/** Keeps tool declarations unchanged for providers that cache them, but disables tool use. */
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
