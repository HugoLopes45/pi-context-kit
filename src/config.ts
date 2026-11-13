import type { PruneOptions } from "./prune.ts";
import type { ShakeOptions } from "./shake.ts";

/** Where maintenance starts. `"pi"` leaves only Pi's own compaction threshold. */
export type Threshold = { tokens: number } | { percent: number } | "pi";

/**
 * `handoff`: compact with a note written by the session model.
 * `shake`: elide large blocks and images from older messages, without a model call.
 * `soft`: leave compaction to Pi's own summary.
 */
export type Method = "handoff" | "shake" | "soft";

/** Named method orders, so most users never edit `advanced.methodOrder`. */
export type Strategy = "balanced" | "frugal" | "pi-summary";

export const STRATEGIES: Readonly<
  Record<Strategy, { methodOrder: readonly Method[]; background: boolean }>
> = {
  balanced: { methodOrder: ["handoff", "shake", "soft"], background: true },
  frugal: { methodOrder: ["shake", "handoff", "soft"], background: false },
  "pi-summary": { methodOrder: ["soft"], background: false },
};

export interface ContextKitConfig {
  /** Turns off maintenance and handoff compaction. `recall` stays available. */
  enabled: boolean;
  threshold: Threshold;
  strategy: Strategy;
  /** What to try, in order, when the context stays above the threshold after pruning. */
  methodOrder: Method[];
  /** `advanced.methodOrder` sets the method order, so `strategy` does not. */
  customOrder: boolean;
  /** Write the handoff note in the background before the threshold. */
  background: boolean;
  /** Replace older reads of a file that was read again. */
  supersedeReads: boolean;
  prune: PruneOptions & { enabled: boolean };
  shake: ShakeOptions;
  /** Pruning and shaking must reach this fraction of the threshold, or compaction runs instead. */
  progressRatio: number;
}

export const DEFAULT_CONFIG: ContextKitConfig = {
  enabled: true,
  threshold: { percent: 75 },
  strategy: "balanced",
  methodOrder: [...STRATEGIES.balanced.methodOrder],
  customOrder: false,
  background: STRATEGIES.balanced.background,
  supersedeReads: true,
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
};

export interface ConfigResult {
  config: ContextKitConfig;
  /** One message per invalid value or ineffective combination. Each invalid value keeps its default. */
  problems: string[];
}

type Check<T> = { read: (value: unknown) => T | undefined; must: string };

const boolean: Check<boolean> = {
  read: (value) => (typeof value === "boolean" ? value : undefined),
  must: "true or false",
};
const count: Check<number> = {
  read: (value) =>
    Number.isSafeInteger(value) && Number(value) >= 0
      ? Number(value)
      : undefined,
  must: "a whole number, 0 or more",
};
const ratio: Check<number> = {
  read: (value) =>
    typeof value === "number" && value > 0 && value <= 1 ? value : undefined,
  must: "a number above 0, up to 1",
};
const threshold: Check<Threshold> = {
  read: parseThreshold,
  must: 'a positive integer (tokens), a percentage such as "75%", or "pi"',
};
export const isStrategy = (value: unknown): value is Strategy =>
  value === "balanced" || value === "frugal" || value === "pi-summary";
const strategy: Check<Strategy> = {
  read: (value) => (isStrategy(value) ? value : undefined),
  must: '"balanced", "frugal" or "pi-summary"',
};
export const isMethod = (value: unknown): value is Method =>
  value === "handoff" || value === "shake" || value === "soft";
const methodOrder: Check<Method[]> = {
  read: (value) =>
    Array.isArray(value) && value.every(isMethod)
      ? [...new Set(value)]
      : undefined,
  must: 'a list of "handoff", "shake" and "soft"',
};

function parseThreshold(value: unknown): Threshold | undefined {
  if (value === "pi") return "pi";
  if (Number.isSafeInteger(value) && Number(value) > 0)
    return { tokens: Number(value) };
  const match =
    typeof value === "string" ? /^(\d+(?:\.\d+)?)%$/.exec(value) : null;
  const percent = Number(match?.[1]);
  return percent > 0 && percent <= 100 ? { percent } : undefined;
}

/** Reads the keys of one settings object and reports invalid or unknown keys. */
class Section {
  readonly #raw: Record<string, unknown>;
  readonly #prefix: string;
  readonly #problems: string[];
  readonly #known = new Set<string>();

  constructor(raw: unknown, path: string, problems: string[]) {
    this.#prefix = path ? `${path}.` : "";
    this.#problems = problems;
    // Editors read `$schema` at the root of the file only.
    if (!path) this.#known.add("$schema");
    if (raw === undefined || isRecord(raw)) this.#raw = raw ?? {};
    else {
      problems.push(
        `${path || "the settings"} must be an object (default used)`,
      );
      this.#raw = {};
    }
  }

