import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
  fauxToolCall,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const sessions: { dispose(): void }[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.unstubAllEnvs();
});

async function start(
  responses: FauxResponseStep[],
  contextWindow = 200_000,
  compactionEnabled = true,
  contextKit?: unknown,
  keepRecentTokens = 1_000,
  legacyContextKit?: unknown,
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-context-kit-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-context-kit-cwd-"));
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n".repeat(200));
  writeFileSync(join(cwd, "b.ts"), "export const b = 2;\n".repeat(1_000));
  // The extension finds its settings file through Pi's agent directory.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  if (contextKit !== undefined)
    writeFileSync(
      join(agentDir, "context-kit.json"),
      JSON.stringify(contextKit),
    );
  // 0.3 read its settings from Pi's settings file.
  if (legacyContextKit !== undefined)
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ contextKit: legacyContextKit }),
    );
  const faux = fauxProvider({
    models: [
      { id: "faux-1", contextWindow, maxTokens: 4_096, reasoning: true },
    ],
  });
  faux.setResponses(responses);
  const settings = {
    retry: { enabled: false },
    compaction: {
      enabled: compactionEnabled,
      reserveTokens: 1_000,
      keepRecentTokens,
    },
  };
  const settingsManager = SettingsManager.inMemory(settings);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  // Pi 1.0 faux usage counts a session's first prompt as input and cache write; without the cache every version reports the same tokens.
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    streamSimple: (model, context, options) =>
      faux.provider.streamSimple(model, context, {
        ...options,
        cacheRetention: "none",
      }),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      resolve(import.meta.dirname, "../extensions/index.ts"),
    ],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "high",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "edit", "recall"],
  });
  sessions.push(session);
  return { session, faux, cwd, agentDir };
}

