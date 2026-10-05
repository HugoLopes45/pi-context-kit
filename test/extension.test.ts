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
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-context-kit-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-context-kit-cwd-"));
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n".repeat(200));
  writeFileSync(join(cwd, "b.ts"), "export const b = 2;\n".repeat(1_000));
  const faux = fauxProvider({
    models: [{ id: "faux-1", contextWindow, maxTokens: 4_096 }],
  });
  faux.setResponses(responses);
  const settings = {
    retry: { enabled: false },
    compaction: {
      enabled: compactionEnabled,
      reserveTokens: 1_000,
      keepRecentTokens: 1_000,
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
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "edit", "recall"],
  });
  sessions.push(session);
  return { session, faux };
}

describe("pi-context-kit inside Pi", () => {
  it.each([
    ["enabled", true],
    ["disabled", false],
  ])("replaces an older read of the same file with compaction %s", async (_, enabled) => {
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
      JSON.stringify(session.sessionManager.buildSessionProjection().messages),
    ).toContain("[Superseded by a newer read of this file]");
  });

  it("compacts with a handoff note from the live context and Pi's file sections", async () => {
    let handoffOptions: SimpleStreamOptions | undefined;
    let handoffMessages = 0;
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("second done"),
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

    expect(handoffOptions?.toolChoice).toBe("none");
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

  it("writes the note in the background near the threshold and reuses it", async () => {
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
    // Threshold 8,000 tokens: the 8,192-token lead starts the background note at the first turn.
    const { session } = await start(Array(6).fill(reply), 9_000);
    await session.prompt("Read a.ts");
    await session.prompt("Continue");
    const live = session.sessionManager.buildSessionProjection().messages.length;
    const result = await session.compact();

    expect(notes).toBe(1);
    // Written at the end of the first turn, not from the context at compaction time.
    expect(noteMessages).toBeLessThan(live);
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

  it("compacts at thresholdTokens between turns without interrupting the run", async () => {
    let finalRequest = "";
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("## Goal\nThreshold note"),
        (context) => {
          finalRequest = JSON.stringify(context.messages);
          return fauxAssistantMessage("done");
        },
      ],
      200_000,
      true,
      { thresholdTokens: 4_000, asyncEnabled: false },
    );
    await session.prompt("Read a.ts then b.ts");

    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.summary).toMatch(/^## Goal\nThreshold note/);
    // The run went on with the note and the latest tool result still in context.
    expect(finalRequest).toContain("Threshold note");
    expect(finalRequest).toContain("export const b = 2;");
    const last = session.messages.at(-1);
    expect(last?.role === "assistant" && last.stopReason).toBe("stop");
    expect(JSON.stringify(last)).toContain("done");
  });

  it("keeps working without retrying each turn when the threshold note fails", async () => {
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
    });
    await session.prompt("Read b.ts then a.ts");

    expect(notes).toBe(1);
    expect(
      session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "compaction"),
    ).toBe(false);
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("lets the model recall a pruned or compacted entry", async () => {
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("recall", { query: "SECRET-TOKEN" })),
      fauxAssistantMessage("found"),
    ]);
    await session.prompt("Remember SECRET-TOKEN");
    const result = session.messages.find(
      (message) => message.role === "toolResult",
    );
    expect(result?.role === "toolResult" && result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain("user: Remember SECRET-TOKEN");
  });
});