  /** Whether the key holds a valid value, so the default was not used. */
  provides<T>(key: string, check: Check<T>): boolean {
    return check.read(this.#raw[key]) !== undefined;
  }

  get<T>(key: string, check: Check<T>, fallback: T): T {
    this.#known.add(key);
    const value = this.#raw[key];
    if (value === undefined) return fallback;
    const parsed = check.read(value);
    if (parsed !== undefined) return parsed;
    this.#problems.push(
      `${this.#prefix}${key} must be ${check.must} (default used)`,
    );
    return fallback;
  }

  section(key: string): Section {
    this.#known.add(key);
    return new Section(this.#raw[key], `${this.#prefix}${key}`, this.#problems);
  }

  /** Reports keys that no `get` or `section` call read. Call it last. */
  done(): void {
    for (const key of Object.keys(this.#raw))
      if (!this.#known.has(key))
        this.#problems.push(`${this.#prefix}${key} is not a setting`);
  }
}

/** Validates the merged contents of the settings files. */
export function readConfig(raw: unknown): ConfigResult {
  const problems: string[] = [];
  const d = DEFAULT_CONFIG;
  const root = new Section(raw, "", problems);
  const enabled = root.get("enabled", boolean, d.enabled);
  const limit = root.get("threshold", threshold, d.threshold);
  const named = root.get("strategy", strategy, d.strategy);
  const a = root.section("advanced");
  const methods = a.get(
    "methodOrder",
    methodOrder,
    STRATEGIES[named].methodOrder,
  );
  const background = a.get("background", boolean, STRATEGIES[named].background);
  const supersedeReads = a.get("supersedeReads", boolean, d.supersedeReads);
  const progressRatio = a.get("progressRatio", ratio, d.progressRatio);
  const prune = readPrune(a.section("prune"));
  const shake = readShake(a.section("shake"));
  a.done();
  root.done();

  const customOrder = a.provides("methodOrder", methodOrder);
  if (root.provides("strategy", strategy) && customOrder)
    problems.push(
      `strategy "${named}" does not set the method order, because advanced.methodOrder replaces it`,
    );
  if (
    customOrder &&
    a.provides("background", boolean) &&
    background &&
    !writesHandoff(methods)
  )
    problems.push(
      'advanced.background has no effect, because "handoff" is not before "soft" in the method order',
    );

  return {
    config: {
      enabled,
      threshold: limit,
      strategy: named,
      methodOrder: [...methods],
      customOrder,
      background,
      supersedeReads,
      prune,
      shake,
      progressRatio,
    },
    problems,
  };
}

function readPrune(p: Section): ContextKitConfig["prune"] {
  const d = DEFAULT_CONFIG.prune;
  const prune = {
    enabled: p.get("enabled", boolean, d.enabled),
    protectTokens: p.get("protectTokens", count, d.protectTokens),
    minSavings: p.get("minSavings", count, d.minSavings),
    minTokens: p.get("minTokens", count, d.minTokens),
  };
  p.done();
  return prune;
}

function readShake(s: Section): ShakeOptions {
  const d = DEFAULT_CONFIG.shake;
  const shake = {
    protectTokens: s.get("protectTokens", count, d.protectTokens),
    minSavings: s.get("minSavings", count, d.minSavings),
    blockMinTokens: s.get("blockMinTokens", count, d.blockMinTokens),
  };
  s.done();
  return shake;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Soft ends the extension's strategy chain, even when other methods follow it. */
export function before(
  methods: readonly Method[],
  a: Method,
  b: Method,
): boolean {
  const index = methods.indexOf(a);
  const other = methods.indexOf(b);
  const soft = methods.indexOf("soft");
  const stop = Math.min(
    other >= 0 ? other : Number.POSITIVE_INFINITY,
    soft >= 0 ? soft : Number.POSITIVE_INFINITY,
  );
  return index >= 0 && index < stop;
}

/** Whether the method order writes handoff notes at all. */
export function writesHandoff(methods: readonly Method[]): boolean {
  return before(methods, "handoff", "soft");
}

/** The configured threshold for this context window, or +Infinity when only Pi's threshold applies. */
export function ownThreshold(
  config: ContextKitConfig,
  contextWindow: number,
): number {
  const value = config.threshold;
  if (value === "pi") return Number.POSITIVE_INFINITY;
  if ("tokens" in value) return Math.min(contextWindow - 1, value.tokens);
  return Math.floor((contextWindow * Math.min(99, value.percent)) / 100);
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
