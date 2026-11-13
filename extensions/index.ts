import { existsSync } from "node:fs";
import { type Api, type Message, type Model } from "@earendil-works/pi-ai";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  convertToLlm,
  type CompactionEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
  findCutPoint,
  generateSummaryWithUsage,
  getAgentDir,
  getLatestCompactionEntry,
  getSettingsListTheme,
  type ProjectedSessionEntry,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  SettingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  BackgroundHandoff,
  type BackgroundNote,
  firstEntryAfter,
  type Note,
} from "../src/background.ts";
import {
  before,
  type ContextKitConfig,
  ownThreshold,
  readConfig,
  speculationLead,
  writesHandoff,
} from "../src/config.ts";
import {
  applyEdits,
  contextTokens,
  editedEntryIds,
  projectedMessages,
  toDrafts,
} from "../src/context.ts";
import { handoffSummary } from "../src/handoff.ts";
import { type MaintenancePlan, planMaintenance } from "../src/maintain.ts";
import { requestNote } from "../src/note.ts";
import { migrateLegacy, migrateProject } from "../src/migrate.ts";
import { readEntry, searchEntries } from "../src/recall.ts";
import { panelItems, settingValue, summaryText } from "../src/panel.ts";
import {
  createSettings,
  loadSettings,
  readSettingsFile,
  saveSetting,
  settingsPaths,
} from "../src/settings-file.ts";
import { freedNotice, statusText } from "../src/status.ts";

