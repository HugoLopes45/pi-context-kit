import type { PruneOptions } from "./prune.ts";
import type { ShakeOptions } from "./shake.ts";

export interface ContextKitConfig {
  /** Turns off maintenance and handoff compaction. `recall` stays available. */
  enabled: boolean;
  /** Compact above this many tokens. -1 uses `thresholdPercent`. Overrides `thresholdPercent`. */
  thresholdTokens: number;
  /** Compact above this percentage of the context window. -1 uses Pi's threshold only. */
  thresholdPercent: number;
  /** What to try, in order, when the context stays above the threshold after pruning. */
  methodOrder: Method[];
  /** Replace older reads of a file that was read again. */
  supersedeReads: boolean;
  /** Superseded reads are replaced only within this many newest tokens, to keep the prompt cache. */
  staleSuffixTokens: number;
  prune: PruneOptions & { enabled: boolean };
  shake: ShakeOptions;
  /** Pruning and shaking must reach this fraction of the threshold, or compaction runs instead. */
  progressRatio: number;
  /** Write the handoff note in the background before the threshold. */
  asyncEnabled: boolean;
}

/**
 * `handoff`: compact with a note written by the session model.
 * `shake`: elide large blocks and images from older messages, without a model call.
 * `soft`: leave compaction to Pi's own summary.
 */
export type Method = "handoff" | "shake" | "soft";

const METHODS: readonly Method[] = ["handoff", "shake", "soft"];
/** Methods that oh-my-pi offers and Pi lacks. They are skipped like methods that are unavailable. */
const UNAVAILABLE: readonly unknown[] = ["remote", "snapcompact"];

export const DEFAULT_CONFIG: ContextKitConfig = {
  enabled: true,
  thresholdTokens: -1,
  thresholdPercent: -1,
  methodOrder: [...METHODS],
  supersedeReads: true,
  staleSuffixTokens: 8_000,
  prune: {
    enabled: true,
    protectTokens: 40_000,
    minSavings: 20_000,
    minTokens: 50,
  },
  shake: {
    protectTokens: 16_000,
    minSavings: 4_000,
    blockMinTokens: 400,
  },
  progressRatio: 0.8,
  asyncEnabled: true,
};

export interface ConfigResult {
  config: ContextKitConfig;
  /** One message per invalid value. Each invalid value keeps its default. */
  problems: string[];
}

type Check<T> = { test: (value: unknown) => value is T; must: string };

const boolean: Check<boolean> = {
  test: (value) => typeof value === "boolean",
  must: "a boolean",
};
const count: Check<number> = {
  test: (value): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0,
  must: "a non-negative integer",
};
const tokens: Check<number> = {
  test: (value): value is number =>
    value === -1 || (Number.isSafeInteger(value) && Number(value) > 0),
  must: "-1 or a positive integer",
};
const percent: Check<number> = {
  test: (value): value is number =>
    value === -1 || (typeof value === "number" && value > 0 && value <= 100),
  must: "-1 or a number in (0, 100]",
};
const ratio: Check<number> = {
  test: (value): value is number =>
    typeof value === "number" && value > 0 && value <= 1,
  must: "a number in (0, 1]",
};

const isMethod = (value: unknown): value is Method =>
  METHODS.some((method) => method === value);
const methodOrder: Check<unknown[]> = {
  test: (value): value is unknown[] =>
    Array.isArray(value) &&
    value.every((method) => isMethod(method) || UNAVAILABLE.includes(method)),
  must: 'an array of "handoff", "shake", "soft", "remote" or "snapcompact"',
};

/** Reads the keys of one settings object and reports invalid or unknown keys. */
class Section {
  readonly #raw: Record<string, unknown>;
  readonly #path: string;
  readonly #problems: string[];
  readonly #known = new Set<string>();

  constructor(raw: unknown, path: string, problems: string[]) {
    this.#path = path;
    this.#problems = problems;
    if (raw === undefined || isRecord(raw)) this.#raw = raw ?? {};
    else {
      problems.push(`${path} must be an object`);
      this.#raw = {};
    }
  }

  get<T>(key: string, check: Check<T>, fallback: T): T {
    this.#known.add(key);
    const value = this.#raw[key];
    if (value === undefined) return fallback;
    if (check.test(value)) return value;
    this.#problems.push(`${this.#path}.${key} must be ${check.must}`);
    return fallback;
  }

  section(key: string): Section {
    this.#known.add(key);
    return new Section(this.#raw[key], `${this.#path}.${key}`, this.#problems);
  }

  /** Reports keys that no `get` or `section` call read. Call it last. */
  done(): void {
    for (const key of Object.keys(this.#raw))
      if (!this.#known.has(key))
        this.#problems.push(`${this.#path}.${key} is not a setting`);
  }
}

/** Validates the `contextKit` value of Pi's settings. */
export function readConfig(raw: unknown): ConfigResult {
  const problems: string[] = [];
  const d = DEFAULT_CONFIG;
  const root = new Section(raw, "contextKit", problems);
  const enabled = root.get("enabled", boolean, d.enabled);
  const thresholdTokens = root.get(
    "thresholdTokens",
    tokens,
    d.thresholdTokens,
  );
  const thresholdPercent = root.get(
    "thresholdPercent",
    percent,
    d.thresholdPercent,
  );
  const methods = root.get("methodOrder", methodOrder, d.methodOrder);
  const supersedeReads = root.get("supersedeReads", boolean, d.supersedeReads);
  const staleSuffixTokens = root.get(
    "staleSuffixTokens",
    count,
    d.staleSuffixTokens,
  );
  const progressRatio = root.get("progressRatio", ratio, d.progressRatio);

  const p = root.section("prune");
  const prune = {
    enabled: p.get("enabled", boolean, d.prune.enabled),
    protectTokens: p.get("protectTokens", count, d.prune.protectTokens),
    minSavings: p.get("minSavings", count, d.prune.minSavings),
    minTokens: p.get("minTokens", count, d.prune.minTokens),
  };
  p.done();

  const s = root.section("shake");
  const shake = {
    protectTokens: s.get("protectTokens", count, d.shake.protectTokens),
    minSavings: s.get("minSavings", count, d.shake.minSavings),
    blockMinTokens: s.get("blockMinTokens", count, d.shake.blockMinTokens),
  };
  s.done();

  const asyncEnabled = root.get("asyncEnabled", boolean, d.asyncEnabled);
  root.done();

  return {
    config: {
      enabled,
      thresholdTokens,
      thresholdPercent,
      methodOrder: [...new Set(methods.filter(isMethod))],
      supersedeReads,
      staleSuffixTokens,
      prune,
      shake,
      progressRatio,
      asyncEnabled,
    },
    problems,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The configured threshold for this context window, or +Infinity when only Pi's threshold applies. */
export function ownThreshold(
  config: ContextKitConfig,
  contextWindow: number,
): number {
  if (config.thresholdTokens > 0)
    return Math.min(contextWindow - 1, config.thresholdTokens);
  if (config.thresholdPercent > 0)
    return Math.floor(
      (contextWindow * Math.min(99, config.thresholdPercent)) / 100,
    );
  return Number.POSITIVE_INFINITY;
}

/**
 * How many tokens before the threshold the background note starts: an eighth of the threshold,
 * so the band scales with the window, bounded so small windows do not start a note every turn
 * and large ones do not miss too much history.
 */
export function speculationLead(threshold: number): number {
  return Number.isFinite(threshold) && threshold > 0
    ? Math.min(32_000, Math.floor(threshold / 8))
    : 0;
}
