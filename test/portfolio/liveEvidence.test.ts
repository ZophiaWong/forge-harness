import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runLiveEvidence, type SubjectLiveModule } from "../../src/portfolio/liveEvidence.js";
import {
  prepareEvidenceIntent,
  writeEvidenceIntent,
} from "../../src/runtime/evidenceBundle.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("Live release evidence", () => {
  it("archives subject evidence before the disposable fixture is removed", async () => {
    const { intentPath, repository } = await createIntent();
    let fixture = "";
    const subjectModule = fakeSubjectModule((allocated) => {
      fixture = allocated;
    });
    const loadSubjectModule = vi.fn(async () => subjectModule);
    const captureInitialTests = vi.fn(
      async () => commandEvidence("npm test", 1, "non-authoritative replay\n"),
    );

    const result = await runLiveEvidence({ intentPath }, {
      buildSubject: async () => commandEvidence("npm run --silent build", 0, "built\n"),
      captureFinalTests: async () => commandEvidence("npm test", 0, "4 tests passed\n"),
      captureInitialTests,
      environment: {
        EVIDENCE_PROVIDER_ID: "my-gateway",
        OPENAI_API_KEY: "test-only-key",
        OPENAI_BASE_URL: "https://gateway.example/v1",
        OPENAI_MODEL: "gpt-5.4-mini",
      },
      loadSubjectModule,
      now: sequenceDates(
        "2026-08-28T02:00:00.000Z",
        "2026-08-28T02:10:00.000Z",
        "2026-08-28T02:11:00.000Z",
      ),
      randomSuffix: () => "live0001",
    });

    expect(result).toMatchObject({
      capture: {
        behavioralVerdict: "PASS:verified_session_evidence",
        captureStatus: "sealed",
        promotionEligible: true,
      },
      exitCode: 0,
    });
    expect(loadSubjectModule).toHaveBeenCalledWith(path.join(repository, "dist", "portfolio", "live.js"));
    expect(captureInitialTests).not.toHaveBeenCalled();
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
    const runRoot = path.join(path.dirname(intentPath), "runs", result.capture.runId);
    const inventory = JSON.parse(await fs.readFile(
      path.join(runRoot, "private", "inventory.json"),
      "utf8",
    )) as { files: Array<{ path: string }> };
    expect(inventory.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "live/fixture/package.json",
      "live/git/repository.bundle",
      "live/git/status.txt",
      "live/operator/final-test.json",
      "live/operator/initial-test.json",
      "live/operator/live-result.json",
      "live/reservation.json",
      "live/sessions/root/session.json",
      "live/sessions/root/task-graph.json",
      "live/sessions/root/trace.jsonl",
    ]));
    expect(result.capture.artifacts?.reports).toEqual(["public/report.json"]);
    expect(JSON.parse(await fs.readFile(path.join(runRoot, "public", "report.json"), "utf8")))
      .toEqual({
        cleaned: true,
        finalTests: { exitCode: 0, signal: null },
        reason: "verified_session_evidence",
        status: "PASS",
        subjectBuild: { exitCode: 0, signal: null },
      });
    expect(JSON.parse(await fs.readFile(
      path.join(result.stagingRoot, "operator", "initial-test.json"),
      "utf8",
    ))).toMatchObject({
      evidenceSource: "subject-validator",
      subjectValidator: {
        completion: {
          command: "npm test",
          exitCode: 1,
          output: "raw subject validator TAP\n",
          signal: null,
        },
        result: "expected_failure",
      },
    });
    await expect(fs.access(result.stagingRoot)).resolves.toBeUndefined();
  });

  it.each(["failure", "disagreement"] as const)(
    "keeps the subject verdict when a legacy initial-test replay has a %s",
    async (scenario) => {
      const { intentPath } = await createIntent();
      let fixture = "";
      let replayFixture = "";
      const result = await runLiveEvidence({ intentPath }, {
        buildSubject: async () => commandEvidence("npm run --silent build", 0, "built\n"),
        captureFinalTests: async () => commandEvidence("npm test", 0, "4 tests passed\n"),
        async captureInitialTests(capturedFixture) {
          replayFixture = capturedFixture;
          if (scenario === "failure") {
            throw new Error("injected legacy replay failure");
          }
          return commandEvidence("npm test", 0, "unexpected replay pass\n");
        },
        environment: liveEnvironment(),
        loadSubjectModule: async () => fakeSubjectModule(
          (allocated) => {
            fixture = allocated;
          },
          undefined,
          false,
        ),
        now: sequenceDates(
          "2026-08-28T02:20:00.000Z",
          "2026-08-28T02:30:00.000Z",
          "2026-08-28T02:31:00.000Z",
        ),
        randomSuffix: () => scenario === "failure" ? "replay01" : "replay02",
      });

      expect(replayFixture).not.toBe(fixture);
      await expect(fs.access(replayFixture)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result).toMatchObject({
        capture: {
          behavioralVerdict: "PASS:verified_session_evidence",
          captureStatus: "failed",
          promotionEligible: false,
          reasonCode: "live_capture_failed",
        },
        exitCode: 2,
      });
      await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(result.stagingRoot)).resolves.toBeUndefined();
      expect(JSON.parse(await fs.readFile(
        path.join(result.stagingRoot, "operator", "initial-test.json"),
        "utf8",
      ))).toMatchObject({
        evidenceSource: scenario === "failure" ? "unavailable" : "collector-replay",
        subjectValidator: { result: "expected_failure" },
      });
    },
  );

  it.each([
    ["child_failed", true, 1],
    ["interrupted", false, 2],
    ["cleanup_failed", false, 2],
  ] as const)(
    "seals a %s verdict without turning it into a capture failure",
    async (reason, promotionEligible, exitCode) => {
      const { intentPath } = await createIntent();
      const result = await runLiveEvidence({ intentPath }, {
        buildSubject: async () => commandEvidence("npm run --silent build", 0, "built\n"),
        captureFinalTests: async () => commandEvidence("npm test", 1, "behavior failed\n"),
        captureInitialTests: async () => commandEvidence("npm test", 1, "raw initial TAP\n"),
        environment: liveEnvironment(),
        loadSubjectModule: async () => fakeSubjectModule(
          () => undefined,
          { cleaned: reason !== "cleanup_failed", reason, status: "FAIL" },
        ),
        now: sequenceDates(
          "2026-08-28T03:20:00.000Z",
          "2026-08-28T03:30:00.000Z",
          "2026-08-28T03:31:00.000Z",
        ),
        randomSuffix: () => `live${exitCode}00`,
      });

      expect(result).toMatchObject({
        capture: {
          behavioralVerdict: `FAIL:${reason}`,
          captureStatus: "sealed",
          infrastructureInvalid: !promotionEligible,
          promotionEligible,
        },
        exitCode,
      });
    },
  );

  it("keeps the behavioral verdict and cleans the fixture when pre-cleanup capture fails", async () => {
    const { intentPath } = await createIntent();
    let fixture = "";
    const result = await runLiveEvidence({ intentPath }, {
      buildSubject: async () => commandEvidence("npm run --silent build", 0, "built\n"),
      async captureFinalTests() {
        throw new Error("injected collector failure");
      },
      captureInitialTests: async () => commandEvidence("npm test", 1, "raw initial TAP\n"),
      environment: liveEnvironment(),
      loadSubjectModule: async () => fakeSubjectModule((allocated) => {
        fixture = allocated;
      }),
      now: sequenceDates(
        "2026-08-28T03:00:00.000Z",
        "2026-08-28T03:10:00.000Z",
        "2026-08-28T03:11:00.000Z",
      ),
      randomSuffix: () => "live0002",
    });

    expect(result).toMatchObject({
      capture: {
        behavioralVerdict: "PASS:verified_session_evidence",
        captureStatus: "failed",
        infrastructureInvalid: true,
        promotionEligible: false,
        reasonCode: "live_capture_failed",
      },
      exitCode: 2,
    });
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(result.stagingRoot)).resolves.toBeUndefined();
  });
});

