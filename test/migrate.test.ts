import { describe, expect, it } from "vitest";
import {
  type ContextKitConfig,
  readConfig,
  writesHandoff,
} from "../src/config.ts";
import { migrateLegacy, migrateProject } from "../src/migrate.ts";
import { mergeSettings } from "../src/settings-file.ts";

describe("migrateLegacy", () => {
  it("keeps Pi's limit when 0.3 had no threshold", () => {
    expect(migrateLegacy({})).toEqual({ threshold: "pi" });
  });

  it.each([
    [{ thresholdTokens: 150_000 }, 150_000],
    [{ thresholdPercent: 75 }, "75%"],
    [{ thresholdTokens: -1, thresholdPercent: 62.5 }, "62.5%"],
    [{ thresholdTokens: 120_000, thresholdPercent: 60 }, 120_000],
    [{ thresholdTokens: "lots" }, "pi"],
  ])("converts the threshold of %j", (legacy, threshold) => {
    expect(migrateLegacy(legacy)).toEqual({ threshold });
  });

  it.each([
    [{ methodOrder: ["handoff", "shake", "soft"] }, {}],
    [
      { methodOrder: ["shake", "handoff", "soft"] },
      { strategy: "frugal", advanced: { background: true } },
    ],
    [
      { methodOrder: ["shake", "handoff", "soft"], asyncEnabled: false },
      { strategy: "frugal" },
    ],
    [{ methodOrder: ["soft"] }, { strategy: "pi-summary" }],
    [{ asyncEnabled: false }, { advanced: { background: false } }],
    [
      { methodOrder: ["remote", "handoff", "snapcompact", "soft"] },
      { advanced: { methodOrder: ["handoff", "soft"] } },
    ],
    [
      { methodOrder: ["shake", "soft"], asyncEnabled: false },
      { advanced: { methodOrder: ["shake", "soft"] } },
    ],
    [{ methodOrder: "handoff" }, {}],
    [{ methodOrder: ["handoff", "magic"] }, {}],
    [
      { methodOrder: ["shake", "remote", "shake"] },
      { advanced: { methodOrder: ["shake"] } },
    ],
  ])("converts the methods of %j", (legacy, expected) => {
    const migrated = migrateLegacy(legacy);
    expect(migrated).toEqual({ threshold: "pi", ...expected });
    expect(readConfig(migrated).problems).toEqual([]);
  });

  it("keeps the other settings, the advanced ones under advanced", () => {
    const prune = { enabled: false, protectTokens: 10_000 };
    const shake = { minSavings: 1_000 };
    expect(
      migrateLegacy({
        enabled: false,
        supersedeReads: false,
        progressRatio: 0.5,
        prune,
        shake,
      }),
    ).toEqual({
      enabled: false,
      threshold: "pi",
      advanced: { supersedeReads: false, progressRatio: 0.5, prune, shake },
    });
  });
});

describe("migrateProject", () => {
  // 0.3 read the project block merged over the global block. The global block becomes the global file.
  it.each([
    [
      { thresholdPercent: 70 },
      { prune: { enabled: false } },
      { advanced: { prune: { enabled: false } } },
    ],
    [
      { thresholdTokens: 100_000 },
      { thresholdPercent: 60 },
      { threshold: 100_000 },
    ],
    [
      {},
      { enabled: false, thresholdPercent: 60 },
      { enabled: false, threshold: "60%" },
    ],
    [
      { asyncEnabled: false },
      { methodOrder: ["shake", "handoff", "soft"] },
      { strategy: "frugal", advanced: { background: false } },
    ],
    [
      { methodOrder: ["soft"] },
      { methodOrder: ["handoff", "shake", "soft"] },
      { strategy: "balanced", advanced: { background: true } },
    ],
    [
      { methodOrder: ["shake", "soft"] },
      { methodOrder: ["soft"] },
      { advanced: { methodOrder: ["soft"] } },
    ],
    [
      { methodOrder: ["shake", "handoff", "soft"] },
      { methodOrder: ["soft"] },
      { strategy: "pi-summary", advanced: { background: false } },
    ],
    [
      { asyncEnabled: false },
      { asyncEnabled: true },
      { strategy: "balanced", advanced: { background: true } },
    ],
  ])("converts global %j with project %j", (global, project, expected) => {
    const globalFile = migrateLegacy(global);
    const migrated = migrateProject(global, project, globalFile);
    expect(migrated).toEqual(expected);
    const effective = readConfig(mergeSettings(globalFile, migrated));
    expect(effective.problems).toEqual([]);
    expect(behavior(effective.config)).toEqual(
      behavior(
        readConfig(migrateLegacy(mergeSettings(global, project))).config,
      ),
    );
  });
});

/** What decides the work done: `strategy` and `customOrder` only say where the method order comes from, and background needs a handoff. */
function behavior({
  strategy: _strategy,
  customOrder: _customOrder,
  background,
  ...rest
}: ContextKitConfig) {
  return { ...rest, background: writesHandoff(rest.methodOrder) && background };
}
