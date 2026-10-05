import { describe, expect, it } from "vitest";
import { shake } from "../src/shake.ts";
import { filler, Transcript } from "./fixtures.ts";

const ELIDE = {
  protectTokens: 500,
  minSavings: 0,
  blockMinTokens: 100,
};

function fenced(tokens: number): string {
  return `\`\`\`ts\n${filler(tokens)}\n\`\`\``;
}

describe("shake", () => {
  it("elides large fenced and XML blocks outside the protected window", () => {
    const t = new Transcript();
    const user = t.assistant(
      `before\n${fenced(300)}\nafter <log>\n${filler(300)}\n</log> end`,
    );
    t.assistant(filler(600));
    const edits = shake(t.entries(), ELIDE);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.targetId).toBe(user);
    expect(edits[0]?.content).toBe(
      `before\n[Elided block: about 303 tokens. Call recall with entryId "${user}" to read it.]\n` +
        `after [Elided block: about 304 tokens. Call recall with entryId "${user}" to read it.] end`,
    );
  });

  it("preserves user instructions and user images", () => {
    const t = new Transcript();
    const instruction = `Preserve this instruction.\\n${fenced(600)}`;
    const user = t.session.appendMessage({
      role: "user",
      content: [
        { type: "text", text: instruction },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    });
    const edits = shake(t.entries(), { ...ELIDE, protectTokens: 0 });
    expect(edits).toEqual([]);
    expect(t.branch().find((entry) => entry.id === user)).toBeDefined();
  });

  it("keeps small blocks, recent entries, and tool calls", () => {
    const t = new Transcript();
    t.user(`small ${fenced(50)}`);
    const id = t.tool("bash", { command: "x" }, `${fenced(300)}`);
    t.user(fenced(600));
    const edits = shake(t.entries(), ELIDE);
    expect(edits.map((edit) => edit.targetId)).toEqual([id]);
    expect(
      t.entries().some((entry) => entry.sourceEntry.id === edits[0]?.targetId),
    ).toBe(true);
  });

  it("replaces images and keeps the text", () => {
    const t = new Transcript();
    const id = t.tool("read", { path: "a.png" }, [
      { type: "text", text: "Read image" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    t.user(filler(600));
    const edits = shake(t.entries(), ELIDE);
    expect(edits).toEqual([
      {
        targetId: id,
        content: [
          { type: "text", text: "Read image" },
          {
            type: "text",
            text: `[Image elided. Call recall with entryId "${id}" to see its metadata.]`,
          },
        ],
      },
    ]);
  });

  it("returns nothing below the minimum savings", () => {
    const t = new Transcript();
    t.assistant(fenced(300));
    t.assistant(filler(600));
    expect(shake(t.entries(), { ...ELIDE, minSavings: 1_000 })).toEqual([]);
  });
});
