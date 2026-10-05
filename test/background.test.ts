import { describe, expect, it, vi } from "vitest";
import { BackgroundHandoff, firstEntryAfter } from "../src/background.ts";
import { Transcript } from "./fixtures.ts";

const NOTE = { note: "note" };

describe("BackgroundHandoff", () => {
  it("runs once per compaction epoch and hands the note over", async () => {
    const t = new Transcript();
    const leaf = t.user("hi");
    const background = new BackgroundHandoff();
    const run = vi.fn(async () => NOTE);
    expect(background.start(null, leaf, run, () => {})).toBe(true);
    expect(background.start(null, leaf, run, () => {})).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      await background.take(null, t.branch(), new AbortController().signal),
    ).toEqual({
      ...NOTE,
      leafId: leaf,
    });
  });

  it("reports whether the note of an epoch is still being written", async () => {
    const background = new BackgroundHandoff();
    let finish = (_: typeof NOTE) => {};
    background.start(
      null,
      "leaf",
      () => new Promise((resolve) => (finish = resolve)),
      () => {},
    );
    expect(background.writing(null)).toBe(true);
    expect(background.writing("other")).toBe(false);
    finish(NOTE);
    await Promise.resolve();
    await Promise.resolve();
    expect(background.writing(null)).toBe(false);
  });

  it("ignores a job from another epoch or branch", async () => {
    const t = new Transcript();
    const background = new BackgroundHandoff();
    background.start(
      "old",
      t.user("hi"),
      async () => NOTE,
      () => {},
    );
    expect(
      await background.take("new", t.branch(), new AbortController().signal),
    ).toBeUndefined();
    background.start(
      "new",
      "elsewhere",
      async () => NOTE,
      () => {},
    );
    expect(
      await background.take("new", t.branch(), new AbortController().signal),
    ).toBeUndefined();
  });

  it("reports failures and stops waiting when aborted", async () => {
    const t = new Transcript();
    const leaf = t.user("hi");
    const background = new BackgroundHandoff();
    const errors: unknown[] = [];
    background.start(
      null,
      leaf,
      async () => Promise.reject(new Error("boom")),
      (error) => errors.push(error),
    );
    expect(
      await background.take(null, t.branch(), new AbortController().signal),
    ).toBeUndefined();
    expect(errors).toEqual([new Error("boom")]);

    const slow = new BackgroundHandoff();
    let jobSignal: AbortSignal | undefined;
    slow.start(
      null,
      leaf,
      (signal) => {
        jobSignal = signal;
        return new Promise(() => {});
      },
      () => {},
    );
    const waiting = new AbortController();
    const taken = slow.take(null, t.branch(), waiting.signal);
    waiting.abort();
    expect(await taken).toBeUndefined();
    slow.cancel();
    expect(jobSignal?.aborted).toBe(true);
  });
});

describe("firstEntryAfter", () => {
  it("returns the first entry after the leaf that can start a context", () => {
    const t = new Transcript();
    const result = t.tool("bash", { command: "a" }, "out");
    const next = t.tool("bash", { command: "b" }, "out");
    const call = t.branch().find((entry) => entry.id === next)?.parentId;
    expect(firstEntryAfter(t.branch(), result)).toBe(call);
    expect(firstEntryAfter(t.branch(), next)).toBeUndefined();
  });
});
