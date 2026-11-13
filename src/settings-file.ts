import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./config.ts";

const FILE_NAME = "context-kit.json";

export interface SettingsPaths {
  global: string;
  /** Undefined in an untrusted project, as Pi does for its own project settings. */
  project: string | undefined;
}

export function settingsPaths(
  agentDir: string,
  cwd: string,
  trusted: boolean,
): SettingsPaths {
  return {
    global: join(agentDir, FILE_NAME),
    project: trusted ? join(cwd, ".pi", FILE_NAME) : undefined,
  };
}

/** Merges the global and project files. A file that cannot be read is reported and ignored. */
export function loadSettings(paths: SettingsPaths): {
  raw: Record<string, unknown>;
  problems: string[];
} {
  const problems: string[] = [];
  let raw: Record<string, unknown> = {};
  for (const path of [paths.global, paths.project]) {
    if (!path) continue;
    try {
      raw = mergeSettings(raw, readSettingsFile(path));
    } catch (error) {
      problems.push(`${errorMessage(error)}, file ignored`);
    }
  }
  return { raw, problems };
}

/** Sets one top-level key and keeps the rest of the file. The file is replaced atomically. */
export function updateSetting(path: string, key: string, value: unknown) {
  const next = { ...readSettingsFile(path), [key]: value };
  // The rename replaces the target, so a symbolic link, for example to dotfiles, stays.
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
    if (existsSync(target)) chmodSync(temporary, statSync(target).mode);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Creates the file with this content. Returns false when the file exists, which it keeps. */
export function createSettings(
  path: string,
  content: Record<string, unknown>,
): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`);
    // The link appears complete or not at all, and fails when the file exists, so two Pi
    // processes cannot both create it.
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Writes the key where it takes effect: the project file when that file sets it, otherwise the
 * global file. Returns the path written.
 */
export function saveSetting(
  paths: SettingsPaths,
  key: string,
  value: unknown,
): string {
  const path =
    paths.project && readSettingsFile(paths.project)[key] !== undefined
      ? paths.project
      : paths.global;
  updateSetting(path, key, value);
  return path;
}

/** The content of one settings file, `{}` when it does not exist. Throws when it is not a JSON object. */
export function readSettingsFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw new Error(`${path} cannot be read (${errorMessage(error)})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${errorMessage(error)})`);
  }
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

/**
 * Merges `over` into `base` like Pi merges project settings over global ones: objects merge key by
 * key; any other value, including a list, replaces the base value.
 */
export function mergeSettings(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = result[key];
    // A plain assignment of "__proto__" would set the prototype instead of a key.
    Object.defineProperty(result, key, {
      value:
        isRecord(current) && isRecord(value)
          ? mergeSettings(current, value)
          : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
