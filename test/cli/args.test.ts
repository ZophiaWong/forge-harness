import { describe, expect, it } from "vitest";

import { parseTaskFromArgs } from "../../src/cli/args.js";

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
