import { describe, expect, it } from "vitest";

import {
  buildExperimentIdentity,
  canonicalJson,
} from "../../src/eval/fingerprint.js";

describe("eval experiment fingerprints", () => {
  it("canonicalizes nested object keys without reordering arrays", () => {
    expect(canonicalJson({
      z: 1,
      a: {
        y: 2,
        x: [3, { b: true, a: null }],
      },
    })).toBe('{"a":{"x":[3,{"a":null,"b":true}],"y":2},"z":1}');
  });

  it("uses locale-independent ordering for distinct Unicode keys", () => {
    expect(canonicalJson({
      z: 1,
      ä: 2,
      ["a\u0308"]: 3,
    })).toBe('{"ä":3,"z":1,"ä":2}');

    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("locale-sensitive sorting was used");
    };
    try {
      const result = buildExperimentIdentity({
        contractSources: {
          z: "z",
          ä: "precomposed",
          ["a\u0308"]: "decomposed",
        },
        endpoint: "https://api.openai.com/v1",
        model: "gpt-test",
        providerId: "openai",
        requestSettings: { reasoning: { effort: "low" } },
        scenarios: [
          { id: "z", manifest: { graderVersion: 1 } },
          { id: "ä", manifest: { graderVersion: 1 } },
          { id: "a\u0308", manifest: { graderVersion: 1 } },
        ],
      });
      expect(result.suiteFingerprint).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it("keeps canonically equivalent source keys distinct", () => {
    const createIdentity = (contractSources: Record<string, string>) => buildExperimentIdentity({
      contractSources,
      endpoint: "https://api.openai.com/v1",
      model: "gpt-test",
      providerId: "openai",
      requestSettings: { reasoning: { effort: "low" } },
      scenarios: [{ id: "governed-read-only", manifest: { graderVersion: 1 } }],
    });

    const first = createIdentity({ ä: "precomposed", ["a\u0308"]: "decomposed" });
    const second = createIdentity({ ä: "decomposed", ["a\u0308"]: "precomposed" });

    expect(second.suiteFingerprint).not.toBe(first.suiteFingerprint);
  });

  it("keeps identity stable across registration order and diagnostics changes", () => {
    const governed = {
      id: "governed-read-only",
      manifest: {
        actionPolicy: ["read:facts.txt"],
        fixture: { "facts.txt": "RELEASE_CHANNEL=stable" },
        graderVersion: 1,
        repetitions: 3,
        task: "Read the release channel.",
      },
    };
    const recovery = {
      id: "verification-recovery",
      manifest: {
        graderVersion: 1,
        repetitions: 3,
        task: "Return RECOVERY_OK after verification.",
      },
    };
    const first = buildExperimentIdentity({
      contractSources: {
        "eval/scenarios": "grader-v1",
        "fixture/issue-workflow/index.mjs": "export const issue = 'FH-16';\n",
      },
      diagnostics: { commit: "aaa", toolDefinitionsFingerprint: "tools-a" },
      endpoint: "https://api.openai.com/v1/",
      model: "gpt-test",
      providerId: "openai",
      requestSettings: {
        reasoning: { effort: "low" },
        store: false,
        text: { verbosity: "low" },
      },
      scenarios: [governed, recovery],
    });
    const second = buildExperimentIdentity({
      contractSources: {
        "fixture/issue-workflow/index.mjs": "export const issue = 'FH-16';\n",
        "eval/scenarios": "grader-v1",
      },
      diagnostics: { commit: "bbb", toolDefinitionsFingerprint: "tools-b" },
      endpoint: "https://api.openai.com/v1",
      model: "gpt-test",
      providerId: "openai",
      requestSettings: {
        store: false,
        text: { verbosity: "low" },
        reasoning: { effort: "low" },
      },
      scenarios: [recovery, governed],
    });

    expect(second).toEqual(first);
    expect(first.endpointHash).not.toContain("api.openai.com");
  });

  it("changes identity when a controlled scenario input changes", () => {
    const createIdentity = (task: string) => buildExperimentIdentity({
      contractSources: { "eval/scenarios": "grader-v1" },
      endpoint: "https://api.openai.com/v1",
      model: "gpt-test",
      providerId: "openai",
      requestSettings: { reasoning: { effort: "low" } },
      scenarios: [{
        id: "governed-read-only",
        manifest: {
          actionPolicy: ["read:facts.txt"],
          fixture: { "facts.txt": "RELEASE_CHANNEL=stable" },
          graderVersion: 1,
          repetitions: 3,
          task,
        },
      }],
    });

    const baseline = createIdentity("Read the release channel.");
    const changed = createIdentity("Read and explain the release channel.");

    expect(changed.suiteFingerprint).not.toBe(baseline.suiteFingerprint);
    expect(changed.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("changes identity when executable eval contract bytes change", () => {
    const createIdentity = (grader: string) => buildExperimentIdentity({
      contractSources: {
        "eval/scenarios": grader,
        "fixture/issue-workflow/index.mjs": "export const issue = 'FH-16';\n",
      },
      endpoint: "https://api.openai.com/v1",
      model: "gpt-test",
      providerId: "openai",
      requestSettings: { reasoning: { effort: "low" } },
      scenarios: [{ id: "governed-read-only", manifest: { graderVersion: 1 } }],
    });

    expect(createIdentity("grader-v2").suiteFingerprint)
      .not.toBe(createIdentity("grader-v1").suiteFingerprint);
  });
});
