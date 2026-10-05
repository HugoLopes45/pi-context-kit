import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type FileLists, fileLists, formatFileLists } from "./files.ts";

/** Asks for the sections of Pi's own compaction summary, written from the live context. */
const HANDOFF_PROMPT = `Your context is about to be replaced by a handoff note. Write that note now so you can continue this work without any other memory of the conversation. Do not call tools. Reply with the note only, in markdown, using exactly these sections:

## Goal
What the user is trying to accomplish.

## Constraints & Preferences
- Every requirement and preference the user stated.

## Progress
### Done
- [x] Finished work, with its evidence (commands, results).
### In Progress
- [ ] Current work and its exact state.
### Blocked
- Open issues, if any.

## Key Decisions
- **Decision**: why it was made, and approaches rejected.

## Next Steps
1. The remaining actions, in order.

## Critical Context
- Paths, identifiers, commands, values and error messages needed to continue, quoted exactly.

The most recent messages stay visible after the note, but cover them too. Be dense and specific.`;

/** The live conversation plus a final request for a handoff note, so the cached prefix is reused. */
export function handoffContext(
  messages: readonly Message[],
  focus?: string,
): Context {
  const text = focus?.trim()
    ? `${HANDOFF_PROMPT}\n\nGive extra attention to: ${focus.trim()}`
    : HANDOFF_PROMPT;
  return {
    messages: [
      ...messages,
      {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    ],
  };
}

/** The note in a handoff response. Throws when the request failed. */
export function handoffNote(response: AssistantMessage): string | undefined {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(
      response.errorMessage ?? `Handoff request ${response.stopReason}`,
    );
  }
  const note = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  return note || undefined;
}

/** The compaction summary and details for a note, with Pi's cumulative file sections. */
export function handoffSummary(
  note: string,
  branch: readonly SessionEntry[],
): { summary: string; details: FileLists } {
  const details = fileLists(branch);
  const files = formatFileLists(details);
  return { summary: files ? `${note}\n\n${files}` : note, details };
}
