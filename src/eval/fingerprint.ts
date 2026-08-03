import { createHash } from "node:crypto";

export interface ExperimentScenarioInput {
  id: string;
  manifest: unknown;
}

export interface BuildExperimentIdentityOptions {
  diagnostics?: Record<string, unknown>;
  endpoint: string;
  model: string;
  providerId: string;
  requestSettings: unknown;
  scenarios: ExperimentScenarioInput[];
}

export interface ExperimentIdentity {
  endpointHash: string;
  fingerprint: string;
  model: string;
  providerId: string;
  requestFingerprint: string;
  suiteFingerprint: string;
}

type CanonicalValue = boolean | null | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function buildExperimentIdentity(options: BuildExperimentIdentityOptions): ExperimentIdentity {
  const endpointHash = fingerprint(normalizeEndpoint(options.endpoint));
  const requestFingerprint = fingerprint(options.requestSettings);
  const suiteFingerprint = fingerprint(options.scenarios
    .map((scenario) => ({
      id: scenario.id,
      manifest: scenario.manifest,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
  const comparable = {
    endpointHash,
    model: options.model,
    providerId: options.providerId,
    requestFingerprint,
    suiteFingerprint,
  };

  return {
    ...comparable,
    fingerprint: fingerprint(comparable),
  };
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function toCanonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, toCanonicalValue(record[key])]));
  }

  throw new Error(`canonical JSON does not support ${typeof value}`);
}
