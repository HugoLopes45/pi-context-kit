import { describe, expect, it } from "vitest";
import { fileLists, formatFileLists } from "../src/files.ts";
import { Transcript } from "./fixtures.ts";

describe("fileLists", () => {
  it("separates read-only from modified files, sorted", () => {
    const t = new Transcript();
    t.tool("read", { path: "b.ts" }, "b");
    t.tool("read", { path: "a.ts" }, "a");
    t.tool("edit", { path: "a.ts" }, "ok");
    t.tool("write", { path: "c.ts" }, "ok");
    t.tool("bash", { command: "ls", path: "d.ts" }, "a.ts");
    expect(fileLists(t.branch())).toEqual({
      readFiles: ["b.ts"],
      modifiedFiles: ["a.ts", "c.ts"],
    });
  });

  it("includes calls made from codemode scripts", () => {
    const t = new Transcript();
    const id = t.tool("codemode", { code: "..." }, "done");
    const entry = t.branch().find((candidate) => candidate.id === id);
    if (entry?.type !== "message" || entry.message.role !== "toolResult")
      throw new Error("setup");
    entry.message.nestedCalls = {
      calls: [
        {
          id: "n",
          name: "write",
          arguments: { path: "x.ts" },
          status: "ok",
        },
      ],
      complete: true,
    };
    expect(fileLists(t.branch()).modifiedFiles).toEqual(["x.ts"]);
  });

  it("keeps files from entries before a compaction", () => {
    const t = new Transcript();
    t.tool("read", { path: "old.ts" }, "x");
    const kept = t.user("next");
    t.session.appendCompaction("summary", kept, 100);
    expect(fileLists(t.branch()).readFiles).toEqual(["old.ts"]);
  });
});

describe("formatFileLists", () => {
  it("uses Pi's summary sections", () => {
    expect(
      formatFileLists({ readFiles: ["a.ts"], modifiedFiles: ["b.ts", "c.ts"] }),
    ).toBe(
      "<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\nc.ts\n</modified-files>",
    );
    expect(formatFileLists({ readFiles: [], modifiedFiles: [] })).toBe("");
  });
});
