import {
  type ContextKitConfig,
  type Strategy,
  type Threshold,
} from "./config.ts";

/** The `SettingItem` fields of `@earendil-works/pi-tui` that the panel uses. */
export interface PanelItem {
  id: "enabled" | "threshold" | "strategy";
  label: string;
  description: string;
  currentValue: string;
  values: string[];
}

const PI_LIMIT = "At Pi's limit";
const THRESHOLDS = [
  ...[50, 60, 70, 75, 80, 90].map((percent) => `${percent}% full`),
  PI_LIMIT,
];
const METHODS: Readonly<Record<Strategy, string>> = {
  balanced: "Summary notes (recommended)",
  frugal: "Trim first",
  "pi-summary": "Pi's summary",
};

/** The settings the `/context-kit` panel edits, in plain words. The rest stay in the file. */
export function panelItems(config: ContextKitConfig): PanelItem[] {
  const threshold = thresholdText(config.threshold);
  const items: PanelItem[] = [
    {
      id: "enabled",
      label: "Automatic cleanup",
      description:
        "Makes room in a long conversation so the agent keeps working. Off leaves only Pi's own cleanup.",
      currentValue: config.enabled ? "On" : "Off",
      values: ["On", "Off"],
    },
    {
      id: "threshold",
      label: "Clean up when the context is",
      description:
        "Lower keeps answers faster and cheaper. Higher keeps more detail. At Pi's limit waits as long as Pi does.",
      currentValue: threshold,
      values: THRESHOLDS.includes(threshold)
        ? THRESHOLDS
        : [threshold, ...THRESHOLDS],
    },
  ];
  if (config.customOrder) return items;
  items.push({
    id: "strategy",
    label: "Cleanup method",
    description:
      "Summary notes: the agent writes notes ahead of time and they replace old messages. Trim first: shorten large old outputs, with no extra model call. Pi's summary: Pi's own summary.",
    currentValue: METHODS[config.strategy],
    values: Object.values(METHODS),
  });
  return items;
}

/** The JSON value to write for a panel choice. */
export function settingValue(id: string, value: string): unknown {
  if (id === "enabled") return value === "On";
  if (id === "strategy")
    return Object.entries(METHODS).find(([, label]) => label === value)?.[0];
  if (value === PI_LIMIT) return "pi";
  const tokens = /^(\d+) tokens$/.exec(value);
  return tokens ? Number(tokens[1]) : value.replace(/ full$/, "");
}

/** One line for modes without the panel. */
export function summaryText(config: ContextKitConfig, file: string): string {
  if (!config.enabled)
    return `pi-context-kit: automatic cleanup off. Settings: ${file}`;
  const at =
    config.threshold === "pi" ? "Pi's limit" : thresholdText(config.threshold);
  const method = config.customOrder
    ? `custom methods (${config.methodOrder.join(", ") || "none"})`
    : METHODS[config.strategy].replace(" (recommended)", "").toLowerCase();
  return `pi-context-kit: automatic cleanup at ${at}, with ${method}. Settings: ${file}`;
}

function thresholdText(threshold: Threshold): string {
  if (threshold === "pi") return PI_LIMIT;
  return "tokens" in threshold
    ? `${threshold.tokens} tokens`
    : `${threshold.percent}% full`;
}