// One closure per session: Pi and pi-subagents load the extension once per session in the same process.
export default function contextKit(pi: ExtensionAPI): void {
  /** The latest context, so a background note that finishes between turns updates the status. */
  let statusContext: ExtensionContext | undefined;
  const background = new BackgroundHandoff(() => {
    if (!statusContext) return;
    try {
      showStatus(statusContext);
    } catch {
      // Pi throws on a ctx of a replaced session, which has no footer left to update.
      statusContext = undefined;
    }
  });
  let reported = "";
  /** The compaction epoch in which a threshold note failed, so it is not retried every turn. */
  let failedEpoch: string | null | undefined;
  /** The same for Pi's summary at the extension's own threshold. */
  let softFailedEpoch: string | null | undefined;

  const paths = (ctx: ExtensionContext) =>
    settingsPaths(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());

  /** Reads the settings files on each use, so a change applies at the next turn. */
  const settings = (ctx: ExtensionContext): ContextKitConfig => {
    const files = loadSettings(paths(ctx));
    const { config, problems } = readConfig(files.raw);
    const message = [...files.problems, ...problems].join("; ");
    if (message && message !== reported)
      ctx.ui.notify(
        `pi-context-kit settings need attention: ${message}. Type /context-kit to see them.`,
        "warning",
      );
    reported = message;
    return config;
  };

  const reasoning = () => {
    const level = pi.getThinkingLevel();
    return level === "off" ? undefined : level;
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

  const statusOf = (
    ctx: ExtensionContext,
    config: ContextKitConfig,
    tokens: number,
  ) => {
    if (!config.enabled) return "Context cleanup off";
    const model = ctx.model;
    if (!model || model.contextWindow <= 0) return undefined;
    return statusText({
      tokens,
      limit: threshold(model, config),
      contextWindow: model.contextWindow,
      note: background.noteState(epoch(ctx.sessionManager.getBranch())),
    });
  };

  function showStatus(
    ctx: ExtensionContext,
    config = settings(ctx),
    tokens = liveTokens(ctx),
  ) {
    statusContext = ctx;
    ctx.ui.setStatus("context-kit", statusOf(ctx, config, tokens));
  }

  /** Pi shows compactions but not context edits, so the user learns about them here. */
  const persist = (turn: Turn) => {
    const output = persisted(turn.result, turn.limit);
    // Both counts use the same estimate; Pi's usage count is not comparable.
    const count = (edits: MaintenancePlan["edits"]) =>
      contextTokens(projectedMessages(applyEdits(turn.entries, edits)));
    // Maintenance needs a model with a context window, so `window` is set whenever `output` is.
    const window = turn.ctx.model?.contextWindow;
    if (output && window)
      turn.ctx.ui.notify(
        freedNotice(count([]), count(turn.result.edits), window),
        "info",
      );
    showStatus(turn.ctx, turn.config, turn.result.tokens);
    return output;
  };

  const warn = (
    ctx: ExtensionContext,
    error: unknown,
    fallback: string,
    what = "handoff note",
  ) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `pi-context-kit: ${what} failed (${message}). ${fallback}`,
      "warning",
    );
  };

  /** Pi's summary at the extension's threshold, because Pi's own hook waits for Pi's threshold. */
  const soft = async (input: {
    ctx: ExtensionContext;
    model: Model<Api>;
    config: ContextKitConfig;
    branch: SessionEntry[];
    entries: Parameters<typeof projectedMessages>[0];
    limit: number;
  }) => {
    const { ctx, model, config, limit } = input;
    const { keepRecentTokens, reserveTokens } = compactionSettings(model);
    const keptEntryId = recentStart(ctx, keepRecentTokens);
    if (!keptEntryId) return undefined;
    const retained = keptTokens(ctx, keptEntryId);
    if (!fits("", retained, limit, config.progressRatio)) return undefined;
    const start = input.entries.findIndex(
      (entry) => entry.sourceEntry.id === keptEntryId,
    );
    // As in Pi, the previous summary goes to the update prompt, not into the history.
    const previous = input.entries.findIndex(
      (entry) =>
        entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
    );
    if (start <= previous + 1) return undefined;
    const source = input.entries[previous]?.sourceEntry;
    const { text, usage } = await generateSummaryWithUsage(
      projectedMessages(input.entries.slice(previous + 1, start)),
      model,
      reserveTokens,
      undefined,
      undefined,
      ctx.signal,
      undefined,
      source?.type === "compaction" ? source.summary : undefined,
      pi.getThinkingLevel(),
      // The registry resolves auth per request, as for handoff notes.
      (model, context, options) =>
        ctx.modelRegistry.streamSimple(model, context, options),
      undefined,
      undefined,
      undefined,
      ctx.sessionManager.getSessionId(),
    );
    const summary = handoffSummary(text, input.branch);
    return fits(summary.summary, retained, limit, config.progressRatio)
      ? { ...summary, firstKeptEntryId: keptEntryId, usage }
      : undefined;
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
    cancelBackground: () => void;
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
    const retained = keptTokens(ctx, input.keptEntryId);
    const availableTokens = Math.floor(
      input.limit * input.config.progressRatio - retained,
    );
    if (!input.messages || availableTokens <= 0) {
      input.cancelBackground();
      return undefined;
    }
    input.cancelBackground();
    const note = await requestNote({
      registry: ctx.modelRegistry,
      model: input.model,
      sessionId: ctx.sessionManager.getSessionId(),
      messages: input.messages,
      reasoning: reasoning(),
      focus: input.focus,
      signal: input.signal,
      maxTokens: Math.min(input.model.maxTokens, availableTokens),
    });
    if (!note) return undefined;
    const result = compaction(note, input.keptEntryId);
    return fits(
      result.summary,
      retained,
      input.limit,
      input.config.progressRatio,
    )
      ? result
      : undefined;
  };

  /** Starts a background note shortly before the threshold, so compaction need not wait for one. */
  const speculate = (
    turn: Turn,
    leafId: string,
    keptEntryId: string | undefined,
    messages: () => Message[],
  ) => {
    const { ctx, config, model, limit, result } = turn;
    if (!config.background || !keptEntryId) return;
    if (result.tokens <= limit - speculationLead(limit)) return;
    if (result.tokens > limit) return;
    const budget = Math.floor(
      limit * config.progressRatio - keptTokens(ctx, keptEntryId),
    );
    if (budget <= 0) return;
    const context = messages();
    const maxTokens = Math.min(model.maxTokens, budget);
    background.start(
      turn.current,
      leafId,
      (signal) =>
        requestNote({
          registry: ctx.modelRegistry,
          model,
          sessionId: ctx.sessionManager.getSessionId(),
          messages: context,
          reasoning: reasoning(),
          signal,
          maxTokens,
        }),
      (error) => warn(ctx, error, "A new note is written at compaction."),
    );
  };

  /** `"waiting"` means a background note is still being written for this threshold. */
  const handoffAtTurn = async (turn: Turn) => {
    const { ctx, model, limit, current, result } = turn;
    const leafId = ctx.sessionManager.getLeafId();
    if (!leafId) return undefined;
    const messages = () =>
      convertToLlm(projectedMessages(applyEdits(turn.entries, result.edits)));
    const recent = recentStart(ctx, compactionSettings(model).keepRecentTokens);
    speculate(turn, leafId, recent, messages);
    if (result.tokens <= limit || !recent || failedEpoch === current)
      return undefined;
    const writing = background.writing(current);
    if (writing && limit < piThreshold(model)) return "waiting" as const;
    return tryHandoff(turn, recent, writing ? undefined : messages);
  };

  const tryHandoff = async (
    turn: Turn,
    keptEntryId: string,
    messages: (() => Message[]) | undefined,
  ) => {
    const { ctx, current } = turn;
    const signal = ctx.signal ?? new AbortController().signal;
    try {
      const compaction = await handoff({
        ctx,
        model: turn.model,
        config: turn.config,
        branch: turn.branch,
        ready: await background.takeReady(current, turn.branch),
        keptEntryId,
        limit: turn.limit,
        messages: messages?.(),
        signal,
        cancelBackground: () => background.cancel(),
      });
      if (compaction) {
        background.cancel();
        return compacted(turn.result, compaction);
      }
    } catch (error) {
      if (!signal.aborted)
        warn(ctx, error, "The next methods of the strategy are tried.");
    }
    failedEpoch = current;
    return undefined;
  };

  const softAtTurn = async (turn: Turn) => {
    const { ctx, model, limit, current, result } = turn;
    const due =
      result.tokens > limit &&
      limit < piThreshold(model) &&
      turn.config.methodOrder.includes("soft") &&
      softFailedEpoch !== current;
    if (!due) return undefined;
    try {
      const compaction = await soft({
        ctx,
        model,
        config: turn.config,
        branch: turn.branch,
        entries: applyEdits(turn.entries, result.edits),
        limit,
      });
      if (compaction) return compacted(result, compaction);
    } catch (error) {
      if (!ctx.signal?.aborted)
        warn(ctx, error, "Pi compacts at its own threshold.", "Pi's summary");
    }
    softFailedEpoch = current;
    return undefined;
  };

  pi.on("turn_end", async (event, ctx) => {
    const config = settings(ctx);
    if (!config.enabled) {
      showStatus(ctx, config);
      return undefined;
    }
    const branch = ctx.sessionManager.getBranch();
    const current = epoch(branch);
    background.invalidate(current, branch);
    const model = ctx.model;
    // Without a model the threshold is infinite, so maintenance plans no edits.
    if (!model) return undefined;
    const limit = threshold(model, config);
    const methods = config.methodOrder;
    const entries = event.context.contextEntries;
    const tokens = currentTokens(ctx, entries);
    const edited = editedEntryIds(branch);
    const plan = (shake: boolean) =>
      planMaintenance({
        entries,
        edited,
        options: { ...config, shake: shake ? config.shake : undefined },
        tokens,
        threshold: limit,
      });
    const shakeFirst = before(methods, "shake", "handoff");
    const turn: Turn = {
      ctx,
      config,
      model,
      limit,
      entries,
      branch,
      current,
      result: plan(shakeFirst),
    };

    // Try ordered strategies at Pi's threshold before its native hook can compact.
    const handed = before(methods, "handoff", "soft")
      ? await handoffAtTurn(turn)
      : undefined;
    if (handed === "waiting") return persist(turn);
    if (handed) return handed;
    if (
      turn.result.tokens > limit &&
      !shakeFirst &&
      before(methods, "shake", "soft")
    )
      turn.result = plan(true);
    return (await softAtTurn(turn)) ?? persist(turn);
  });

  const handoffBeforeCompact = async (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    model: Model<Api>,
    config: ContextKitConfig,
  ) => {
    const { preparation, branchEntries, customInstructions } = event;
    const current = epoch(branchEntries);
    background.invalidate(current, branchEntries);
    const writing = !customInstructions && background.writing(current);
    const compaction = await handoff({
      ctx,
      model,
      config,
      branch: branchEntries,
      // A focused /compact needs a note written for that focus.
      ready: customInstructions
        ? undefined
        : await background.takeReady(current, branchEntries),
      keptEntryId: preparation.firstKeptEntryId,
      limit: Math.min(threshold(model, config), model.contextWindow),
      // The live context no longer fits the model after an overflow.
      messages:
        event.reason === "overflow" || writing ? undefined : liveMessages(ctx),
      focus: customInstructions,
      signal: event.signal,
      cancelBackground: () => background.cancel(),
    });
    return (
      compaction && {
        compaction: { ...compaction, tokensBefore: preparation.tokensBefore },
      }
    );
  };

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    const config = settings(ctx);
    if (!model || !handoffEnabled(config)) return undefined;
    const failed = failedEpoch === epoch(event.branchEntries);
    if (event.reason === "threshold" && failed) return undefined;
    try {
      return await handoffBeforeCompact(event, ctx, model, config);
    } catch (error) {
      if (!event.signal.aborted)
        warn(ctx, error, "Pi's summary is used instead.");
      return undefined;
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    background.invalidate(epoch(branch), branch);
    showStatus(ctx);
  });
  /** Writes the 0.3 settings of each scope to its own file, unless that file exists. */
  const migrate = (ctx: ExtensionContext) => {
    const { global, project } = paths(ctx);
    const piSettings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    // Pi reports its own unreadable settings. The project file depends on the global block, so
    // neither moves until Pi reads both.
    if (piSettings.drainErrors().length > 0) return;
    const oldGlobal: unknown = Reflect.get(
      piSettings.getGlobalSettings(),
      "contextKit",
    );
    const oldProject: unknown = Reflect.get(
      piSettings.getProjectSettings(),
      "contextKit",
    );
    const scopes = [
      { old: oldGlobal, file: global, content: () => migrateLegacy(oldGlobal) },
      {
        old: oldProject,
        file: project,
        // Runs after the global file is written, which the project file then overrides.
        content: () =>
          migrateProject(oldGlobal, oldProject, readSettingsFile(global)),
      },
    ];
    for (const { old, file, content } of scopes) {
      if (old === undefined || !file) continue;
      try {
        if (!createSettings(file, content())) continue;
      } catch (error) {
        warn(ctx, error, "Defaults apply until it works.", `saving ${file}`);
        // The project file depends on the global file, so both wait for the next start.
        return;
      }
      ctx.ui.notify(
        `pi-context-kit moved its settings to ${file}. The "contextKit" entry in Pi's settings.json is no longer used.`,
        "info",
      );
    }
  };

  pi.on("session_start", (_event, ctx) => {
    migrate(ctx);
    showStatus(ctx);
  });
  // A compaction returned from turn_end emits no session_compact.
  pi.on("agent_end", (_event, ctx) => showStatus(ctx));
  pi.on("session_compact", (_event, ctx) => {
    background.cancel();
    showStatus(ctx);
  });
  pi.on("session_shutdown", () => {
    background.cancel();
    statusContext = undefined;
  });

  /** Returns whether the setting was saved. */
  const choose = (ctx: ExtensionContext, id: string, value: string) => {
    try {
      saveSetting(paths(ctx), id, settingValue(id, value));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-context-kit: ${message}`, "error");
      return false;
    } finally {
      showStatus(ctx);
    }
  };

  const panelHeader = (ctx: ExtensionContext, theme: Theme) => {
    const status = statusOf(ctx, settings(ctx), liveTokens(ctx)) ?? "";
    const { global, project } = paths(ctx);
    const files =
      project && existsSync(project)
        ? `${global}, and for this project ${project}`
        : global;
    return `${theme.fg("accent", theme.bold("pi-context-kit"))}  ${status}\n${theme.fg("dim", `Saved in ${files}`)}`;
  };

  pi.registerCommand("context-kit", {
    description: "Show and change pi-context-kit settings",
    handler: async (_args, ctx) => {
      // The settings warning points here, so it shows again.
      reported = "";
      const config = settings(ctx);
      if (ctx.mode !== "tui") {
        ctx.ui.notify(summaryText(config, paths(ctx).global), "info");
        return;
      }
      await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => {
        const items = panelItems(config);
        const saved = new Map<string, string>(
          items.map((item) => [item.id, item.currentValue]),
        );
        const header = new Text(panelHeader(ctx, theme));
        const list = new SettingsList(
          items,
          items.length,
          getSettingsListTheme(),
          (id, value) => {
            // The list shows the new value before this runs.
            if (choose(ctx, id, value)) saved.set(id, value);
            else list.updateValue(id, saved.get(id) ?? value);
            header.setText(panelHeader(ctx, theme));
          },
          () => done(undefined),
        );
        const container = new Container();
        container.addChild(header);
        container.addChild(list);
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search or read earlier text on the current session branch, including messages removed by compaction and tool outputs that were pruned or elided. " +
      "Other branches are excluded. Images are represented only by MIME type. " +
      "Pass `query` to list matching entries with their IDs, newest first. Pass `entryId` to read one entry's text, with pagination for large entries.",
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      let text: string;
      if (params.entryId) text = readEntry(branch, params.entryId, params);
      else if (params.query)
        text = await searchEntries(
          branch,
          { ...params, query: params.query },
          signal,
        );
      else throw new Error("Pass query or entryId.");
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

/** One turn boundary's inputs and its current maintenance plan. */
interface Turn {
  ctx: ExtensionContext;
  config: ContextKitConfig;
  model: Model<Api>;
  limit: number;
  entries: ProjectedSessionEntry[];
  branch: SessionEntry[];
  current: string | null;
  result: MaintenancePlan;
}

// Without compaction, edits that leave the context above the threshold break the cache again next turn.
function persisted(result: MaintenancePlan, limit: number) {
  return result.edits.length > 0 && result.tokens <= limit
    ? { entries: toDrafts(result.edits) }
    : undefined;
}

function compacted(
  result: MaintenancePlan,
  compaction: Omit<CompactionEntryDraft, "type">,
) {
  return {
    entries: [
      ...toDrafts(result.edits),
      { type: "compaction" as const, ...compaction },
    ],
  };
}

function currentTokens(
  ctx: ExtensionContext,
  entries: readonly ProjectedSessionEntry[],
): number {
  return (
    ctx.getContextUsage()?.tokens ?? contextTokens(projectedMessages(entries))
  );
}

function handoffEnabled(config: ContextKitConfig): boolean {
  return config.enabled && writesHandoff(config.methodOrder);
}

function liveTokens(ctx: ExtensionContext): number {
  return ctx.getContextUsage()?.tokens ?? contextTokens(liveMessages(ctx));
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

/** Finds the retained boundary from model-visible entries, including prior compaction tails and edits. */
function recentStart(
  ctx: ExtensionContext,
  keepRecentTokens: number,
): string | undefined {
  const entries: SessionEntry[] = [];
  for (const projected of ctx.sessionManager.buildSessionProjection().entries) {
    const source = projected.sourceEntry;
    if (source.type === "compaction") continue;
    for (const message of projected.messages) {
      if (message.role === "system") continue;
      entries.push({
        type: "message",
        id: source.id,
        parentId: source.parentId,
        timestamp: source.timestamp,
        message,
      });
    }
  }
  const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);
  return entries[cut.firstKeptEntryIndex]?.id;
}
