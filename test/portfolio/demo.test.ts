import { describe, expect, it } from "vitest";

import { main, runPortfolioDemo } from "../../src/portfolio/demo.js";

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

  it("collects stable, redacted annotations from the three executed scenes", async () => {
    const result = await runPortfolioDemo({ explain: true });

    expect(result.exitCode).toBe(0);
    expect(result.explanations).toEqual([
      "explain.action-boundary policy=denied dispatches=0",
      "explain.verification-recovery verification=failed recovery=attempted verification=passed final=accepted",
      "explain.coordination-completion task=approved gate=incomplete worktree=written fingerprint=captured verification=passed integration=recorded gate=ready",
    ]);
    expect(result.explanations.join("\n")).not.toMatch(/(?:^|\s)\/[\w/.-]+|portfolio-session|portfolio-editor-write|[a-f0-9]{40}/i);
  });

  it("keeps explain facts in the execution order that proves each boundary", async () => {
    const result = await runPortfolioDemo({ explain: true });

    expect(result.explanations[1]).toBe(
      "explain.verification-recovery verification=failed recovery=attempted verification=passed final=accepted",
    );
    expect(result.explanations[2]).toBe(
      "explain.coordination-completion task=approved gate=incomplete worktree=written fingerprint=captured verification=passed integration=recorded gate=ready",
    );
  });

  it("prints the normal receipts followed by the explain annotations", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await main(["--explain"], {
      error(message) {
        errors.push(message);
      },
      log(message) {
        output.push(message);
      },
      runDemo: runPortfolioDemo,
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toEqual([
      "scene.action-boundary PASS deny-before-dispatch",
      "scene.verification-recovery PASS recovery-before-final",
      "scene.coordination-completion PASS receipt-before-ready",
      "explain.action-boundary policy=denied dispatches=0",
      "explain.verification-recovery verification=failed recovery=attempted verification=passed final=accepted",
      "explain.coordination-completion task=approved gate=incomplete worktree=written fingerprint=captured verification=passed integration=recorded gate=ready",
    ]);
  });

  it("prints help and rejects invalid or duplicate flags before a walkthrough starts", async () => {
    let starts = 0;
    const output: string[] = [];
    const errors: string[] = [];
    const dependencies = {
      error(message: string) {
        errors.push(message);
      },
      log(message: string) {
        output.push(message);
      },
      async runDemo() {
        starts += 1;
        return runPortfolioDemo();
      },
    };

    await expect(main(["--help"], dependencies)).resolves.toBe(0);
    expect(starts).toBe(0);
    expect(output.join("\n")).toContain("Usage: npm run demo:portfolio -- [--explain]");

    await expect(main(["--explain", "--explain"], dependencies)).resolves.toBe(2);
    await expect(main(["--wat"], dependencies)).resolves.toBe(2);
    expect(starts).toBe(0);
    expect(errors.join("\n")).toMatch(/duplicate|unknown/i);
  });
});
