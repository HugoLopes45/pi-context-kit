import { describe, expect, it } from "vitest";
import { editedEntryIds } from "../src/context.ts";
import { SUPERSEDED_NOTICE, supersededReads } from "../src/stale.ts";
import { filler, Transcript } from "./fixtures.ts";

function staleIds(t: Transcript, suffixLimit = 8_000): string[] {
  return supersededReads(
    t.entries(),
    editedEntryIds(t.branch()),
    suffixLimit,
  ).map((edit) => edit.targetId);
}

describe("supersededReads", () => {
  it("replaces an older full read of the same path", () => {
    const t = new Transcript();
    const old = t.tool("read", { path: "a.ts" }, filler(500));
    t.tool("read", { path: "a.ts" }, filler(500));
    const edits = supersededReads(t.entries(), new Set(), 8_000);
    expect(edits).toEqual([
      { targetId: old, content: [{ type: "text", text: SUPERSEDED_NOTICE }] },
    ]);
  });

  it("does not treat a truncated whole-file read as covering older ranges", () => {
    const t = new Transcript();
    const old = t.tool(
      "read",
      { path: "a.ts", offset: 2_001, limit: 20 },
      filler(500),
    );
    t.tool(
      "read",
      { path: "a.ts" },
      `${filler(500)}\n\n[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]`,
    );
    expect(staleIds(t)).toEqual([]);
    expect(old).toBeDefined();
  });

  it("keeps reads of other paths and different ranges", () => {
    const t = new Transcript();
    t.tool("read", { path: "a.ts", offset: 1, limit: 50 }, filler(500));
    t.tool("read", { path: "b.ts" }, filler(500));
    t.tool("read", { path: "a.ts", offset: 51, limit: 50 }, filler(500));
    expect(staleIds(t)).toEqual([]);
  });

  it("lets a full read supersede an older ranged read, not the reverse", () => {
    const t = new Transcript();
    const ranged = t.tool(
      "read",
      { path: "a.ts", offset: 10, limit: 5 },
      filler(200),
    );
    t.tool("read", { path: "a.ts" }, filler(500));
    t.tool("read", { path: "a.ts", offset: 10, limit: 5 }, filler(200));
    expect(staleIds(t)).toEqual([ranged]);
  });

  it("lets a failed read supersede only older failed reads", () => {
    const t = new Transcript();
    const success = t.tool("read", { path: "a.ts" }, filler(200));
    const failure = t.tool(
      "read",
      { path: "a.ts" },
      `ENOENT ${filler(50)}`,
      true,
    );
    t.tool("read", { path: "a.ts" }, `ENOENT ${filler(50)}`, true);
    expect(staleIds(t)).toEqual([failure]);
    expect(staleIds(t)).not.toContain(success);
  });

  it("counts the candidate itself against the suffix limit", () => {
    const t = new Transcript();
    const old = t.tool("read", { path: "a.ts" }, filler(12_000));
    t.tool("read", { path: "a.ts" }, filler(100));
    expect(staleIds(t, 8_000)).toEqual([]);
    expect(old).toBeDefined();
  });

  it("skips candidates followed by more than the suffix limit", () => {
    const t = new Transcript();
    t.tool("read", { path: "a.ts" }, filler(500));
    t.tool("bash", { command: "ls" }, filler(9_000));
    t.tool("read", { path: "a.ts" }, filler(500));
    expect(staleIds(t)).toEqual([]);
  });

  it("skips entries that are already edited or too small to shrink", () => {
    const t = new Transcript();
    const old = t.tool("read", { path: "a.ts" }, filler(500));
    t.tool("read", { path: "tiny.ts" }, "x");
    t.tool("read", { path: "tiny.ts" }, "x");
    t.tool("read", { path: "a.ts" }, filler(500));
    t.session.appendContextEdit(old, {
      content: [{ type: "text", text: "kept" }],
    });
    expect(staleIds(t)).toEqual([]);
  });
});
