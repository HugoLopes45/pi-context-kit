import { describe, expect, it } from "vitest";
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
      tokens: 71_100,
      threshold: 70_000,
    });
    expect(plan.edits.map((edit) => edit.targetId)).toEqual([old]);
    expect(plan.tokens).toBeLessThan(56_000);
  });

  it("leaves reduction to compaction when pruning is not enough", () => {
    const t = new Transcript();
    t.tool("bash", { command: "a" }, filler(21_000));
    t.tool("bash", { command: "b" }, filler(60_000));
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      tokens: 81_100,
      threshold: 70_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 81_100 });
  });
});
