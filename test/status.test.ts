import { describe, expect, it } from "vitest";
import { freedNotice, statusText } from "../src/status.ts";

describe("statusText", () => {
  it("shows the context use and the threshold as shares of the window", () => {
    expect(
      statusText({ tokens: 124_000, limit: 150_000, contextWindow: 200_000 }),
    ).toBe("Context 62% · cleanup at 75%");
  });

  it.each([
    ["writing", "Context 70% · cleanup at 75% · writing summary"],
    ["ready", "Context 70% · cleanup at 75% · summary ready"],
  ] as const)("adds the background note when it is %s", (note, text) => {
    expect(
      statusText({
        tokens: 140_000,
        limit: 150_000,
        contextWindow: 200_000,
        note,
      }),
    ).toBe(text);
  });

  it("rounds down, so 100% means the window is full", () => {
    expect(
      statusText({ tokens: 199_999, limit: 199_999, contextWindow: 200_000 }),
    ).toBe("Context 99% · cleanup at 99%");
  });

  it("omits the threshold when nothing compacts", () => {
    expect(
      statusText({
        tokens: 50_000,
        limit: Number.POSITIVE_INFINITY,
        contextWindow: 200_000,
      }),
    ).toBe("Context 25% · no automatic cleanup");
  });
});

describe("freedNotice", () => {
  it.each([
    [
      180_000,
      146_000,
      "pi-context-kit freed 17% of the context (34k tokens). The agent can still look up what was removed.",
    ],
    [
      10_000,
      9_400,
      "pi-context-kit freed 0% of the context (600 tokens). The agent can still look up what was removed.",
    ],
  ])("states %i to %i as a share and in tokens", (before, after, text) => {
    expect(freedNotice(before, after, 200_000)).toBe(text);
  });
});
