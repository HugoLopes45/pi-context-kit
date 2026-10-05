import { describe, expect, it } from "vitest";
import { pruneToolOutputs } from "../src/prune.ts";
import { filler, Transcript } from "./fixtures.ts";

const OPTIONS = { protectTokens: 1_000, minSavings: 500, minTokens: 50 };

describe("pruneToolOutputs", () => {
  it("prunes outputs beyond the protected window with a recall hint", () => {
    const t = new Transcript();
    const old = t.tool("bash", { command: "a" }, filler(800));
    t.tool("bash", { command: "b" }, filler(1_100));
    const edits = pruneToolOutputs(t.entries(), new Set(), OPTIONS);
    expect(edits.map((edit) => edit.targetId)).toEqual([old]);
    expect(edits[0]?.content).toEqual([
      {
        type: "text",
        text: `[Output pruned: about 800 tokens. Call recall with entryId "${old}" to read it.]`,
      },
    ]);
  });

  it("does nothing when the total savings stay below the minimum", () => {
    const t = new Transcript();
    t.tool("bash", { command: "a" }, filler(400));
    t.tool("bash", { command: "b" }, filler(1_000));
    expect(pruneToolOutputs(t.entries(), new Set(), OPTIONS)).toEqual([]);
  });

  it("keeps tiny outputs, edited outputs, and skill files", () => {
    const t = new Transcript();
    t.tool("bash", { command: "tiny" }, filler(40));
    const edited = t.tool("bash", { command: "a" }, filler(800));
    t.tool("read", { path: "/skills/x/SKILL.md" }, filler(800));
    const big = t.tool("bash", { command: "c" }, filler(800));
    t.tool("bash", { command: "d" }, filler(1_100));
    const edits = pruneToolOutputs(t.entries(), new Set([edited]), OPTIONS);
    expect(edits.map((edit) => edit.targetId)).toEqual([big]);
  });
});
