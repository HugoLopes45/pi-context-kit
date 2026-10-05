import { describe, expect, it } from "vitest";
import { readEntry, searchEntries } from "../src/recall.ts";
import { Transcript } from "./fixtures.ts";

describe("searchEntries", () => {
  it("finds matching entries case-insensitively, newest first", () => {
    const t = new Transcript();
    const user = t.user("Fix the Login bug");
    t.assistant("Looking at other things");
    const result = t.tool(
      "bash",
      { command: "npm test" },
      "FAIL login.test.ts\nexpected 200",
    );
    expect(searchEntries(t.branch(), { query: "login" })).toBe(
      [
        `${result} toolResult bash: [bash result] FAIL login.test.ts expected 200`,
        `${user} user: Fix the Login bug`,
      ].join("\n"),
    );
  });

  it("supports regex, paging, and reports no match", () => {
    const t = new Transcript();
    const ids = [t.user("error 1"), t.user("error 2"), t.user("error 3")];
    expect(
      searchEntries(t.branch(), {
        query: "error \\d",
        regex: true,
        offset: 1,
        limit: 1,
      }),
    ).toBe(`${ids[1]} user: error 2\n[3 matches. Use offset=2 for more.]`);
    expect(searchEntries(t.branch(), { query: "absent" })).toBe(
      "No entries match.",
    );
    expect(() =>
      searchEntries(t.branch(), { query: "(", regex: true }),
    ).toThrow(/Invalid regex/);
  });

  it("finds raw content that a context edit hides", () => {
    const t = new Transcript();
    const id = t.tool("read", { path: "a.ts" }, "secret value");
    t.session.appendContextEdit(id, {
      content: [{ type: "text", text: "[pruned]" }],
    });
    expect(searchEntries(t.branch(), { query: "secret" })).toContain(id);
    expect(searchEntries(t.branch(), { query: "pruned" })).toBe(
      "No entries match.",
    );
  });
});

describe("readEntry", () => {
  it("returns the raw entry text in pages", () => {
    const t = new Transcript();
    const id = t.tool("read", { path: "a.ts" }, "0123456789");
    expect(readEntry(t.branch(), id, { offset: 0, limit: 15 })).toBe(
      "[read result]\n0\n\n[Showing characters 0-15 of 24. Use offset=15 to continue.]",
    );
    expect(readEntry(t.branch(), id, { offset: 15, limit: 100 })).toBe(
      "123456789",
    );
    expect(() => readEntry(t.branch(), "missing", {})).toThrow(
      /No entry missing/,
    );
  });

  it("describes tool calls and images", () => {
    const t = new Transcript();
    const id = t.tool("read", { path: "a.png" }, [
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    const call = t.branch().at(-2)?.id ?? "";
    expect(readEntry(t.branch(), call, {})).toBe(
      '[tool call read {"path":"a.png"}]',
    );
    expect(readEntry(t.branch(), id, {})).toBe(
      "[read result]\n[image image/png]",
    );
  });
});
