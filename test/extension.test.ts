import { mkdtempSync, writeFileSync } from "node:fs";
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
import { afterEach, describe, expect, it } from "vitest";

const sessions: { dispose(): void }[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

async function start(
  responses: FauxResponseStep[],
  contextWindow = 200_000,
  compactionEnabled = true,
  contextKit?: unknown,
  keepRecentTokens = 1_000,
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-context-kit-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-context-kit-cwd-"));
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n".repeat(200));
  writeFileSync(join(cwd, "b.ts"), "export const b = 2;\n".repeat(1_000));
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
    contextKit,
  };
  const settingsManager = SettingsManager.inMemory(settings);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
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
  return { session, faux, cwd };
}

describe("pi-context-kit inside Pi", () => {
  it.each([
    ["enabled", true],
    ["disabled", false],
  ])(
    "replaces an older read of the same file with compaction %s",
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
      const edits = session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "context_edit");
      expect(edits).toHaveLength(1);
      expect(
        JSON.stringify(
          session.sessionManager.buildSessionProjection().messages,
        ),
      ).toContain("[Superseded by a newer read of this file]");
    },
  );

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
    const { session } = await start(Array(8).fill(reply), 24_000, true, {
      asyncEnabled: true,
      supersedeReads: false,
      prune: { enabled: false },
      progressRatio: 1,
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
    const { session, cwd } = await start(Array(12).fill(reply), 24_000, true, {
      supersedeReads: false,
      prune: { enabled: false },
      shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
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
    const { session } = await start(Array(6).fill(reply), 9_000);
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
    await session.prompt("Read a.ts twice");
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
      { methodOrder: ["soft", "handoff"] },
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
      thresholdTokens: 13_000,
      asyncEnabled: false,
      supersedeReads: false,
      prune: { enabled: false },
    });
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(2_500)}`);
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.fromHook).toBe(true);
    expect(requests.at(-1)).toContain("Continue the inspection");
    expect(requests.at(-1)).toContain("export const a = 1;");
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
      { asyncEnabled: false },
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
      { thresholdTokens: 4_000, asyncEnabled: false, progressRatio: 1 },
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
      thresholdTokens: 4_000,
      asyncEnabled: false,
      progressRatio: 1,
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
        fauxAssistantMessage(["```ts", "x".repeat(40_000), "```"].join("\n")),
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
          thresholdTokens: 18_000,
          asyncEnabled: false,
          prune: { enabled: false },
          shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
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
        thresholdTokens: 8_000,
        methodOrder: ["shake", "soft", "handoff"],
        asyncEnabled: false,
        prune: { enabled: false },
        shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
      },
    );
    await session.prompt("Inspect the file");
    expect(
      session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "context_edit"),
    ).toBe(true);
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
        thresholdTokens: 8_000,
        methodOrder: ["soft", "shake", "handoff"],
        asyncEnabled: false,
        prune: { enabled: false },
        shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
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
      fauxAssistantMessage(["```ts", "x".repeat(40_000), "```"].join("\n")),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("## Goal\nContinue the inspection");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(Array(8).fill(reply), 200_000, true, {
      thresholdTokens: 18_000,
      methodOrder: [first, second, third],
      asyncEnabled: false,
      prune: { enabled: false },
      shake: { protectTokens: 0, minSavings: 1, blockMinTokens: 10 },
    });
    await session.prompt("Generate the source");
    await session.prompt("Read b.ts");
    const branch = session.sessionManager.getBranch();
    expect(notes).toBe(first === "handoff" ? 1 : 0);
    expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(
      first === "handoff" ? 1 : 0,
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
        thresholdTokens: 13_000,
        asyncEnabled: false,
        progressRatio: 1,
        prune: { enabled: false },
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
});
