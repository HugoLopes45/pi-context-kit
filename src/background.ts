import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface Note {
  note: string;
  usage?: Usage;
}

export interface BackgroundNote extends Note {
  /** The last entry the note covers. */
  leafId: string;
}

interface Job {
  /** ID of the latest compaction when the job started, or null before the first one. */
  epoch: string | null;
  leafId: string;
  controller: AbortController;
  note: Promise<Note | undefined>;
}

/** One speculative handoff note per compaction epoch, written while the agent keeps working. */
export class BackgroundHandoff {
  #job: Job | undefined;

  /** Starts a job unless one already ran in this epoch. */
  start(
    epoch: string | null,
    leafId: string,
    run: (signal: AbortSignal) => Promise<Note | undefined>,
    onError: (error: unknown) => void,
  ): boolean {
    if (this.#job?.epoch === epoch) return false;
    this.cancel();
    const controller = new AbortController();
    const note = run(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) onError(error);
      return undefined;
    });
    this.#job = { epoch, leafId, controller, note };
    return true;
  }

  /** Waits for the note of this epoch if it still covers a prefix of the branch. */
  async take(
    epoch: string | null,
    branch: readonly SessionEntry[],
    signal: AbortSignal,
  ): Promise<BackgroundNote | undefined> {
    const job = this.#job;
    if (
      !job ||
      job.epoch !== epoch ||
      !branch.some((entry) => entry.id === job.leafId)
    ) {
      return undefined;
    }
    const note = await Promise.race([job.note, aborted(signal)]);
    return note && { ...note, leafId: job.leafId };
  }

  cancel(): void {
    this.#job?.controller.abort();
    this.#job = undefined;
  }
}

/** The first entry after `leafId` that may start the kept part of a context. */
export function firstEntryAfter(
  branch: readonly SessionEntry[],
  leafId: string,
): string | undefined {
  const index = branch.findIndex((entry) => entry.id === leafId);
  if (index < 0) return undefined;
  return branch
    .slice(index + 1)
    .find(
      (entry) =>
        entry.type === "custom_message" ||
        (entry.type === "message" && entry.message.role !== "toolResult"),
    )?.id;
}

function aborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    else
      signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
  });
}
