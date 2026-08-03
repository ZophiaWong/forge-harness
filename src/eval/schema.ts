import path from "node:path";

import { z } from "zod";

import type { EvalBaseline, EvalSuiteSummary } from "./types.js";

const metricAvailabilitySchema = z.enum(["complete", "partial", "unavailable"]);
const modelUsageSchema = z.object({
  cachedInputTokens: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
}).strict();
const modelMetricsSchema = z.object({
  callCount: z.number().int().nonnegative(),
  duration: z.object({
    knownCalls: z.number().int().nonnegative(),
    status: metricAvailabilitySchema,
    totalMs: z.number().nonnegative(),
  }).strict(),
  tokens: z.object({
    knownCalls: z.number().int().nonnegative(),
    status: metricAvailabilitySchema,
    totals: modelUsageSchema.optional(),
  }).strict(),
}).strict();
const evidenceRefSchema = z.string().min(1).refine(isSafeRelativeEvidenceRef, {
  message: "expected a safe relative evidence reference",
});
const assertionSchema = z.object({
  evidenceRefs: z.array(evidenceRefSchema),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(["hard", "outcome"]),
  status: z.enum(["failed", "passed", "unavailable"]),
}).strict();
const attemptSchema = z.object({
  assertions: z.array(assertionSchema),
  attemptId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  evidenceRefs: z.array(evidenceRefSchema),
  execution: z.object({
    reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_]*$/).optional(),
    status: z.enum(["completed", "invalid"]),
  }).strict(),
  metrics: modelMetricsSchema,
  ordinal: z.number().int().positive(),
  outcome: z.enum(["failed", "passed", "unavailable"]),
  scenarioId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
}).strict();
const aggregateSchema = z.object({
  assertionPassCounts: z.record(z.number().int().nonnegative()),
  attemptCount: z.number().int().nonnegative(),
  passCount: z.number().int().nonnegative(),
  scenarioId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
}).strict();
const identitySchema = z.object({
  endpointHash: z.string().min(1),
  fingerprint: z.string().min(1),
  model: z.string().min(1),
  providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  requestFingerprint: z.string().min(1),
  suiteFingerprint: z.string().min(1),
}).strict();
const diagnosticsSchema = z.object({
  commit: z.string().min(1).optional(),
  dependenciesFingerprint: z.string().min(1).optional(),
  nodeVersion: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  runtimePromptFingerprint: z.string().min(1).optional(),
  toolDefinitionsFingerprint: z.string().min(1).optional(),
}).strict();

export const evalSuiteSummarySchema = z.object({
  aggregates: z.array(aggregateSchema),
  artifactType: z.literal("forge-eval-suite-summary"),
  attempts: z.array(attemptSchema),
  canonical: z.boolean(),
  diagnostics: diagnosticsSchema,
  generatedAt: z.string().datetime(),
  identity: identitySchema,
  issues: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/)),
  metrics: modelMetricsSchema,
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  schemaVersion: z.literal(1),
  scope: z.enum(["scenario", "suite"]),
  valid: z.boolean(),
}).strict();

export const evalBaselineSchema = z.object({
  aggregates: z.array(aggregateSchema),
  artifactType: z.literal("forge-eval-baseline"),
  identity: identitySchema,
  metrics: modelMetricsSchema,
  promotedAt: z.string().datetime(),
  schemaVersion: z.literal(1),
  sourceRunId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
}).strict();

export function parseEvalSuiteSummary(input: unknown): EvalSuiteSummary {
  return evalSuiteSummarySchema.parse(input) as EvalSuiteSummary;
}

export function parseEvalBaseline(input: unknown): EvalBaseline {
  return evalBaselineSchema.parse(input) as EvalBaseline;
}

function isSafeRelativeEvidenceRef(reference: string): boolean {
  if (reference.includes("\\") || path.posix.isAbsolute(reference) || path.win32.isAbsolute(reference)) {
    return false;
  }
  const segments = reference.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
