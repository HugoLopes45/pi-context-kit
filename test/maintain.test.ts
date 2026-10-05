import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { planMaintenance } from "../src/maintain.ts";
import { filler, Transcript } from "./fixtures.ts";

function staleSession() {
  const t = new Transcript();
  const old = t.tool("read", { path: "a.ts" }, filler(2_000));
  t.tool("read", { path: "a.ts" }, filler(2_000));
  return { t, old };
}

describe("planMaintenance", () => {
  it("applies stale edits below the threshold", () => {
    const { t, old } = staleSession();
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 4_100,
      threshold: 10_000,
    });
    expect(plan.edits.map((edit) => edit.targetId)).toEqual([old]);
    expect(plan.tokens).toBeLessThan(2_200);
  });

  it("skips stale edits whose estimate would cross the threshold", () => {
    const { t } = staleSession();
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 1_000,
      threshold: 1_500,
    });
    expect(plan).toEqual({ edits: [], tokens: 1_000 });
  });

  it("prunes over the threshold when that gets well below it", () => {
    const t = new Transcript();
    const old = t.tool("bash", { command: "a" }, filler(30_000));
    t.tool("bash", { command: "b" }, filler(41_000));
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 71_100,
      threshold: 70_000,
    });
    expect(plan.edits.map((edit) => edit.targetId)).toEqual([old]);
    expect(plan.tokens).toBeLessThan(56_000);
  });

  it("keeps Pi's token count when no maintenance edit is persisted", () => {
    const t = new Transcript();
    t.user("small context");
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: {
        ...DEFAULT_CONFIG,
        supersedeReads: false,
        prune: { ...DEFAULT_CONFIG.prune, enabled: false },
        shake: undefined,
      },
      tokens: 100_000,
      threshold: 70_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 100_000 });
  });

  it("leaves reduction to compaction when pruning is not enough", () => {
    const t = new Transcript();
    t.tool("bash", { command: "a" }, filler(21_000));
    t.tool("bash", { command: "b" }, filler(60_000));
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 81_100,
      threshold: 70_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 81_100 });
  });

  it("keeps older reads when supersedeReads is off", () => {
    const { t } = staleSession();
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: { ...DEFAULT_CONFIG, supersedeReads: false },
      tokens: 4_100,
      threshold: 10_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 4_100 });
  });

  it("does not prune when pruning is off", () => {
    const t = new Transcript();
    t.tool("bash", { command: "a" }, filler(30_000));
    t.tool("bash", { command: "b" }, filler(41_000));
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: {
        ...DEFAULT_CONFIG,
        prune: { ...DEFAULT_CONFIG.prune, enabled: false },
      },
      tokens: 71_100,
      threshold: 70_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 71_100 });
  });

  it("shakes only when shake options are given", () => {
    const t = new Transcript();
    t.assistant(`<log>\n${filler(30_000)}\n</log>`);
    t.assistant("ok");
    t.assistant(filler(41_000));
    const input = {
      entries: t.entries(),
      edited: new Set<string>(),
      tokens: 71_100,
      threshold: 70_000,
    };
    expect(
      planMaintenance({ ...input, options: DEFAULT_CONFIG }).edits,
    ).toHaveLength(1);
    expect(
      planMaintenance({
        ...input,
        options: { ...DEFAULT_CONFIG, shake: undefined },
      }),
    ).toEqual({ edits: [], tokens: 71_100 });
  });
});
