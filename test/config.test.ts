import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  isRecord,
  ownThreshold,
  readConfig,
  speculationLead,
} from "../src/config.ts";

describe("readConfig", () => {
  it("uses the defaults when the value is absent", () => {
    expect(readConfig(undefined)).toEqual({
      config: DEFAULT_CONFIG,
      problems: [],
    });
    expect(DEFAULT_CONFIG.threshold).toEqual({ percent: 75 });
    expect(DEFAULT_CONFIG.strategy).toBe("balanced");
    expect(DEFAULT_CONFIG.methodOrder).toEqual(["handoff", "shake", "soft"]);
    expect(DEFAULT_CONFIG.background).toBe(true);
  });

  it.each([
    [150_000, { tokens: 150_000 }],
    ["60%", { percent: 60 }],
    ["72.5%", { percent: 72.5 }],
    ["pi", "pi"],
  ])("reads threshold %j", (threshold, expected) => {
    const { config, problems } = readConfig({ threshold });
    expect(problems).toEqual([]);
    expect(config.threshold).toEqual(expected);
  });

  it.each([0, -1, 1.5, "150000", "0%", "101%", "75 %", "%", true])(
    "rejects threshold %j",
    (threshold) => {
      const { config, problems } = readConfig({ threshold });
      expect(config.threshold).toEqual(DEFAULT_CONFIG.threshold);
      expect(problems).toEqual([
        'threshold must be a positive integer (tokens), a percentage such as "75%", or "pi" (default used)',
      ]);
    },
  );

  it.each([
    ["balanced", ["handoff", "shake", "soft"], true],
    ["frugal", ["shake", "handoff", "soft"], false],
    ["pi-summary", ["soft"], false],
  ])("maps strategy %s to its methods", (strategy, methodOrder, background) => {
    const { config, problems } = readConfig({ strategy });
    expect(problems).toEqual([]);
    expect(config.strategy).toBe(strategy);
    expect(config.methodOrder).toEqual(methodOrder);
    expect(config.background).toBe(background);
  });

  it("lets advanced settings replace the strategy and the tuning defaults", () => {
    const { config, problems } = readConfig({
      enabled: false,
      advanced: {
        methodOrder: ["shake", "soft", "shake"],
        background: false,
        supersedeReads: false,
        progressRatio: 0.5,
        prune: { enabled: false, protectTokens: 10_000 },
        shake: { minSavings: 1_000 },
      },
    });
    expect(problems).toEqual([]);
    expect(config.enabled).toBe(false);
    expect(config.methodOrder).toEqual(["shake", "soft"]);
    expect(config.background).toBe(false);
    expect(config.supersedeReads).toBe(false);
    expect(config.progressRatio).toBe(0.5);
    expect(config.prune).toEqual({
      ...DEFAULT_CONFIG.prune,
      enabled: false,
      protectTokens: 10_000,
    });
    expect(config.shake).toEqual({
      ...DEFAULT_CONFIG.shake,
      minSavings: 1_000,
    });
  });

  it("accepts the $schema key", () => {
    expect(readConfig({ $schema: "./schema.json" }).problems).toEqual([]);
    expect(
      readConfig({ advanced: { $schema: "./schema.json" } }).problems,
    ).toEqual(["advanced.$schema is not a setting"]);
  });

  it("warns when a strategy is set together with advanced.methodOrder", () => {
    const { config, problems } = readConfig({
      strategy: "frugal",
      advanced: { methodOrder: ["soft"] },
    });
    expect(config.methodOrder).toEqual(["soft"]);
    expect(problems).toEqual([
      'strategy "frugal" does not set the method order, because advanced.methodOrder replaces it',
    ]);
  });

  it("warns when a background note is requested without a handoff note", () => {
    const { problems } = readConfig({
      advanced: { methodOrder: ["soft", "handoff"], background: true },
    });
    expect(problems).toEqual([
      'advanced.background has no effect, because "handoff" is not before "soft" in the method order',
    ]);
  });

  it("accepts a background setting that the chosen strategy does not use", () => {
    // The panel changes the strategy and keeps advanced.background.
    expect(
      readConfig({ strategy: "pi-summary", advanced: { background: true } })
        .problems,
    ).toEqual([]);
  });

  it("reports each invalid value and keeps its default", () => {
    const { config, problems } = readConfig({
      enabled: "yes",
      strategy: "fast",
      advanced: {
        methodOrder: ["handoff", "remote"],
        progressRatio: 0,
        prune: { minTokens: 1.5 },
        shake: "off",
      },
      thresholdTokens: 150_000,
    });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(problems).toEqual([
      "enabled must be true or false (default used)",
      'strategy must be "balanced", "frugal" or "pi-summary" (default used)',
      'advanced.methodOrder must be a list of "handoff", "shake" and "soft" (default used)',
      "advanced.progressRatio must be a number above 0, up to 1 (default used)",
      "advanced.prune.minTokens must be a whole number, 0 or more (default used)",
      "advanced.shake must be an object (default used)",
      "thresholdTokens is not a setting",
    ]);
  });

  it("rejects a value that is not an object", () => {
    expect(readConfig(3)).toEqual({
      config: DEFAULT_CONFIG,
      problems: ["the settings must be an object (default used)"],
    });
  });
});

describe("ownThreshold", () => {
  it("takes a percentage of the context window by default", () => {
    expect(ownThreshold(DEFAULT_CONFIG, 200_000)).toBe(150_000);
  });

  it("caps a percentage below the whole window", () => {
    expect(
      ownThreshold({ ...DEFAULT_CONFIG, threshold: { percent: 100 } }, 200_000),
    ).toBe(198_000);
  });

  it("caps tokens below the whole window", () => {
    const at = (tokens: number) =>
      ownThreshold({ ...DEFAULT_CONFIG, threshold: { tokens } }, 200_000);
    expect(at(100_000)).toBe(100_000);
    expect(at(500_000)).toBe(199_999);
  });

  it("leaves only Pi's threshold for pi", () => {
    expect(ownThreshold({ ...DEFAULT_CONFIG, threshold: "pi" }, 200_000)).toBe(
      Number.POSITIVE_INFINITY,
    );
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

describe("context-kit.schema.json", () => {
  it("declares every setting with the defaults that readConfig uses", () => {
    const schema: unknown = JSON.parse(
      readFileSync(
        new URL("../context-kit.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const defaults = (node: unknown): unknown => {
      if (!isRecord(node)) return undefined;
      if (isRecord(node.properties))
        return Object.fromEntries(
          Object.entries(node.properties)
            .map(([key, child]) => [key, defaults(child)])
            .filter(([, value]) => value !== undefined),
        );
      return node.default;
    };
    expect(readConfig(defaults(schema))).toEqual({
      config: DEFAULT_CONFIG,
      problems: [],
    });
  });

  it.each([
    "75%",
    "72.5%",
    "100%",
    "100.0%",
    "0.5%",
    "007%",
    "0100%",
    "0%",
    "0.0%",
    "100.5%",
    "101%",
    ".5%",
    "75 %",
    "%",
  ])("matches readConfig for the threshold %s", (threshold) => {
    const text = readFileSync(
      new URL("../context-kit.schema.json", import.meta.url),
      "utf8",
    );
    const pattern = /"pattern": "(.+)"/.exec(text)?.[1];
    expect(pattern).toBeDefined();
    const valid = readConfig({ threshold }).problems.length === 0;
    expect(new RegExp(JSON.parse(`"${pattern}"`)).test(threshold)).toBe(valid);
  });
});