describe("pi-context-kit inside Pi", () => {
  it.each([
    ["enabled", true],
    ["disabled", false],
  ])(
    "keeps an older read below the threshold with compaction %s",
    async (_, enabled) => {
      const { session } = await start(
        [
          fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
          fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
          fauxAssistantMessage("done"),
        ],
        200_000,
        enabled,
      );
      await session.prompt("Read a.ts twice");
      expect(
        session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "context_edit"),
      ).toEqual([]);
    },
  );

  it("tells the user about freed tokens and shows the threshold in the status", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { threshold: 8_000, advanced: { methodOrder: [] } },
    );
    const notify = vi.fn();
    const setStatus = vi.fn();
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify,
        setStatus,
      },
    });
    await session.prompt("Read b.ts twice");
    expect(notify.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit freed \d+% of the context \(\d+k? tokens\)\. The agent can still look up what was removed\.$/,
        ),
        "info",
      ],
    ]);
    expect(setStatus).toHaveBeenLastCalledWith(
      "context-kit",
      expect.stringMatching(/^Context [0-3]% · cleanup at 4%$/),
    );
  });

  it("states the settings with /context-kit outside the TUI", async () => {
    const { session } = await start([], 200_000, true, { strategy: "frugal" });
    const notify = vi.fn();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("/context-kit");
    expect(notify.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit: automatic cleanup at 75% full, with trim first\. Settings: .+context-kit\.json$/,
        ),
        "info",
      ],
    ]);
  });

  it("moves the 0.3 settings of a trusted project to the project file", async () => {
    const { session, cwd, agentDir } = await start([
      fauxAssistantMessage("done"),
    ]);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ contextKit: { methodOrder: ["soft"] } }),
    );
    const notify = vi.fn();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    const file = join(cwd, ".pi", "context-kit.json");
    expect(notify.mock.calls).toEqual([
      [expect.stringContaining(`moved its settings to ${file}.`), "info"],
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      strategy: "pi-summary",
    });
    expect(existsSync(join(agentDir, "context-kit.json"))).toBe(false);
  });

  it("ignores the settings of a project that Pi does not trust", async () => {
    const { session, cwd } = await start([fauxAssistantMessage("done")]);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ contextKit: { methodOrder: ["soft"] } }),
    );
    session.settingsManager.setProjectTrusted(false);
    const notify = vi.fn();
    const setStatus = vi.fn();
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify,
        setStatus,
      },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, ".pi", "context-kit.json"))).toBe(false);
    writeFileSync(
      join(cwd, ".pi", "context-kit.json"),
      JSON.stringify({ enabled: false }),
    );
    await session.prompt("Hi");
    expect(setStatus).toHaveBeenLastCalledWith(
      "context-kit",
      expect.stringMatching(/ · cleanup at 75%$/),
    );
  });

  it("warns when it cannot move the 0.3 settings and moves them at the next start", async () => {
    const { session, agentDir, cwd } = await start(
      [],
      200_000,
      true,
      undefined,
      1_000,
      { thresholdTokens: 8_000 },
    );
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ contextKit: { methodOrder: ["soft"] } }),
    );
    const projectFile = join(cwd, ".pi", "context-kit.json");
    const notify = vi.fn();
    const file = join(agentDir, "context-kit.json");
    // A read-only file where the new file is written first makes the write fail once.
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, "");
    chmodSync(temporary, 0o444);
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [
        expect.stringMatching(
          new RegExp(
            `saving ${file} failed .+Defaults apply until it works\\.`,
          ),
        ),
        "warning",
      ],
    ]);
    expect(existsSync(projectFile)).toBe(false);
    notify.mockClear();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [expect.stringContaining(`moved its settings to ${file}.`), "info"],
      [
        expect.stringContaining(`moved its settings to ${projectFile}.`),
        "info",
      ],
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      threshold: 8_000,
    });
  });

  it("waits to move the 0.3 settings while Pi's settings cannot be read", async () => {
    const { session, agentDir, cwd } = await start([]);
    writeFileSync(join(agentDir, "settings.json"), "{ broken");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ contextKit: { methodOrder: ["soft"] } }),
    );
    const projectFile = join(cwd, ".pi", "context-kit.json");
    const notify = vi.fn();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(projectFile)).toBe(false);
    writeFileSync(join(agentDir, "settings.json"), "{}");
    notify.mockClear();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [
        expect.stringContaining(`moved its settings to ${projectFile}.`),
        "info",
      ],
    ]);
  });

  it("keeps the global 0.3 threshold for a project that did not set one", async () => {
    const { session, cwd } = await start(
      [fauxAssistantMessage("done")],
      200_000,
      true,
      undefined,
      1_000,
      { thresholdPercent: 70 },
    );
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ contextKit: { prune: { enabled: false } } }),
    );
    const statuses: string[] = [];
    const setStatus = (key: string, text: string | undefined) => {
      if (key === "context-kit") statuses.push(text ?? "");
    };
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setStatus },
    });
    expect(
      JSON.parse(readFileSync(join(cwd, ".pi", "context-kit.json"), "utf8")),
    ).toEqual({ advanced: { prune: { enabled: false } } });
    expect(statuses.at(-1)).toMatch(/ · cleanup at 70%$/);
  });

  it("updates the status after a compaction at turn end", async () => {
    // The last reply passes the threshold, so no later turn refreshes the status.
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done ".repeat(5_000)),
    ];
    const reply: FauxResponseStep = (context) =>
      JSON.stringify(context.messages.at(-1)).includes("handoff note")
        ? fauxAssistantMessage("## Goal\nNote")
        : (main.shift() ?? fauxAssistantMessage("extra"));
    const { session } = await start(Array(8).fill(reply), 200_000, true, {
      threshold: 10_000,
      advanced: {
        background: false,
        supersedeReads: false,
        prune: { enabled: false },
      },
    });
    const compacted = () =>
      session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "compaction");
    const statuses: [string, boolean][] = [];
    const setStatus = (key: string, text: string | undefined) => {
      if (key === "context-kit") statuses.push([text ?? "", compacted()]);
    };
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setStatus },
    });
    await session.prompt("Read b.ts and answer");
    expect(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    expect(main).toHaveLength(0);
    expect(statuses.at(-1)).toEqual([
      expect.stringMatching(/^Context \d% · cleanup at 5%$/),
      true,
    ]);
  });

  it("reports an invalid settings file at start and again on /context-kit", async () => {
    const { session, cwd } = await start([], 200_000, true, {});
    const file = join(cwd, ".pi", "context-kit.json");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(file, "{ broken");
    const notify = vi.fn();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("/context-kit");
    const warning = [
      expect.stringMatching(
        /^pi-context-kit settings need attention: .+context-kit\.json is not valid JSON .+, file ignored\. Type \/context-kit to see them\.$/,
      ),
      "warning",
    ];
    expect(notify.mock.calls).toEqual([
      warning,
      warning,
      [expect.stringMatching(/^pi-context-kit: automatic cleanup/), "info"],
    ]);
  });

  it("moves 0.3 settings to context-kit.json once and keeps their behavior", async () => {
    const { session, agentDir } = await start(
      [fauxAssistantMessage("done"), fauxAssistantMessage("done")],
      200_000,
      true,
      undefined,
      1_000,
      { thresholdTokens: 8_000, asyncEnabled: false },
    );
    const notify = vi.fn();
    const setStatus = vi.fn();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("Hi");
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify,
        setStatus,
      },
    });
    await session.prompt("Again");
    // 8,000 of 200,000 tokens.
    expect(setStatus).toHaveBeenLastCalledWith(
      "context-kit",
      expect.stringMatching(/ · cleanup at 4%$/),
    );
    const file = join(agentDir, "context-kit.json");
    expect(notify.mock.calls).toEqual([
      [
        `pi-context-kit moved its settings to ${file}. The "contextKit" entry in Pi's settings.json is no longer used.`,
        "info",
      ],
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      threshold: 8_000,
      advanced: { background: false },
    });
  });

  it("replaces an older read when that brings the context below the threshold", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { threshold: 8_000, advanced: { methodOrder: [] } },
    );
    await session.prompt("Read b.ts twice");
    const edits = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "context_edit");
    expect(edits).toHaveLength(1);
    expect(
      JSON.stringify(session.sessionManager.buildSessionProjection().messages),
    ).toContain("[Superseded by a newer read of this file]");
  });

  it.each([
    [4, 1],
    [10, 0],
  ])(
    "takes threshold %i%% as a share of the context window",
    async (percent, edits) => {
      const { session } = await start(
        [
          fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
          fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
          fauxAssistantMessage("done"),
        ],
        200_000,
        true,
        { threshold: `${percent}%`, advanced: { methodOrder: [] } },
      );
      await session.prompt("Read b.ts twice");
      expect(
        session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "context_edit"),
      ).toHaveLength(edits);
    },
  );

  // An edit without compaction costs the provider cache again at each turn above the threshold.
  it("keeps an older read above the threshold when nothing compacts", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { threshold: 1_000, advanced: { methodOrder: [] } },
    );
    await session.prompt("Read a.ts twice");
    expect(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "context_edit"),
    ).toEqual([]);
  });

  it("compacts with a handoff note from the live context and Pi's file sections", async () => {
    let turnOptions: SimpleStreamOptions | undefined;
    let handoffOptions: SimpleStreamOptions | undefined;
    let handoffMessages = 0;
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("first done"),
      (_context, options) => {
        turnOptions = options;
        return fauxAssistantMessage("second done");
      },
      (context, options) => {
        handoffOptions = options;
        handoffMessages = context.messages.length;
        return fauxAssistantMessage("## Goal\nKeep going");
      },
    ]);
    await session.prompt("Read a.ts");
    await session.prompt("Continue");
    const live =
      session.sessionManager.buildSessionProjection().messages.length;
    const result = await session.compact("the next step");

    // Anthropic drops the cached message prefix when thinking or tool_choice differ.
    expect(turnOptions?.reasoning).toBe("high");
    expect(handoffOptions?.reasoning).toBe(turnOptions?.reasoning);
    expect(handoffOptions?.toolChoice).toBe(turnOptions?.toolChoice);
    expect(handoffOptions?.maxTokens).toBe(4_096);
    expect(handoffMessages).toBe(live + 1);
    expect(result.summary).toBe(
      "## Goal\nKeep going\n\n<read-files>\na.ts\n</read-files>",
    );
    expect(result.details).toEqual({ readFiles: ["a.ts"], modifiedFiles: [] });
  });

  it("falls back to Pi's summary when the handoff request fails", async () => {
    let summaryIsHandoff: boolean | undefined;
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("hello"),
      fauxAssistantMessage("again"),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "no tool choice",
      }),
      (context) => {
        summaryIsHandoff = JSON.stringify(context).includes("handoff note");
        return fauxAssistantMessage("## Goal\nPi summary");
      },
    ]);
    await session.prompt("Hi");
    await session.prompt("Again");
    const result = await session.compact();
    expect(summaryIsHandoff).toBe(false);
    expect(result.summary).toContain("Pi summary");
    expect(result.details).toBeDefined();
  });

  it("reuses a ready early note at manual compaction near the threshold", async () => {
    const noteMessages: number[] = [];
    const notes: string[] = [];
    const main = [
      ...Array.from({ length: 3 }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      ),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("second done"),
    ];
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        noteMessages.push(context.messages.length);
        const note = notes.length === 0 ? "Background note" : "Fresh note";
        notes.push(note);
        return fauxAssistantMessage(`## Goal\n${note}`);
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 19_000, true, {
      threshold: "pi",
      advanced: {
        background: true,
        supersedeReads: false,
        prune: { enabled: false },
        progressRatio: 1,
      },
    });
    await session.prompt("Read the file");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notes).toHaveLength(1);
    expect(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "compaction"),
    ).toHaveLength(0);
    await session.prompt("Continue");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notes).toHaveLength(1);
    const live =
      session.sessionManager.buildSessionProjection().messages.length;
    const result = await session.compact();

    expect(notes).toEqual(["Background note"]);
    expect(noteMessages[0]).toBeLessThan(live + 1);
    expect(result.summary).toMatch(/^## Goal\nBackground note/);
  });

  it.each(["tree", "reload"])(
    "cancels an unfinished background note on %s",
    async (action) => {
      const main = [
        ...Array.from({ length: 3 }, () =>
          fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        ),
        fauxAssistantMessage("done"),
      ];
      let noteSignal: AbortSignal | undefined;
      const reply: FauxResponseStep = (context, options) => {
        if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
          const signal = options?.signal;
          if (!signal) throw new Error("missing note cancellation signal");
          noteSignal = signal;
          return new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () =>
                resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
              { once: true },
            );
          });
        }
        const next = main.shift();
        if (!next) throw new Error("unexpected request");
        return next;
      };
      const { session } = await start(Array(8).fill(reply), 19_000, true, {
        threshold: "pi",
        advanced: {
          supersedeReads: false,
          prune: { enabled: false },
          progressRatio: 1,
        },
      });
      await session.prompt("Read b.ts three times");
      expect(noteSignal?.aborted).toBe(false);
      try {
        if (action === "reload") await session.reload();
        else {
          const target = session.sessionManager
            .getBranch()
            .find(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            );
          if (!target) throw new Error("missing tree navigation target");
          expect(await session.navigateTree(target.id)).toMatchObject({
            cancelled: false,
          });
        }
        expect(noteSignal?.aborted).toBe(true);
      } finally {
        await session.reload();
      }
    },
  );

  it("tries shake at Pi's threshold instead of waiting for an unfinished note", async () => {
    const main = [
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      ),
      fauxAssistantMessage("done"),
    ];
    let noteSignal: AbortSignal | undefined;
    let notes = 0;
    const reply: FauxResponseStep = (context, options) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        const signal = options?.signal;
        if (!signal) throw new Error("missing note cancellation signal");
        noteSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
            },
            { once: true },
          );
        });
      }
      if (last.includes("summary"))
        return fauxAssistantMessage("## Goal\nPi summary");
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session, cwd } = await start(Array(12).fill(reply), 17_500, true, {
      threshold: "pi",
      advanced: {
        supersedeReads: false,
        prune: { enabled: false },
        shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
      },
    });
    writeFileSync(join(cwd, "b.ts"), `<log>${"b".repeat(19_000)}</log>`);
    await session.prompt("Read b.ts four times");
    expect(notes).toBe(1);
    expect(noteSignal?.aborted).toBe(true);
    const branch = session.sessionManager.getBranch();
    expect(branch.some((entry) => entry.type === "context_edit")).toBe(true);
    expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(
      0,
    );
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("uses a fresh note at manual compaction when no early note is ready", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("second done"),
    ];
    let notes = 0;
    let noteMessages = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        noteMessages = context.messages.length;
        return fauxAssistantMessage("## Goal\nBackground note");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    // An 8,000-token threshold has a 1,000-token lead, not an 8,192-token floor.
    const { session } = await start(Array(6).fill(reply), 9_000, true, {
      threshold: "pi",
    });
    await session.prompt("Read a.ts");
    await session.prompt("Continue");
    const live =
      session.sessionManager.buildSessionProjection().messages.length;
    const result = await session.compact();

    expect(notes).toBe(1);
    // The manual compaction writes from the current live context.
    expect(noteMessages).toBe(live + 1);
    expect(result.summary).toMatch(/^## Goal\nBackground note\n\n<read-files>/);
    const kept = session.sessionManager.getEntry(result.firstKeptEntryId);
    expect(kept?.type === "message" && kept.message.role).toBe("assistant");
  });

  it("does nothing when contextKit.enabled is false", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { enabled: false },
    );
    const setStatus = vi.fn();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setStatus },
    });
    await session.prompt("Read a.ts twice");
    expect(setStatus).toHaveBeenLastCalledWith(
      "context-kit",
      "Context cleanup off",
    );
    expect(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "context_edit"),
    ).toEqual([]);
  });

  it("uses Pi's summary when methodOrder puts soft first", async () => {
    let handoffRequested = false;
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage("hello"),
        fauxAssistantMessage("again"),
        (context) => {
          handoffRequested = JSON.stringify(context).includes("handoff note");
          return fauxAssistantMessage("## Goal\nPi summary");
        },
      ],
      200_000,
      true,
      { advanced: { methodOrder: ["soft", "handoff"] } },
    );
    await session.prompt("Hi");
    await session.prompt("Again");
    const result = await session.compact();
    expect(handoffRequested).toBe(false);
    expect(result.summary).toContain("Pi summary");
  });

  it("compacts at an early threshold and continues with the latest tool result", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    const requests: string[] = [];
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note"))
        return fauxAssistantMessage("## Goal\nContinue the inspection");
      requests.push(JSON.stringify(context.messages));
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 200_000, true, {
      threshold: 13_000,
      advanced: {
        background: false,
        supersedeReads: false,
        prune: { enabled: false },
      },
    });
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(5_000)}`);
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.fromHook).toBe(true);
    expect(requests.at(-1)).toContain("Continue the inspection");
    expect(requests.at(-1)).toContain("export const a = 1;");
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("compacts with Pi's summary at an early threshold when the note fails", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note"))
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "note failed",
        });
      if (last.includes("<conversation>"))
        return fauxAssistantMessage("## Goal\nPi summary");
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 200_000, true, {
      threshold: 13_000,
      advanced: {
        background: false,
        supersedeReads: false,
        prune: { enabled: false },
      },
    });
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(5_000)}`);
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.summary).toContain("Pi summary");
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("does not retry a failed note when Pi compacts at its own threshold", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "note failed",
        });
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 15_000, true, {
      threshold: "pi",
      advanced: {
        background: false,
        supersedeReads: false,
        prune: { enabled: false },
      },
    });
    await session.prompt(`Read b.ts. ${"history ".repeat(4_500)}`);
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(notes).toBe(1);
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.fromHook).toBe(false);
  });

  it("compacts in the turn that passes an early threshold without a note in progress", async () => {
    const main = [
      ...Array.from({ length: 3 }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      ),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const requests: string[] = [];
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("## Goal\nContinue the inspection");
      }
      requests.push(JSON.stringify(context.messages));
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 200_000, true, {
      threshold: 13_000,
      advanced: {
        background: true,
        supersedeReads: false,
        prune: { enabled: false },
      },
    });
    await session.prompt("Read b.ts three times");
    expect(notes).toBe(1);
    expect(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    expect(requests.at(-1)).toContain("Continue the inspection");
  });

  it("cancels an unfinished note when /compact asks for a focus", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    let noteSignal: AbortSignal | undefined;
    let abortedBeforeFocus: boolean | undefined;
    const reply: FauxResponseStep = (context, options) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        if (notes > 1) {
          abortedBeforeFocus = noteSignal?.aborted;
          return fauxAssistantMessage("## Goal\nFocused note");
        }
        const signal = options?.signal;
        if (!signal) throw new Error("missing note cancellation signal");
        noteSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
        });
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(12).fill(reply), 200_000, true, {
      threshold: 12_000,
      advanced: { supersedeReads: false, prune: { enabled: false } },
    });
    await session.prompt("Read b.ts twice, then a.ts");
    expect(noteSignal?.aborted).toBe(false);
    const result = await session.compact("the next step");
    expect(abortedBeforeFocus).toBe(true);
    expect(notes).toBe(2);
    expect(result.summary).toContain("Focused note");
  });

  it("waits for an unfinished note at an early threshold instead of compacting", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    let summaries = 0;
    let noteSignal: AbortSignal | undefined;
    const reply: FauxResponseStep = (context, options) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        const signal = options?.signal;
        if (!signal) throw new Error("missing note cancellation signal");
        noteSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
        });
      }
      if (last.includes("<conversation>")) {
        summaries++;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(12).fill(reply), 200_000, true, {
      threshold: 12_000,
      advanced: { supersedeReads: false, prune: { enabled: false } },
    });
    try {
      await session.prompt("Read b.ts twice, then a.ts");
      expect(notes).toBe(1);
      expect(noteSignal?.aborted).toBe(false);
      expect(summaries).toBe(0);
      expect(
        session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(JSON.stringify(session.messages.at(-1))).toContain("done");
    } finally {
      await session.reload();
    }
  });

  it.each([
    ["soft is not in methodOrder", 200_000, ["handoff", "shake"]],
    ["the threshold equals Pi's", 14_000, ["soft"]],
  ])("writes no early summary when %s", async (_, contextWindow, order) => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note"))
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "note failed",
        });
      if (last.includes("<conversation>"))
        return fauxAssistantMessage("## Goal\nPi summary");
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), contextWindow, true, {
      threshold: 13_000,
      advanced: {
        methodOrder: order,
        background: false,
        supersedeReads: false,
        prune: { enabled: false },
      },
    });
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(5_000)}`);
    expect(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "compaction" && entry.fromHook),
    ).toEqual([]);
  });

  it("writes no early summary when only the previous summary precedes the retained context", async () => {
    let summaries = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("<conversation>")) {
        summaries++;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      return fauxAssistantMessage("done");
    };
    const { session } = await start(
      Array(4).fill(reply),
      200_000,
      true,
      { threshold: 13_000, advanced: { methodOrder: ["soft"] } },
      50_000,
    );
    await session.prompt("Hi");
    const first = session.sessionManager
      .getBranch()
      .find((entry) => entry.type === "message");
    session.sessionManager.appendCompaction(
      `## Goal\n${"old ".repeat(12_000)}`,
      first?.id ?? null,
      0,
    );
    await session.prompt("Again");
    expect(summaries).toBe(0);
  });

  it("updates the previous summary in an early summary", async () => {
    const main = [
      fauxAssistantMessage("hello"),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done"),
    ];
    let request = "";
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("<conversation>")) {
        request = last;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(6).fill(reply), 200_000, true, {
      threshold: 13_000,
      advanced: {
        methodOrder: ["soft"],
        supersedeReads: false,
        prune: { enabled: false },
      },
    });
    await session.prompt("Hi");
    const first = session.sessionManager
      .getBranch()
      .find((entry) => entry.type === "message");
    session.sessionManager.appendCompaction(
      "## Goal\nOld goal",
      first?.id ?? null,
      0,
    );
    await session.prompt(`Read b.ts. ${"history ".repeat(5_000)}`);
    expect(request).toContain("<previous-summary>");
    expect(request).toContain("Old goal");
  });

  it("does not retry a failed early summary every turn", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    let summaries = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("<conversation>")) {
        summaries++;
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "summary failed",
        });
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 200_000, true, {
      threshold: 13_000,
      advanced: {
        methodOrder: ["soft"],
        supersedeReads: false,
        prune: { enabled: false },
      },
    });
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(5_000)}`);
    expect(summaries).toBe(1);
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("falls back to Pi when a fresh note exceeds the retained-context budget", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage("first done"),
        fauxAssistantMessage("second done ".repeat(500)),
        fauxAssistantMessage("oversized ".repeat(20_000)),
        fauxAssistantMessage("## Goal\nPi summary"),
        fauxAssistantMessage("## Current turn\nContinue"),
      ],
      40_000,
      true,
      { advanced: { background: false } },
    );
    await session.prompt(`Remember ${"history ".repeat(1_500)}`);
    await session.prompt("Continue");
    const result = await session.compact();
    expect(result.summary).toContain("Pi summary");
    expect(result.summary).not.toContain("oversized");
  });

  it("skips an automatic handoff when retained context cannot fit its target", async () => {
    let noteRequested = false;
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        (context) => {
          noteRequested = JSON.stringify(context.messages).includes(
            "handoff note",
          );
          return fauxAssistantMessage("done");
        },
      ],
      200_000,
      true,
      { threshold: 4_000, advanced: { background: false, progressRatio: 1 } },
    );
    await session.prompt("Read a.ts then b.ts");

    expect(noteRequested).toBe(false);
    expect(
      session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "compaction"),
    ).toBe(false);
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("does not retry notes that cannot fit the retained context", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "note failed",
        });
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(5).fill(reply), 200_000, true, {
      threshold: 4_000,
      advanced: { background: false, progressRatio: 1 },
    });
    await session.prompt("Read b.ts then a.ts");

    expect(notes).toBe(0);
    expect(
      session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "compaction"),
    ).toBe(false);
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it.each([19_000, 200_000])(
    "shakes after a failed handoff with a %i-token context window",
    async (contextWindow) => {
      const main = [
        fauxAssistantMessage(["```ts", "x".repeat(56_000), "```"].join("\n")),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ];
      let notes = 0;
      const reply: FauxResponseStep = (context) => {
        if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
          notes++;
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "handoff unavailable",
          });
        }
        const next = main.shift();
        if (!next) throw new Error("unexpected request");
        return next;
      };
      const { session } = await start(
        Array(8).fill(reply),
        contextWindow,
        true,
        {
          threshold: 18_000,
          advanced: {
            background: false,
            prune: { enabled: false },
            shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
          },
        },
      );
      await session.prompt("Generate the source");
      await session.prompt("Read b.ts");
      const branch = session.sessionManager.getBranch();
      expect(notes).toBe(1);
      expect(
        branch.filter((entry) => entry.type === "context_edit"),
      ).toHaveLength(1);
      expect(
        branch.filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(JSON.stringify(session.messages.at(-1))).toContain("done");
    },
  );

  it("shakes before soft when methodOrder puts shake first", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage([
          {
            type: "text",
            text: ["```ts", "x".repeat(40_000), "```"].join("\n"),
          },
          fauxToolCall("read", { path: "a.ts" }),
        ]),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      {
        threshold: 8_000,
        advanced: {
          methodOrder: ["shake", "soft", "handoff"],
          background: false,
          prune: { enabled: false },
          shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
        },
      },
    );
    await session.prompt("Inspect the file");
    expect(
      session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "context_edit"),
    ).toBe(true);
  });

  it("does not shake when pruning alone brings the context under the threshold", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage([
          {
            type: "text",
            text: ["```ts", "x = 1;".repeat(2_800), "```"].join("\n"),
          },
          fauxToolCall("read", { path: "b.ts" }),
        ]),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      {
        threshold: 8_000,
        advanced: {
          background: false,
          prune: { protectTokens: 0, minSavings: 1, minTokens: 50 },
          shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
        },
      },
    );
    await session.prompt("Read b.ts");
    const replacements = session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "context_edit"
          ? [JSON.stringify(entry.replacement)]
          : [],
      );
    expect(replacements.some((text) => text.includes("Output pruned"))).toBe(
      true,
    );
    expect(replacements.some((text) => text.includes("Elided block"))).toBe(
      false,
    );
  });

  it("does not shake when replacing old reads alone brings the context under the threshold", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage([
          {
            type: "text",
            text: ["```ts", "x = 1;".repeat(2_800), "```"].join("\n"),
          },
          fauxToolCall("read", { path: "b.ts" }),
        ]),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      {
        threshold: 11_000,
        advanced: {
          background: false,
          prune: { enabled: false },
          shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
        },
      },
    );
    await session.prompt("Read b.ts twice");
    const branch = session.sessionManager.getBranch();
    const replacements = branch.flatMap((entry) =>
      entry.type === "context_edit" ? [JSON.stringify(entry.replacement)] : [],
    );
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toContain("Superseded by a newer read");
    expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(
      0,
    );
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("does not shake before soft when methodOrder puts soft first", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage([
          {
            type: "text",
            text: ["```ts", "x".repeat(40_000), "```"].join("\n"),
          },
          fauxToolCall("read", { path: "a.ts" }),
        ]),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      {
        threshold: 8_000,
        advanced: {
          methodOrder: ["soft", "shake", "handoff"],
          background: false,
          prune: { enabled: false },
          shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
        },
      },
    );
    await session.prompt("Inspect the file");
    expect(
      session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "context_edit"),
    ).toBe(false);
  });

  it.each([
    ["handoff", "shake", "soft"],
    ["handoff", "soft", "shake"],
    ["shake", "handoff", "soft"],
    ["shake", "soft", "handoff"],
    ["soft", "handoff", "shake"],
    ["soft", "shake", "handoff"],
  ])("honors automatic priority %s, %s, %s", async (first, second, third) => {
    const main = [
      fauxAssistantMessage(["```ts", "x".repeat(56_000), "```"].join("\n")),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    let summaries = 0;
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("## Goal\nContinue the inspection");
      }
      if (last.includes("<conversation>")) {
        summaries++;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 200_000, true, {
      threshold: 18_000,
      advanced: {
        methodOrder: [first, second, third],
        background: false,
        prune: { enabled: false },
        shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
      },
    });
    await session.prompt("Generate the source");
    await session.prompt("Read b.ts");
    const branch = session.sessionManager.getBranch();
    expect(notes).toBe(first === "handoff" ? 1 : 0);
    expect(summaries).toBe(first === "soft" ? 1 : 0);
    expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(
      first === "shake" ? 0 : 1,
    );
    expect(
      branch.filter((entry) => entry.type === "context_edit"),
    ).toHaveLength(first === "shake" ? 1 : 0);
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("preserves ranges beyond Pi's truncated full read", async () => {
    const { session, cwd } = await start([
      fauxAssistantMessage(
        fauxToolCall("read", { path: "long.txt", offset: 2_501, limit: 10 }),
      ),
      fauxAssistantMessage(fauxToolCall("read", { path: "long.txt" })),
      fauxAssistantMessage("done"),
    ]);
    writeFileSync(
      join(cwd, "long.txt"),
      `${Array.from({ length: 2_500 }, (_, i) => `line ${i + 1}`).join("\n")}\nTAIL-UNIQUE`,
    );
    await session.prompt("Read the end and the beginning");
    const branch = session.sessionManager.getBranch();
    expect(JSON.stringify(branch)).toContain("TAIL-UNIQUE");
    expect(
      branch.some(
        (entry) =>
          entry.type === "context_edit" &&
          JSON.stringify(entry).includes("Superseded by a newer read"),
      ),
    ).toBe(false);
  });

  it("uses the projected retained tail after compaction edits", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(`continued one ${"c".repeat(16_000)}`),
        fauxAssistantMessage(`continued two ${"d".repeat(12_000)}`),
        (context) => {
          if (JSON.stringify(context.messages).includes("handoff note"))
            return fauxAssistantMessage("## Goal\nSecond note");
          throw new Error("unexpected non-handoff request");
        },
      ],
      200_000,
      true,
      {
        threshold: 13_000,
        advanced: {
          background: false,
          progressRatio: 1,
          prune: { enabled: false },
        },
      },
      8_000,
    );
    const manager = session.sessionManager;
    const retainedIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      manager.appendMessage({
        role: "user",
        content: `history prompt ${i}`,
        timestamp: Date.now(),
      });
      const id = manager.appendMessage(
        fauxAssistantMessage(`history-${i} ${"h".repeat(8_000)}`),
      );
      if (i >= 3) retainedIds.push(id);
    }
    const firstRetainedId = retainedIds.at(0);
    if (!firstRetainedId) throw new Error("expected retained history");
    manager.appendCompaction(
      "## Goal\nPrevious summary",
      firstRetainedId,
      30_000,
    );
    manager.appendContextEdit(firstRetainedId, {
      content: [{ type: "text", text: "edited retained history" }],
    });
    manager.appendMessage({
      role: "user",
      content: "Continue from the retained history",
      timestamp: Date.now(),
    });

    await session.prompt("Continue once");
    await session.prompt("Continue again");
    const compactions = manager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(2);
    const latest = compactions.at(-1);
    expect(latest?.type).toBe("compaction");
    expect(retainedIds).toContain(
      latest?.type === "compaction" ? latest.firstKeptEntryId : undefined,
    );
  });

  it("lets the model recall raw text removed by a context edit", async () => {
    const { session } = await start([
      fauxAssistantMessage("stored"),
      fauxAssistantMessage(fauxToolCall("recall", { query: "RECALL-MARKER" })),
      fauxAssistantMessage("found"),
    ]);
    await session.prompt("Remember RECALL-MARKER");
    const entry = session.sessionManager
      .getBranch()
      .find(
        (candidate) =>
          candidate.type === "message" && candidate.message.role === "user",
      );
    if (!entry) throw new Error("missing user message");
    session.sessionManager.appendContextEdit(entry.id, { content: "[elided]" });
    expect(
      JSON.stringify(session.sessionManager.buildSessionProjection().messages),
    ).not.toContain("RECALL-MARKER");
    await session.prompt("Find the original message");
    const result = session.messages.find(
      (message) => message.role === "toolResult",
    );
    expect(result?.role === "toolResult" && result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain(
      `${entry.id} user: Remember RECALL-MARKER`,
    );
  });

  it("leaves an overflow without a ready note to Pi's summary", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
      }),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("## Goal\nNote");
      }
      if (last.includes("<conversation>"))
        return fauxAssistantMessage("## Goal\nPi summary");
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 200_000, true, {
      advanced: { background: false },
    });
    await session.prompt("Read a.ts");
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(notes).toBe(0);
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.fromHook).toBe(false);
  });

  it("returns an error to the model when recall gets no query or entryId", async () => {
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("recall", {})),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Recall something");
    const result = session.messages.find(
      (message) => message.role === "toolResult",
    );
    expect(result?.role === "toolResult" && result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Pass query or entryId.");
  });
});
