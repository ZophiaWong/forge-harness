import { describe, expect, it } from "vitest";

import { runPortfolioDemo } from "../../src/portfolio/demo.js";

describe("deterministic portfolio demo", () => {
  it("runs the three independent scenes in evidence order", async () => {
    const result = await runPortfolioDemo();

    expect(result.exitCode).toBe(0);
    expect(result.lines.map((line) => line.label)).toEqual([
      "scene.action-boundary",
      "scene.verification-recovery",
      "scene.coordination-completion",
    ]);
    expect(result.lines.map((line) => line.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(result.lines.some((line) => line.receipt === "deny-before-dispatch")).toBe(true);
    expect(result.lines.some((line) => line.receipt === "recovery-before-final")).toBe(true);
    expect(result.lines.some((line) => line.receipt === "receipt-before-ready")).toBe(true);
    expect(result.cleaned).toBe(true);
  });

  it("returns non-zero and still cleans temporary resources when a scene fails", async () => {
    const result = await runPortfolioDemo({ failScene: "verification-recovery" });

    expect(result.exitCode).not.toBe(0);
    expect(result.cleaned).toBe(true);
    expect(result.lines[0]?.status).toBe("PASS");
    expect(result.lines[1]?.status).toBe("FAIL");
  });
});

