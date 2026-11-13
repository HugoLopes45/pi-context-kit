import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSettings,
  loadSettings,
  mergeSettings,
  saveSetting,
  settingsPaths,
  updateSetting,
} from "../src/settings-file.ts";

function dirs() {
  const agentDir = mkdtempSync(join(tmpdir(), "context-kit-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "context-kit-cwd-"));
  mkdirSync(join(cwd, ".pi"));
  return { agentDir, cwd };
}

describe("settingsPaths", () => {
  it("reads the project file only in a trusted project", () => {
    const { agentDir, cwd } = dirs();
    expect(settingsPaths(agentDir, cwd, true)).toEqual({
      global: join(agentDir, "context-kit.json"),
      project: join(cwd, ".pi", "context-kit.json"),
    });
    expect(settingsPaths(agentDir, cwd, false)).toEqual({
      global: join(agentDir, "context-kit.json"),
      project: undefined,
    });
  });
});

describe("loadSettings", () => {
  it("returns nothing when no file exists", () => {
    const { agentDir, cwd } = dirs();
    expect(loadSettings(settingsPaths(agentDir, cwd, true))).toEqual({
      raw: {},
      problems: [],
    });
  });

  it("merges the project file over the global file, key by key", () => {
    const { agentDir, cwd } = dirs();
    const paths = settingsPaths(agentDir, cwd, true);
    writeFileSync(
      paths.global,
      JSON.stringify({
        threshold: "60%",
        advanced: { prune: { protectTokens: 1, minTokens: 2 } },
      }),
    );
    writeFileSync(
      paths.project ?? "",
      JSON.stringify({
        strategy: "frugal",
        advanced: { prune: { minTokens: 3 }, methodOrder: ["soft"] },
      }),
    );
    expect(loadSettings(paths)).toEqual({
      raw: {
        threshold: "60%",
        strategy: "frugal",
        advanced: {
          prune: { protectTokens: 1, minTokens: 3 },
          methodOrder: ["soft"],
        },
      },
      problems: [],
    });
  });

  it("reports a file that is not valid JSON and ignores it", () => {
    const { agentDir, cwd } = dirs();
    const paths = settingsPaths(agentDir, cwd, true);
    writeFileSync(paths.global, "{ threshold: 1 ");
    writeFileSync(paths.project ?? "", JSON.stringify({ enabled: false }));
    const { raw, problems } = loadSettings(paths);
    expect(raw).toEqual({ enabled: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      new RegExp(`^${paths.global} is not valid JSON \\(.+\\), file ignored$`),
    );
  });
});

describe("saveSetting", () => {
  it("writes the global file unless the project file sets the key", () => {
    const { agentDir, cwd } = dirs();
    const paths = settingsPaths(agentDir, cwd, true);
    const project = paths.project ?? "";
    writeFileSync(project, JSON.stringify({ threshold: "60%" }));
    expect(saveSetting(paths, "strategy", "frugal")).toBe(paths.global);
    expect(saveSetting(paths, "threshold", "80%")).toBe(project);
    expect(loadSettings(paths).raw).toEqual({
      strategy: "frugal",
      threshold: "80%",
    });
  });
});

describe("updateSetting", () => {
  it("creates the file and keeps other keys when it changes one", () => {
    const { agentDir } = dirs();
    const file = join(agentDir, "nested", "context-kit.json");
    updateSetting(file, "threshold", "60%");
    updateSetting(file, "strategy", "frugal");
    updateSetting(file, "threshold", 120_000);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      threshold: 120_000,
      strategy: "frugal",
    });
  });

  it("writes through a symbolic link and keeps the link", () => {
    const { agentDir, cwd } = dirs();
    const target = join(cwd, "dotfiles.json");
    writeFileSync(target, JSON.stringify({ enabled: true }));
    const link = join(agentDir, "context-kit.json");
    symlinkSync(target, link);
    updateSetting(link, "enabled", false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      enabled: false,
    });
  });

  it("refuses to overwrite a file that is not valid JSON", () => {
    const { agentDir } = dirs();
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, "{ broken");
    expect(() => updateSetting(file, "enabled", false)).toThrow(
      /is not valid JSON/,
    );
    expect(readFileSync(file, "utf8")).toBe("{ broken");
  });

  it("keeps the permissions of the file", () => {
    const { agentDir } = dirs();
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o600);
    updateSetting(file, "enabled", false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file when the write fails", () => {
    const { agentDir } = dirs();
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, "{}");
    // A read-only file where the new content is written first makes the write fail.
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, "");
    chmodSync(temporary, 0o444);
    expect(() => updateSetting(file, "enabled", false)).toThrow();
    expect(readdirSync(agentDir)).toEqual(["context-kit.json"]);
    expect(readFileSync(file, "utf8")).toBe("{}");
  });
});

describe("mergeSettings", () => {
  it("keeps a __proto__ key as a setting, so the checks report it", () => {
    const merged = mergeSettings(
      {},
      JSON.parse('{"__proto__": {"enabled": false}}'),
    );
    expect(Object.keys(merged)).toEqual(["__proto__"]);
    expect(Reflect.get(merged, "enabled")).toBeUndefined();
  });
});

describe("createSettings", () => {
  it("creates the file and its folder, but keeps an existing file", () => {
    const { cwd } = dirs();
    const file = join(cwd, "new", "context-kit.json");
    expect(createSettings(file, { threshold: "pi" })).toBe(true);
    expect(createSettings(file, { threshold: 1 })).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ threshold: "pi" });
    expect(readdirSync(join(cwd, "new"))).toEqual(["context-kit.json"]);
  });
});
