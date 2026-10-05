import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { handoffContext, handoffNote, handoffSummary } from "../src/handoff.ts";
import { Transcript } from "./fixtures.ts";

describe("handoffContext", () => {
  it("appends the handoff request after the unchanged conversation", () => {
    const history = [{ role: "user" as const, content: "hi", timestamp: 1 }];
    const context = handoffContext(history, " the failing test ");
    expect(context.messages.slice(0, 1)).toEqual(history);
    expect(context.messages).toHaveLength(2);
    const last = context.messages[1];
    expect(last?.role).toBe("user");
    expect(JSON.stringify(last)).toContain(
      "Give extra attention to: the failing test",
    );
    expect(context.systemPrompt).toBeUndefined();
  });
});

describe("handoffNote", () => {
  it("joins text blocks and ignores tool calls", () => {
    const response = fauxAssistantMessage([
      { type: "text", text: "## Goal" },
      { type: "toolCall", id: "c", name: "read", arguments: {} },
      { type: "text", text: "Ship it" },
    ]);
    expect(handoffNote(response)).toBe("## Goal\nShip it");
  });

  it("rejects length-truncated notes", () => {
    expect(() =>
      handoffNote(
        fauxAssistantMessage("partial note", { stopReason: "length" }),
      ),
    ).toThrow(/truncated|length/i);
  });

  it("returns nothing for an empty reply and throws for a failed one", () => {
    expect(handoffNote(fauxAssistantMessage(" "))).toBeUndefined();
    expect(() =>
      handoffNote(
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "rate limited",
        }),
      ),
    ).toThrow("rate limited");
  });
});

describe("handoffSummary", () => {
  it("appends the files and records them in details", () => {
    const t = new Transcript();
    t.tool("read", { path: "a.ts" }, "a");
    t.tool("edit", { path: "b.ts" }, "ok");
    expect(handoffSummary("note", t.branch())).toEqual({
      summary:
        "note\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>",
      details: {
        readFiles: ["a.ts"],
        modifiedFiles: ["b.ts"],
      },
    });
  });
});
