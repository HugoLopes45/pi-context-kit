import {
  type Api,
  type Message,
  type Model,
  Type,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  getLatestCompactionEntry,
  type SessionEntry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BackgroundHandoff, firstEntryAfter } from "../src/background.ts";
import {
  applyEdits,
  contextTokens,
  editedEntryIds,
  projectedMessages,
  toDrafts,
} from "../src/context.ts";
import { handoffSummary } from "../src/handoff.ts";
import { PROGRESS_RATIO, planMaintenance } from "../src/maintain.ts";
import { requestNote } from "../src/note.ts";
import { readEntry, searchEntries } from "../src/recall.ts";

/** Start the background handoff this many tokens before Pi's compaction threshold. */
const BACKGROUND_TOKENS = 32_768;

export default function contextKit(pi: ExtensionAPI): void {
  const background = new BackgroundHandoff();

  /** Pi compacts above this many tokens, using the same settings lookup as Pi. */
  const threshold = (model: Model<Api> | undefined): number => {
    if (!model || model.contextWindow <= 0) return Number.POSITIVE_INFINITY;
    const settings = SettingsManager.inMemory(
      pi.getSettings(),
    ).getCompactionSettings(model);
    return settings.enabled
      ? model.contextWindow - settings.reserveTokens
      : Number.POSITIVE_INFINITY;
  };

  const epoch = (branch: SessionEntry[]) =>
    getLatestCompactionEntry(branch)?.id ?? null;

  const warn = (ctx: ExtensionContext, error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `pi-context-kit: handoff note failed (${message}). ${fallback}`,
      "warning",
    );
  };

  pi.on("turn_end", (event, ctx) => {
    const model = ctx.model;
    const limit = threshold(model);
    const entries = event.context.contextEntries;
    const branch = ctx.sessionManager.getBranch();
    const tokens =
      ctx.getContextUsage()?.tokens ??
      contextTokens(projectedMessages(entries));
    const plan = planMaintenance({
      entries,
      edited: editedEntryIds(branch),
      tokens,
      threshold: limit,
    });

    const leafId = ctx.sessionManager.getLeafId();
    if (
      model &&
      leafId &&
      plan.tokens > limit - BACKGROUND_TOKENS &&
      plan.tokens <= limit
    ) {
      const messages = convertToLlm(
        projectedMessages(applyEdits(entries, plan.edits)),
      );
      background.start(
        epoch(branch),
        leafId,
        (signal) =>
          requestNote({
            registry: ctx.modelRegistry,
            model,
            sessionId: ctx.sessionManager.getSessionId(),
            messages,
            signal,
          }),
        (error) => warn(ctx, error, "A new note is written at compaction."),
      );
    }
    return plan.edits.length > 0
      ? { entries: toDrafts(plan.edits) }
      : undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return undefined;
    const { preparation, branchEntries, signal } = event;
    const limit = Math.min(threshold(model), model.contextWindow);

    // A focused /compact needs a note written for that focus.
    const ready = event.customInstructions
      ? undefined
      : await background.take(epoch(branchEntries), branchEntries, signal);
    // The note covers everything up to its leaf, so the kept part must start right after it.
    const firstKeptEntryId =
      ready && firstEntryAfter(branchEntries, ready.leafId);
    if (ready && firstKeptEntryId) {
      const { summary, details } = handoffSummary(ready.note, branchEntries);
      if (fits(summary, keptTokens(ctx, firstKeptEntryId), limit)) {
        return {
          compaction: {
            summary,
            firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details,
            usage: ready.usage,
          },
        };
      }
    }
    // The live context no longer fits the model after an overflow.
    if (event.reason === "overflow") return undefined;

    try {
      const note = await requestNote({
        registry: ctx.modelRegistry,
        model,
        sessionId: ctx.sessionManager.getSessionId(),
        messages: liveMessages(ctx),
        focus: event.customInstructions,
        signal,
      });
      if (!note) return undefined;
      const { summary, details } = handoffSummary(note.note, branchEntries);
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details,
          usage: note.usage,
        },
      };
    } catch (error) {
      if (!signal.aborted) warn(ctx, error, "Pi's summary is used instead.");
      return undefined;
    }
  });

  pi.on("session_compact", () => background.cancel());
  pi.on("session_shutdown", () => background.cancel());

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search or read the full session history, including messages removed by compaction and tool outputs that were pruned or elided. " +
      "Pass `query` to list matching entries with their IDs, newest first. Pass `entryId` to read one entry in full.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Text to find, case-insensitive." }),
      ),
      regex: Type.Optional(
        Type.Boolean({ description: "Treat query as a regular expression." }),
      ),
      entryId: Type.Optional(
        Type.String({ description: "ID of the entry to read." }),
      ),
      offset: Type.Optional(
        Type.Number({
          description:
            "Matches or characters to skip, as given in the previous result.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum matches or characters to return.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      let text: string;
      if (params.entryId) text = readEntry(branch, params.entryId, params);
      else if (params.query)
        text = searchEntries(branch, { ...params, query: params.query });
      else throw new Error("Pass query or entryId.");
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

function liveMessages(ctx: ExtensionContext): Message[] {
  return convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
}

/** Tokens of the system prompt plus the projected context from `firstKeptEntryId` on. */
function keptTokens(ctx: ExtensionContext, firstKeptEntryId: string): number {
  const entries = ctx.sessionManager.buildSessionProjection().entries;
  const start = entries.findIndex(
    (entry) => entry.sourceEntry.id === firstKeptEntryId,
  );
  if (start < 0) return Number.POSITIVE_INFINITY;
  const system = projectedMessages(entries)
    .filter((message) => message.role === "system")
    .at(-1);
  return contextTokens([
    ...(system ? [system] : []),
    ...projectedMessages(entries.slice(start)),
  ]);
}

function fits(summary: string, kept: number, limit: number): boolean {
  return Math.ceil(summary.length / 4) + kept <= limit * PROGRESS_RATIO;
}
