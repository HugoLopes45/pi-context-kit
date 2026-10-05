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
  findCutPoint,
  getLatestCompactionEntry,
  type SessionEntry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  BackgroundHandoff,
  type BackgroundNote,
  firstEntryAfter,
  type Note,
} from "../src/background.ts";
import {
  type ContextKitConfig,
  type Method,
  ownThreshold,
  readConfig,
  speculationLead,
} from "../src/config.ts";
import {
  applyEdits,
  contextTokens,
  editedEntryIds,
  projectedMessages,
  toDrafts,
} from "../src/context.ts";
import { handoffSummary } from "../src/handoff.ts";
import { planMaintenance } from "../src/maintain.ts";
import { requestNote } from "../src/note.ts";
import { readEntry, searchEntries } from "../src/recall.ts";

// One closure per session: Pi and pi-subagents load the extension once per session in the same process.
export default function contextKit(pi: ExtensionAPI): void {
  const background = new BackgroundHandoff();
  let reported = "";
  /** The compaction epoch in which a threshold note failed, so it is not retried every turn. */
  let failedEpoch: string | null | undefined;

  /** Reads `contextKit` from Pi's settings on each use, so `/reload` and project settings apply. */
  const settings = (ctx: ExtensionContext): ContextKitConfig => {
    const { config, problems } = readConfig(
      Reflect.get(pi.getSettings(), "contextKit"),
    );
    const message = problems.join("; ");
    if (message && message !== reported)
      ctx.ui.notify(
        `pi-context-kit: invalid settings, defaults used (${message}).`,
        "warning",
      );
    reported = message;
    return config;
  };

  const compactionSettings = (model: Model<Api>) =>
    SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(model);

  /** Pi compacts above this many tokens, using the same settings lookup as Pi. */
  const piThreshold = (model: Model<Api> | undefined): number => {
    if (!model || model.contextWindow <= 0) return Number.POSITIVE_INFINITY;
    const compaction = compactionSettings(model);
    return compaction.enabled
      ? model.contextWindow - compaction.reserveTokens
      : Number.POSITIVE_INFINITY;
  };

  /** Pi still compacts at its own threshold, so a configured threshold can only come earlier. */
  const threshold = (
    model: Model<Api> | undefined,
    config: ContextKitConfig,
  ): number => {
    const piLimit = piThreshold(model);
    return model && piLimit < Number.POSITIVE_INFINITY
      ? Math.min(piLimit, ownThreshold(config, model.contextWindow))
      : piLimit;
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

  /**
   * Builds a handoff compaction. A background note keeps everything after its leaf. A new note
   * covers the whole context and keeps from `keptEntryId`, so the latest work stays visible.
   */
  const handoff = async (input: {
    ctx: ExtensionContext;
    model: Model<Api>;
    config: ContextKitConfig;
    branch: SessionEntry[];
    ready: BackgroundNote | undefined;
    keptEntryId: string;
    limit: number;
    /** Undefined when only the background note may be used. */
    messages: Message[] | undefined;
    focus?: string;
    signal: AbortSignal;
  }) => {
    const { ctx, branch, ready } = input;
    const compaction = (note: Note, firstKeptEntryId: string) => ({
      ...handoffSummary(note.note, branch),
      firstKeptEntryId,
      usage: note.usage,
    });
    if (ready) {
      const result = compaction(
        ready,
        firstEntryAfter(branch, ready.leafId) ?? input.keptEntryId,
      );
      const kept = keptTokens(ctx, result.firstKeptEntryId);
      if (fits(result.summary, kept, input.limit, input.config.progressRatio))
        return result;
    }
    if (!input.messages) return undefined;
    const note = await requestNote({
      registry: ctx.modelRegistry,
      model: input.model,
      sessionId: ctx.sessionManager.getSessionId(),
      messages: input.messages,
      focus: input.focus,
      signal: input.signal,
    });
    return note && compaction(note, input.keptEntryId);
  };

  pi.on("turn_end", async (event, ctx) => {
    const config = settings(ctx);
    if (!config.enabled) return undefined;
    const model = ctx.model;
    const limit = threshold(model, config);
    const methods = config.methodOrder;
    const entries = event.context.contextEntries;
    const branch = ctx.sessionManager.getBranch();
    const edited = editedEntryIds(branch);
    const tokens =
      ctx.getContextUsage()?.tokens ??
      contextTokens(projectedMessages(entries));
    const plan = (shake: boolean) =>
      planMaintenance({
        entries,
        edited,
        options: { ...config, shake: shake ? config.shake : undefined },
        tokens,
        threshold: limit,
      });
    const shakeFirst = before(methods, "shake", "handoff");
    let result = plan(shakeFirst);
    const drafts = () => toDrafts(result.edits);

    const leafId = ctx.sessionManager.getLeafId();
    const current = epoch(branch);
    // Pi compacts at its own threshold, through session_before_compact.
    const own = limit < piThreshold(model) && result.tokens > limit;
    if (model && leafId && before(methods, "handoff", "soft")) {
      const messages = () =>
        convertToLlm(projectedMessages(applyEdits(entries, result.edits)));
      if (
        config.asyncEnabled &&
        result.tokens > limit - speculationLead(limit) &&
        result.tokens <= limit
      ) {
        const context = messages();
        background.start(
          current,
          leafId,
          (signal) =>
            requestNote({
              registry: ctx.modelRegistry,
              model,
              sessionId: ctx.sessionManager.getSessionId(),
              messages: context,
              signal,
            }),
          (error) => warn(ctx, error, "A new note is written at compaction."),
        );
      }
      const keptEntryId =
        own && recentStart(branch, compactionSettings(model).keepRecentTokens);
      if (own && keptEntryId && failedEpoch !== current) {
        // The note being written lands at a later turn; Pi's threshold still bounds the wait.
        if (background.writing(current)) return { entries: drafts() };
        const signal = ctx.signal ?? new AbortController().signal;
        try {
          const compaction = await handoff({
            ctx,
            model,
            config,
            branch,
            ready: await background.take(current, branch, signal),
            keptEntryId,
            limit,
            messages: messages(),
            signal,
          });
          if (compaction) {
            background.cancel();
            return {
              entries: [...drafts(), { type: "compaction", ...compaction }],
            };
          }
          failedEpoch = current;
        } catch (error) {
          failedEpoch = current;
          if (!signal.aborted)
            warn(ctx, error, "Pi compacts at its own threshold instead.");
        }
      }
    }
    if (own && !shakeFirst && methods.includes("shake")) result = plan(true);
    return result.edits.length > 0 ? { entries: drafts() } : undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    const config = settings(ctx);
    if (
      !model ||
      !config.enabled ||
      !before(config.methodOrder, "handoff", "soft")
    )
      return undefined;
    const { preparation, branchEntries, signal } = event;
    const limit = Math.min(threshold(model, config), model.contextWindow);
    try {
      const compaction = await handoff({
        ctx,
        model,
        config,
        branch: branchEntries,
        // A focused /compact needs a note written for that focus.
        ready: event.customInstructions
          ? undefined
          : await background.take(epoch(branchEntries), branchEntries, signal),
        keptEntryId: preparation.firstKeptEntryId,
        limit,
        // The live context no longer fits the model after an overflow.
        messages: event.reason === "overflow" ? undefined : liveMessages(ctx),
        focus: event.customInstructions,
        signal,
      });
      return (
        compaction && {
          compaction: { ...compaction, tokensBefore: preparation.tokensBefore },
        }
      );
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

function fits(
  summary: string,
  kept: number,
  limit: number,
  ratio: number,
): boolean {
  return Math.ceil(summary.length / 4) + kept <= limit * ratio;
}

/** Whether `a` comes first in `methods`, or `b` is absent. */
function before(methods: readonly Method[], a: Method, b: Method): boolean {
  const index = methods.indexOf(a);
  const other = methods.indexOf(b);
  return index >= 0 && (other < 0 || index < other);
}

/** Where Pi would start the kept part: about `keepRecentTokens` back, after the latest compaction. */
function recentStart(
  branch: SessionEntry[],
  keepRecentTokens: number,
): string | undefined {
  const latest = getLatestCompactionEntry(branch);
  const start = latest ? branch.indexOf(latest) + 1 : 0;
  const cut = findCutPoint(branch, start, branch.length, keepRecentTokens);
  return branch[cut.firstKeptEntryIndex]?.id;
}
