import { describe, expect, it } from "vitest";

import { parseCliArgs, parseTaskFromArgs } from "../../src/cli/args.js";

describe("parseTaskFromArgs", () => {
  it("joins CLI args into one task", () => {
    expect(parseTaskFromArgs(["inspect", "this", "project"])).toBe("inspect this project");
  });

  it("trims the joined task", () => {
    expect(parseTaskFromArgs(["  inspect", "project  "])).toBe("inspect project");
  });

  it("returns undefined when no task text is provided", () => {
    expect(parseTaskFromArgs([" ", ""])).toBeUndefined();
  });
});

describe("parseCliArgs", () => {
  it("parses --show-history and keeps the remaining args as the task", () => {
    expect(parseCliArgs(["--show-history", "inspect", "history"])).toEqual({
      showHistory: true,
      task: "inspect history",
    });
  });

  it("defaults showHistory to false", () => {
    expect(parseCliArgs(["inspect", "history"])).toEqual({
      showHistory: false,
      task: "inspect history",
    });
  });

  it("returns no task when only --show-history is provided", () => {
    expect(parseCliArgs(["--show-history"])).toEqual({
      showHistory: true,
      task: undefined,
    });
  });
});
