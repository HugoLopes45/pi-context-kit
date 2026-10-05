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
  settled: boolean;
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
    const note = run(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onError(error);
        return undefined;
      })
      .finally(() => {
        job.settled = true;
      });
    const job: Job = { epoch, leafId, controller, note, settled: false };
    this.#job = job;
    return true;
  }

  /** Whether the note of this epoch is still being written. */
  writing(epoch: string | null): boolean {
    return this.#job?.epoch === epoch && !this.#job.settled;
  }

  /** Returns a finished note only when it still covers a prefix of the branch. */
  async takeReady(
    epoch: string | null,
    branch: readonly SessionEntry[],
  ): Promise<BackgroundNote | undefined> {
    const job = this.#job;
    if (
      !job ||
      !job.settled ||
      job.epoch !== epoch ||
      !branch.some((entry) => entry.id === job.leafId)
    ) {
      return undefined;
    }
    const note = await job.note;
    return note && { ...note, leafId: job.leafId };
  }

  /** Cancels work tied to a branch that is no longer active. */
  invalidate(epoch: string | null, branch: readonly SessionEntry[]): void {
    if (
      this.#job &&
      (this.#job.epoch !== epoch ||
        !branch.some((entry) => entry.id === this.#job?.leafId))
    ) {
      this.cancel();
    }
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