async function createIntent(): Promise<{ intentPath: string; repository: string }> {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "forge-live-evidence-source-"));
  tempRoots.push(repository);
  await git(repository, ["init", "-q"]);
  await git(repository, ["config", "user.name", "Forge Live Evidence"]);
  await git(repository, ["config", "user.email", "live-evidence@example.invalid"]);
  await fs.writeFile(path.join(repository, ".gitignore"), ".forge/\ndist/\n", "utf8");
  await fs.writeFile(path.join(repository, "source.txt"), "subject\n", "utf8");
  await git(repository, ["add", ".gitignore", "source.txt"]);
  await git(repository, ["commit", "-qm", "subject"]);
  await git(repository, ["tag", "v1.0.0"]);
  const intent = await prepareEvidenceIntent({
    collectorRoot: repository,
    endpoint: "https://gateway.example/v1",
    mode: "observation",
    model: "gpt-5.4-mini",
    now: () => new Date("2026-08-28T01:00:00.000Z"),
    providerId: "my-gateway",
    randomSuffix: () => "intent01",
    ref: "v1.0.0",
    subjectRoot: repository,
  });
  return {
    intentPath: await writeEvidenceIntent(intent, undefined, repository),
    repository,
  };
}

function fakeSubjectModule(
  onAllocate: (fixture: string) => void,
  result: Awaited<ReturnType<SubjectLiveModule["runLivePortfolioDemo"]>> = {
    cleaned: true,
    reason: "verified_session_evidence",
    status: "PASS",
  },
  exposeInitialCompletion = true,
): SubjectLiveModule {
  return {
    async allocateLivePortfolioFixture() {
      const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "forge-live-subject-"));
      onAllocate(fixture);
      return fixture;
    },
    async initializeLivePortfolioFixture(fixture) {
      await fs.mkdir(path.join(fixture, ".forge", "sessions", "root"), { recursive: true });
      await fs.mkdir(path.join(fixture, "src"), { recursive: true });
      await fs.mkdir(path.join(fixture, "test"), { recursive: true });
      await fs.writeFile(path.join(fixture, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n", "utf8");
      await fs.writeFile(path.join(fixture, "src", "subject.js"), "export const value = 1;\n", "utf8");
      await fs.writeFile(path.join(fixture, "test", "subject.test.js"), "// subject test\n", "utf8");
      await fs.writeFile(path.join(fixture, ".forge", "sessions", "root", "session.json"), "{\"id\":\"root\"}\n", "utf8");
      await fs.writeFile(path.join(fixture, ".forge", "sessions", "root", "trace.jsonl"), "{\"sequence\":1}\n", "utf8");
      await fs.writeFile(path.join(fixture, ".forge", "sessions", "root", "task-graph.json"), "{\"tasks\":[]}\n", "utf8");
      await git(fixture, ["init", "-q"]);
      await git(fixture, ["config", "user.name", "Forge Subject"]);
      await git(fixture, ["config", "user.email", "subject@example.invalid"]);
      await git(fixture, ["add", "."]);
      await git(fixture, ["commit", "-qm", "fixture"]);
    },
    async runInitialFixtureTests(_fixture, _signal, observeCompletion) {
      if (exposeInitialCompletion) {
        observeCompletion?.({
          command: "npm test",
          exitCode: 1,
          output: "raw subject validator TAP\n",
          signal: null,
        });
      }
      return "expected_failure";
    },
    async runLivePortfolioDemo(dependencies) {
      const fixture = await dependencies.allocateFixture();
      await dependencies.initializeFixture(fixture, new AbortController().signal);
      await dependencies.runFixtureTests(fixture, new AbortController().signal);
      await dependencies.validateEvidence(fixture, new AbortController().signal);
      await dependencies.removeFixture(fixture);
      return result;
    },
    async validateLivePortfolioEvidence() {
      // The real subject validator owns this verdict; the fixture here is the adapter boundary.
    },
  };
}

function liveEnvironment(): NodeJS.ProcessEnv {
  return {
    EVIDENCE_PROVIDER_ID: "my-gateway",
    OPENAI_API_KEY: "test-only-key",
    OPENAI_BASE_URL: "https://gateway.example/v1",
    OPENAI_MODEL: "gpt-5.4-mini",
  };
}

function commandEvidence(command: string, exitCode: number, stdout: string) {
  return { command, exitCode, signal: null, stderr: "", stdout };
}

function sequenceDates(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)] as string);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}
