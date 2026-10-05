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
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-context-kit-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-context-kit-cwd-"));
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n".repeat(200));
  const faux = fauxProvider({
    models: [{ id: "faux-1", contextWindow, maxTokens: 4_096 }],
  });
  faux.setResponses(responses);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: {
      enabled: compactionEnabled,
      reserveTokens: 1_000,
      keepRecentTokens: 1_000,
    },
  });
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
    // Threshold 33,000 tokens: the background note starts above 232 tokens.
    const { session } = await start(Array(6).fill(reply), 34_000);
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
