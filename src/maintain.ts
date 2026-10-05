import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import {
  applyEdits,
  contextTokens,
  type Edit,
  projectedMessages,
} from "./context.ts";
import { DEFAULT_PRUNE, pruneToolOutputs } from "./prune.ts";
import { AUTO_SHAKE, shake } from "./shake.ts";
import { supersededReads } from "./stale.ts";

/** Stale results are edited only near the end of the context, where the prompt cache is not yet reused. */
const STALE_SUFFIX_TOKENS = 8_000;
/** Pruning and shaking must get the context this far below the threshold, or compaction runs instead. */
export const PROGRESS_RATIO = 0.8;

export interface MaintenanceInput {
  entries: readonly ProjectedSessionEntry[];
  edited: ReadonlySet<string>;
  /** Pi's current context estimate. */
  tokens: number;
  /** Pi compacts above this many tokens. */
  threshold: number;
}

export interface MaintenancePlan {
  edits: Edit[];
  /** Pi's context estimate after the edits. */
  tokens: number;
}

/**
 * Plans context edits for one turn boundary. Any context edit makes Pi estimate the context
 * from characters, so edits are kept only when that estimate stays on the same side of the
 * compaction threshold, or when pruning and shaking make compaction unnecessary.
 */
export function planMaintenance(input: MaintenanceInput): MaintenancePlan {
  const unchanged = { edits: [], tokens: input.tokens };
  const stale = supersededReads(
    input.entries,
    input.edited,
    STALE_SUFFIX_TOKENS,
  );
  const afterStale = applyEdits(input.entries, stale);
  const staleTokens = contextTokens(projectedMessages(afterStale));

  if (input.tokens <= input.threshold) {
    return stale.length > 0 && staleTokens <= input.threshold
      ? { edits: stale, tokens: staleTokens }
      : unchanged;
  }

  const edited = new Set([
    ...input.edited,
    ...stale.map((edit) => edit.targetId),
  ]);
  const pruned = pruneToolOutputs(afterStale, edited, DEFAULT_PRUNE);
  const afterPrune = applyEdits(afterStale, pruned);
  const shaken = shake(afterPrune, AUTO_SHAKE);
  const reducedTokens = contextTokens(
    projectedMessages(applyEdits(afterPrune, shaken)),
  );
  if (reducedTokens <= input.threshold * PROGRESS_RATIO) {
    return {
      edits: latestPerTarget([...stale, ...pruned, ...shaken]),
      tokens: reducedTokens,
    };
  }
  // Compaction runs next. Stale edits only shrink what it has to summarize.
  return stale.length > 0 ? { edits: stale, tokens: staleTokens } : unchanged;
}

function latestPerTarget(edits: readonly Edit[]): Edit[] {
  return [...new Map(edits.map((edit) => [edit.targetId, edit])).values()];
}
