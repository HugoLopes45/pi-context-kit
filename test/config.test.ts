import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ownThreshold,
  readConfig,
  speculationLead,
} from "../src/config.ts";

describe("readConfig", () => {
  it("uses the defaults when the key is absent", () => {
    expect(readConfig(undefined)).toEqual({
      config: DEFAULT_CONFIG,
      problems: [],
    });
    expect(DEFAULT_CONFIG.methodOrder).toEqual(["handoff", "shake", "soft"]);
  });

  it("merges valid values over the defaults, including nested ones", () => {
    const { config, problems } = readConfig({
      enabled: false,
      thresholdTokens: 150_000,
      methodOrder: ["shake", "soft"],
      prune: { enabled: false, protectTokens: 10_000 },
      shake: { minSavings: 1_000 },
      progressRatio: 0.5,
    });
    expect(problems).toEqual([]);
    expect(config.enabled).toBe(false);
    expect(config.thresholdTokens).toBe(150_000);
    expect(config.methodOrder).toEqual(["shake", "soft"]);
    expect(config.prune).toEqual({
      ...DEFAULT_CONFIG.prune,
      enabled: false,
      protectTokens: 10_000,
    });
    expect(config.shake).toEqual({
      ...DEFAULT_CONFIG.shake,
      minSavings: 1_000,
    });
    expect(config.progressRatio).toBe(0.5);
  });

  it("skips OMP methods that Pi lacks and duplicates, as unavailable methods", () => {
    const { config, problems } = readConfig({
      methodOrder: ["remote", "snapcompact", "soft", "handoff", "soft"],
    });
    expect(problems).toEqual([]);
    expect(config.methodOrder).toEqual(["soft", "handoff"]);
  });

  it("reports each invalid value and keeps its default", () => {
    const { config, problems } = readConfig({
      enabled: "yes",
      thresholdTokens: 0,
      thresholdPercent: 150,
      methodOrder: ["handoff", "magic"],
      progressRatio: 0,
      prune: { minTokens: 1.5 },
      shake: "off",
      unknown: 1,
    });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(problems).toEqual([
      "contextKit.enabled must be a boolean",
      "contextKit.thresholdTokens must be -1 or a positive integer",
      "contextKit.thresholdPercent must be -1 or a number in (0, 100]",
      'contextKit.methodOrder must be an array of "handoff", "shake", "soft", "remote" or "snapcompact"',
      "contextKit.progressRatio must be a number in (0, 1]",
      "contextKit.prune.minTokens must be a non-negative integer",
      "contextKit.shake must be an object",
      "contextKit.unknown is not a setting",
    ]);
  });

  it("rejects a value that is not an object", () => {
    expect(readConfig(3)).toEqual({
      config: DEFAULT_CONFIG,
      problems: ["contextKit must be an object"],
    });
  });
});

describe("ownThreshold", () => {
  it("is unset by default", () => {
    expect(ownThreshold(DEFAULT_CONFIG, 200_000)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("takes a percentage of the context window, below the whole window", () => {
    const at = (thresholdPercent: number) =>
      ownThreshold({ ...DEFAULT_CONFIG, thresholdPercent }, 200_000);
    expect(at(75)).toBe(150_000);
    expect(at(100)).toBe(198_000);
  });

  it("prefers thresholdTokens over thresholdPercent, below the whole window", () => {
    const at = (thresholdTokens: number) =>
      ownThreshold(
        { ...DEFAULT_CONFIG, thresholdTokens, thresholdPercent: 75 },
        200_000,
      );
    expect(at(100_000)).toBe(100_000);
    expect(at(500_000)).toBe(199_999);
  });
});

describe("speculationLead", () => {
  it("scales to small thresholds without exceeding them", () => {
    expect(speculationLead(8)).toBe(1);
    expect(speculationLead(80_000)).toBe(10_000);
    expect(speculationLead(1_000_000)).toBe(32_000);
    expect(speculationLead(0)).toBe(0);
    expect(speculationLead(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
