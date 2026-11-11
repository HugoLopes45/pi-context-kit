import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import {
  applyEdits,
  contextTokens,
  type Edit,
  projectedMessages,
} from "./context.ts";
import type { ContextKitConfig } from "./config.ts";
import { pruneToolOutputs } from "./prune.ts";
import { type ShakeOptions, shake } from "./shake.ts";
import { supersededReads } from "./stale.ts";

export type MaintenanceOptions = Pick<
  ContextKitConfig,
  "supersedeReads" | "prune" | "progressRatio"
> & {
  /** Undefined leaves the context unshaken. */
  shake: ShakeOptions | undefined;
};

export interface MaintenanceInput {
  entries: readonly ProjectedSessionEntry[];
  edited: ReadonlySet<string>;
  options: MaintenanceOptions;
  /** Pi's current context estimate. */
  tokens: number;
  /** Compaction runs above this many tokens. */
  threshold: number;
}

export interface MaintenancePlan {
  edits: Edit[];
  /** Pi's context estimate after the edits. */
  tokens: number;
}

/**
 * Plans context edits for one turn boundary. Any context edit changes the prompt prefix, so the
 * provider cache and, on Anthropic, the thinking blocks after the edit are lost. Edits are
 * therefore made only above the compaction threshold, in one batch.
 */
export function planMaintenance(input: MaintenanceInput): MaintenancePlan {
  const { options } = input;
  const unchanged = { edits: [], tokens: input.tokens };
  if (input.tokens <= input.threshold) return unchanged;

  const stale = options.supersedeReads
    ? supersededReads(input.entries, input.edited)
    : [];
  const afterStale = applyEdits(input.entries, stale);

  const edited = new Set([
    ...input.edited,
    ...stale.map((edit) => edit.targetId),
  ]);
  const pruned = options.prune.enabled
    ? pruneToolOutputs(afterStale, edited, options.prune)
    : [];
  const afterPrune = applyEdits(afterStale, pruned);
  const shaken = options.shake ? shake(afterPrune, options.shake) : [];
  const reducedTokens = contextTokens(
    projectedMessages(applyEdits(afterPrune, shaken)),
  );
  if (reducedTokens <= input.threshold * options.progressRatio) {
    const edits = latestPerTarget([...stale, ...pruned, ...shaken]);
    return edits.length > 0 ? { edits, tokens: reducedTokens } : unchanged;
  }
  // Compaction runs next. Stale edits only shrink what it has to summarize.
  return stale.length > 0
    ? { edits: stale, tokens: contextTokens(projectedMessages(afterStale)) }
    : unchanged;
}

function latestPerTarget(edits: readonly Edit[]): Edit[] {
  return [...new Map(edits.map((edit) => [edit.targetId, edit])).values()];
}
