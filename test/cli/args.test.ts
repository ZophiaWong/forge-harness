import { describe, expect, it } from "vitest";

import { parseTaskFromArgs, usageText } from "../../src/cli/args.js";

describe("parseTaskFromArgs", () => {
  it("joins command line words into one task", () => {
    expect(parseTaskFromArgs(["inspect", "this", "project"])).toBe("inspect this project");
  });

  it("returns undefined for empty input", () => {
    expect(parseTaskFromArgs([])).toBeUndefined();
    expect(parseTaskFromArgs(["  ", "\t"])).toBeUndefined();
  });
});

describe("usageText", () => {
  it("shows the build-first start command", () => {
    expect(usageText("forge-harness")).toContain('forge-harness "inspect this project"');
  });
});

