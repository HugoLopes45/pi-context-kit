import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, readConfig } from "../src/config.ts";
import { panelItems, settingValue, summaryText } from "../src/panel.ts";

describe("panelItems", () => {
  it("shows the effective values in plain words with the choices to cycle through", () => {
    expect(
      panelItems(DEFAULT_CONFIG).map(({ id, label, currentValue, values }) => ({
        id,
        label,
        currentValue,
        values,
      })),
    ).toEqual([
      {
        id: "enabled",
        label: "Automatic cleanup",
        currentValue: "On",
        values: ["On", "Off"],
      },
      {
        id: "threshold",
        label: "Clean up when the context is",
        currentValue: "75% full",
        values: [
          "50% full",
          "60% full",
          "70% full",
          "75% full",
          "80% full",
          "90% full",
          "At Pi's limit",
        ],
      },
      {
        id: "strategy",
        label: "Cleanup method",
        currentValue: "Summary notes (recommended)",
        values: ["Summary notes (recommended)", "Trim first", "Pi's summary"],
      },
    ]);
  });

  it("keeps a custom threshold among the choices", () => {
    const tokens = panelItems({
      ...DEFAULT_CONFIG,
      threshold: { tokens: 120_000 },
    })[1];
    expect(tokens?.currentValue).toBe("120000 tokens");
    expect(tokens?.values[0]).toBe("120000 tokens");
    expect(tokens?.values).toHaveLength(8);
    const percent = panelItems({
      ...DEFAULT_CONFIG,
      threshold: { percent: 72.5 },
    })[1];
    expect(percent?.values[0]).toBe("72.5% full");
  });

  it("leaves the method to the file when advanced.methodOrder replaces it", () => {
    // The order equals the balanced one, but a strategy chosen in the panel would not change it.
    const { config } = readConfig({
      advanced: { methodOrder: ["handoff", "shake", "soft"] },
    });
    expect(panelItems(config).map((item) => item.id)).toEqual([
      "enabled",
      "threshold",
    ]);
  });

  it("describes each setting", () => {
    for (const item of panelItems(DEFAULT_CONFIG))
      expect(item.description).toMatch(/\S/);
  });
});

describe("settingValue", () => {
  it.each([
    ["enabled", "Off", false],
    ["enabled", "On", true],
    ["threshold", "80% full", "80%"],
    ["threshold", "72.5% full", "72.5%"],
    ["threshold", "120000 tokens", 120_000],
    ["threshold", "At Pi's limit", "pi"],
    ["strategy", "Summary notes (recommended)", "balanced"],
    ["strategy", "Trim first", "frugal"],
    ["strategy", "Pi's summary", "pi-summary"],
  ])("writes %s %s as %j", (id, value, written) => {
    expect(settingValue(id, value)).toEqual(written);
  });
});

describe("every panel choice", () => {
  const configs = [
    DEFAULT_CONFIG,
    readConfig({ threshold: 120_000 }).config,
    readConfig({ threshold: "pi", enabled: false }).config,
  ];
  const choices = configs.flatMap((config) =>
    panelItems(config).flatMap((item) =>
      item.values.map((value) => [item.id, value] as const),
    ),
  );
  it.each(choices)(
    "saves %s %s as a valid setting that shows the same choice",
    (id, value) => {
      const { config, problems } = readConfig({
        [id]: settingValue(id, value),
      });
      expect(problems).toEqual([]);
      expect(
        panelItems(config).find((item) => item.id === id)?.currentValue,
      ).toBe(value);
    },
  );
});

describe("summaryText", () => {
  it("states the effective settings and the file to edit", () => {
    expect(
      summaryText(DEFAULT_CONFIG, "/home/u/.pi/agent/context-kit.json"),
    ).toBe(
      "pi-context-kit: automatic cleanup at 75% full, with summary notes. Settings: /home/u/.pi/agent/context-kit.json",
    );
  });

  it("says when the cleanup is off", () => {
    expect(summaryText({ ...DEFAULT_CONFIG, enabled: false }, "f.json")).toBe(
      "pi-context-kit: automatic cleanup off. Settings: f.json",
    );
  });

  it("says when advanced.methodOrder replaces the method", () => {
    expect(
      summaryText(
        readConfig({
          threshold: "pi",
          advanced: { methodOrder: ["shake", "soft"] },
        }).config,
        "f.json",
      ),
    ).toBe(
      "pi-context-kit: automatic cleanup at Pi's limit, with custom methods (shake, soft). Settings: f.json",
    );
  });
});
