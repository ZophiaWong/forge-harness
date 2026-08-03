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
});
