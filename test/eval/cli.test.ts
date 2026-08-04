import { describe, expect, it, vi } from "vitest";

import {
  parseEvalCliArgs,
  runEvalCli,
} from "../../src/eval/cli.js";
import type { RunEvalSuiteResult } from "../../src/eval/suite.js";

describe("eval CLI", () => {
  it("parses run, promote, and clean commands with strict flags", () => {
    expect(parseEvalCliArgs([
      "run",
      "--model",
      "gpt-test",
      "--provider-id",
      "gateway",
      "--scenario",
      "governed-read-only",
    ])).toEqual({
      command: "run",
      model: "gpt-test",
      providerId: "gateway",
      scenarioId: "governed-read-only",
    });
    expect(parseEvalCliArgs(["promote", "--from", ".forge/evals/run/summary.json", "--replace"]))
      .toEqual({ command: "promote", from: ".forge/evals/run/summary.json", replace: true });
    expect(parseEvalCliArgs(["clean", "--yes"])).toEqual({ command: "clean", yes: true });
    expect(() => parseEvalCliArgs(["run", "--model", "gpt-test", "--wat"])).toThrow(/unknown option/);
  });

  it("returns the regression report exit code and forwards environment-backed provider settings", async () => {
    const runSuite = vi.fn(async (): Promise<RunEvalSuiteResult> => ({
      artifactPaths: {
        markdownPath: "/repo/report.md",
        reportPath: "/repo/report.json",
        summaryPath: "/repo/summary.json",
      },
      report: {
        artifactType: "forge-eval-regression-report",
        candidateRunId: "run-1",
        compatibility: { differences: [], status: "no_baseline" },
        diffs: [],
        exitCode: 2,
        findings: [],
        generatedAt: "2026-08-03T00:00:00.000Z",
        metrics: {
          candidate: {
            callCount: 0,
            duration: { knownCalls: 0, status: "unavailable", totalMs: 0 },
            tokens: { knownCalls: 0, status: "unavailable" },
          },
        },
        schemaVersion: 1,
        verdict: "NO_BASELINE",
      },
      runRoot: "/repo/.forge/evals/run-1",
      summary: {} as RunEvalSuiteResult["summary"],
    }));
    const log = vi.fn();

    const exitCode = await runEvalCli([
      "run",
      "--model",
      "gpt-test",
      "--provider-id",
      "gateway",
    ], {
      cleanRuns: vi.fn(),
      confirm: vi.fn(),
      env: {
        OPENAI_API_KEY: "secret",
        OPENAI_BASE_URL: "https://gateway.example/v1",
      },
      error: vi.fn(),
      log,
      promoteBaseline: vi.fn(),
      repositoryRoot: "/repo",
      runSuite,
    });

    expect(exitCode).toBe(2);
    expect(runSuite).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "secret",
      baseURL: "https://gateway.example/v1",
      model: "gpt-test",
      providerId: "gateway",
      repositoryRoot: "/repo",
    }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("NO_BASELINE"));
  });

  it("asks before clean unless --yes is supplied and maps argument failures to exit 2", async () => {
    const cleanRuns = vi.fn(async () => ({
      removedRunIds: [],
      skippedActiveRunIds: [],
      skippedUnmarkedNames: [],
    }));
    const confirm = vi.fn(async () => false);
    const deps = {
      cleanRuns,
      confirm,
      env: {},
      error: vi.fn(),
      log: vi.fn(),
      promoteBaseline: vi.fn(),
      repositoryRoot: "/repo",
      runSuite: vi.fn(),
    };

    await expect(runEvalCli(["clean"], deps)).resolves.toBe(2);
    expect(cleanRuns).not.toHaveBeenCalled();
    await expect(runEvalCli(["clean", "--yes"], deps)).resolves.toBe(0);
    expect(cleanRuns).toHaveBeenCalledWith({
      confirmed: true,
      evalRoot: "/repo/.forge/evals",
      repositoryRoot: "/repo",
    });
    await expect(runEvalCli(["run"], deps)).resolves.toBe(2);
  });
});
