import fs from "node:fs/promises";
import path from "node:path";

import {
  assertIntentPathInsideCollector,
  readEvidenceIntent,
} from "./evidenceIntent.js";
import { parseEvidenceCaptureResult } from "./evidenceRunSchema.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type AssertEvidenceRunMayStartOptions,
  type EvidenceCaptureResult,
  type EvidenceIntent,
  type EvidenceRunKind,
  type EvidenceRunRole,
} from "./evidenceTypes.js";
import {
  assertPhysicalFile,
  hasExactKeys,
  isIsoDate,
  isNodeError,
  isRecord,
  pathExists,
  requireSafeIdentifier,
  writeJsonExclusive,
} from "./evidenceSafety.js";

export interface EvidenceRunReservation {
  artifactType: "forge-evidence-run-reservation";
  intentId: string;
  kind: EvidenceRunKind;
  retryOf?: string;
  role: EvidenceRunRole;
  runId: string;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  startedAt: string;
}

export interface ReserveEvidenceRunOptions extends AssertEvidenceRunMayStartOptions {
  runId: string;
  startedAt: string;
}

interface RunSelection {
  captures: EvidenceCaptureResult[];
  externalRetryTarget?: ExternalRetryTarget;
  intent: EvidenceIntent;
  reservations: EvidenceRunReservation[];
  retryTargetOrphaned: boolean;
}

interface ExternalRetryTarget {
  capture: EvidenceCaptureResult;
  intent: EvidenceIntent;
  intentPath: string;
  reservation: EvidenceRunReservation;
}

export async function assertEvidenceRunMayStart(
  options: AssertEvidenceRunMayStartOptions,
): Promise<{ intent: EvidenceIntent; retryOf?: string }> {
  const selection = await inspectRunSelection(options);
  return {
    intent: selection.intent,
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
  };
}

export async function reserveEvidenceRun(
  options: ReserveEvidenceRunOptions,
): Promise<{ intent: EvidenceIntent; reservation: EvidenceRunReservation; retryOf?: string }> {
  const runId = requireSafeIdentifier(options.runId, "run id");
  if (!isIsoDate(options.startedAt)) {
    throw new Error("evidence run reservation requires an ISO start date");
  }
  const selection = await inspectRunSelection(options, runId);
  const reservation: EvidenceRunReservation = {
    artifactType: "forge-evidence-run-reservation",
    intentId: selection.intent.intentId,
    kind: options.kind,
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
    role: options.role,
    runId,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    startedAt: options.startedAt,
  };
  const intentRoot = path.dirname(path.resolve(options.intentPath));
  const slot = options.retryOf ? "retry" : "original";
  const reservationPath = path.join(
    intentRoot,
    "reservations",
    options.kind,
    options.role,
    `${slot}.json`,
  );
  if (selection.externalRetryTarget) {
    await reserveExternalRetryClaim(
      selection.externalRetryTarget,
      selection.intent,
      reservation,
    );
  }
  await writeJsonExclusive(
    reservationPath,
    reservation,
    "evidence role already has a preregistered attempt",
  );
  if (options.retryOf && selection.retryTargetOrphaned) {
    const original = selection.reservations.find((entry) => entry.runId === options.retryOf);
    if (!original) {
      throw new Error("orphaned retry target disappeared during evidence reservation");
    }
    await materializeInterruptedCapture(intentRoot, selection.intent, original);
  }
  return {
    intent: selection.intent,
    reservation,
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
  };
}

export async function readEvidenceCaptureResults(intentPath: string): Promise<EvidenceCaptureResult[]> {
  const runsRoot = path.join(path.dirname(path.resolve(intentPath)), "runs");
  let entries;
  try {
    entries = await fs.readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const captures: EvidenceCaptureResult[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("temporary evidence run entries must be physical directories");
      }
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("evidence runs root can contain only physical run directories");
    }
    const capture = parseEvidenceCaptureResult(JSON.parse(await fs.readFile(
      path.join(runsRoot, entry.name, "capture-result.json"),
      "utf8",
    )) as unknown);
    if (capture.runId !== entry.name) {
      throw new Error(`evidence capture ${entry.name} does not match its directory`);
    }
    captures.push(capture);
  }
  return captures;
}

export async function assertEvidenceLedgerClosed(
  intentPath: string,
  captures: EvidenceCaptureResult[],
): Promise<void> {
  const reservations = await readEvidenceRunReservations(path.resolve(intentPath));
  if (reservations.length !== captures.length) {
    throw new Error("every preregistered evidence attempt must have a capture result before promotion");
  }
  const captureById = new Map(captures.map((capture) => [capture.runId, capture]));
  for (const reservation of reservations) {
    const capture = captureById.get(reservation.runId);
    if (!capture
      || capture.intentId !== reservation.intentId
      || capture.kind !== reservation.kind
      || capture.role !== reservation.role
      || capture.retryOf !== reservation.retryOf) {
      throw new Error(`evidence reservation ${reservation.runId} does not match its capture result`);
    }
  }
}

export async function readExternalRetryTargets(
  intentPath: string,
  captures: EvidenceCaptureResult[],
): Promise<Array<{ capture: EvidenceCaptureResult; intent: EvidenceIntent }>> {
  const resolvedIntentPath = path.resolve(intentPath);
  const intent = await readEvidenceIntent(resolvedIntentPath);
  const localRunIds = new Set(captures.map((capture) => capture.runId));
  const targets: Array<{ capture: EvidenceCaptureResult; intent: EvidenceIntent }> = [];
  for (const capture of captures) {
    if (!capture.retryOf || localRunIds.has(capture.retryOf)) {
      continue;
    }
    const target = await findExternalRetryTarget(resolvedIntentPath, intent, {
      kind: capture.kind,
      retryOf: capture.retryOf,
      retryRunId: capture.runId,
      role: capture.role,
    });
    targets.push({ capture: target.capture, intent: target.intent });
  }
  return targets.sort((left, right) => left.capture.runId.localeCompare(right.capture.runId));
}

async function inspectRunSelection(
  options: AssertEvidenceRunMayStartOptions,
  retryRunId?: string,
): Promise<RunSelection> {
  const intentPath = path.resolve(options.intentPath);
  const intent = await readEvidenceIntent(intentPath);
  await assertIntentPathInsideCollector(intentPath, intent);
  assertRunRole(intent, options.kind, options.role);
  const [captures, reservations] = await Promise.all([
    readEvidenceCaptureResults(intentPath),
    readEvidenceRunReservations(intentPath),
  ]);
  if (captures.some((capture) => capture.intentId !== intent.intentId)
    || reservations.some((reservation) => reservation.intentId !== intent.intentId)) {
    throw new Error("evidence run ledger contains an attempt from another intent");
  }

  const capturesById = new Map(captures.map((capture) => [capture.runId, capture]));
  const reservationsById = new Map(reservations.map((reservation) => [reservation.runId, reservation]));
  const sameRoleReservations = reservations.filter((reservation) => (
    reservation.kind === options.kind && reservation.role === options.role
  ));
  const sameRoleCaptures = captures.filter((capture) => (
    capture.kind === options.kind && capture.role === options.role
  ));
  const sameRoleIds = new Set([
    ...sameRoleReservations.map((reservation) => reservation.runId),
    ...sameRoleCaptures.map((capture) => capture.runId),
  ]);

  for (const runId of sameRoleIds) {
    const reservation = reservationsById.get(runId);
    const capture = capturesById.get(runId);
    if (reservation && capture
      && (reservation.kind !== capture.kind
        || reservation.role !== capture.role
        || reservation.retryOf !== capture.retryOf)) {
      throw new Error(`evidence reservation ${runId} conflicts with its capture result`);
    }
  }

  let externalTarget: ExternalRetryTarget | undefined;
  let retryTargetOrphaned = false;
  if (options.retryOf) {
    let previousReservation = reservationsById.get(options.retryOf);
    let previousCapture = capturesById.get(options.retryOf);
    if (!previousReservation && !previousCapture) {
      externalTarget = await findExternalRetryTarget(intentPath, intent, {
        kind: options.kind,
        retryOf: options.retryOf,
        ...(retryRunId ? { retryRunId } : {}),
        role: options.role,
      });
      previousReservation = externalTarget.reservation;
      previousCapture = externalTarget.capture;
    }
    if (!previousReservation
      || previousReservation.kind !== options.kind
      || previousReservation.role !== options.role) {
      throw new Error(`evidence retry target ${options.retryOf} is not a preregistered ${options.role} run`);
    }
    if (previousReservation.retryOf) {
      throw new Error("an evidence retry cannot itself be retried");
    }
    if (previousCapture
      && (!previousCapture.infrastructureInvalid || previousCapture.promotionEligible)) {
      throw new Error("evidence retries require an infrastructure-invalid, non-promotable prior run");
    }
    if (sameRoleReservations.some((reservation) => reservation.retryOf !== undefined)
      || sameRoleIds.size > 1) {
      throw new Error(`evidence role ${options.role} already used its one allowed retry`);
    }
    retryTargetOrphaned = !externalTarget && previousCapture === undefined;
  } else if (sameRoleIds.size > 0) {
    throw new Error(`evidence intent already has a recorded run reservation for role ${options.role}`);
  }

  if (options.role === "candidate") {
    const baselines = captures.filter((capture) => (
      capture.kind === "eval"
      && capture.role === "baseline"
      && capture.captureStatus === "sealed"
      && capture.promotionEligible
      && capture.baselineEligible
    ));
    if (baselines.length !== 1) {
      throw new Error("candidate evidence requires exactly one promotion-eligible baseline");
    }
  }
  return {
    captures,
    ...(externalTarget ? { externalRetryTarget: externalTarget } : {}),
    intent,
    reservations,
    retryTargetOrphaned,
  };
}

async function findExternalRetryTarget(
  currentIntentPath: string,
  currentIntent: EvidenceIntent,
  options: Pick<AssertEvidenceRunMayStartOptions, "kind" | "role"> & {
    retryOf: string;
    retryRunId?: string;
  },
): Promise<ExternalRetryTarget> {
  const evidenceRoot = path.join(currentIntent.collector.checkout, ".forge", "evidence");
  const intentPaths = await discoverEvidenceIntentPaths(evidenceRoot);
  const matches: ExternalRetryTarget[] = [];
  let existingRetryCount = 0;

  for (const candidateIntentPath of intentPaths) {
    if (candidateIntentPath === currentIntentPath) {
      continue;
    }
    const candidateIntent = await readEvidenceIntent(candidateIntentPath);
    await assertIntentPathInsideCollector(candidateIntentPath, candidateIntent);
    const candidateReservations = await readEvidenceRunReservations(candidateIntentPath);
    existingRetryCount += candidateReservations.filter(
      (reservation) => reservation.retryOf === options.retryOf,
    ).length;
    const reservation = candidateReservations.find(
      (entry) => entry.runId === options.retryOf,
    );
    if (!reservation) {
      continue;
    }
    const capturePath = path.join(
      path.dirname(candidateIntentPath),
      "runs",
      options.retryOf,
      "capture-result.json",
    );
    if (!await pathExists(capturePath)) {
      throw new Error(`external evidence retry target ${options.retryOf} has no capture result`);
    }
    await assertPhysicalFile(capturePath, "external evidence retry capture");
    const capture = parseEvidenceCaptureResult(JSON.parse(
      await fs.readFile(capturePath, "utf8"),
    ) as unknown);
    if (capture.runId !== options.retryOf
      || capture.intentId !== candidateIntent.intentId
      || capture.kind !== reservation.kind
      || capture.role !== reservation.role
      || capture.retryOf !== reservation.retryOf) {
      throw new Error(`external evidence retry target ${options.retryOf} is inconsistent`);
    }
    if (reservation.kind !== options.kind
      || reservation.role !== options.role
      || reservation.retryOf
      || capture.captureStatus !== "failed"
      || !capture.reasonCode
      || !capture.infrastructureInvalid
      || capture.promotionEligible) {
      throw new Error("external evidence retries require an infrastructure-invalid failed capture");
    }
    assertCompatibleRetryIntent(currentIntent, candidateIntent);
    matches.push({
      capture,
      intent: candidateIntent,
      intentPath: candidateIntentPath,
      reservation,
    });
  }

  if (existingRetryCount > 0) {
    throw new Error(`evidence retry target ${options.retryOf} already used its one allowed retry`);
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `evidence retry target ${options.retryOf} is not a preregistered ${options.role} run`
        : `evidence retry target ${options.retryOf} is ambiguous across evidence intents`,
    );
  }
  const target = matches[0] as ExternalRetryTarget;
  const claim = await readExternalRetryClaim(target.intentPath, options.retryOf);
  if (claim && (!options.retryRunId
    || claim.originalIntentId !== target.intent.intentId
    || claim.originalRunId !== options.retryOf
    || claim.retryIntentId !== currentIntent.intentId
    || claim.retryRunId !== options.retryRunId
    || claim.kind !== options.kind
    || claim.role !== options.role)) {
    throw new Error(`evidence retry target ${options.retryOf} already used its one allowed retry`);
  }
  return target;
}

async function discoverEvidenceIntentPaths(evidenceRoot: string): Promise<string[]> {
  const intentPaths: string[] = [];
  async function visit(directory: string): Promise<void> {
    const intentPath = path.join(directory, "intent.json");
    if (await pathExists(intentPath)) {
      await assertPhysicalFile(intentPath, "discovered evidence intent");
      intentPaths.push(intentPath);
      return;
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error("evidence intent discovery cannot traverse symlinks");
      }
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name));
      }
    }
  }
  await visit(evidenceRoot);
  return intentPaths.sort((left, right) => left.localeCompare(right));
}

interface ExternalRetryClaim {
  artifactType: "forge-evidence-external-retry-claim";
  claimedAt: string;
  kind: EvidenceRunKind;
  originalIntentId: string;
  originalRunId: string;
  retryIntentId: string;
  retryRunId: string;
  role: EvidenceRunRole;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
}

async function reserveExternalRetryClaim(
  target: ExternalRetryTarget,
  retryIntent: EvidenceIntent,
  retryReservation: EvidenceRunReservation,
): Promise<void> {
  const claim: ExternalRetryClaim = {
    artifactType: "forge-evidence-external-retry-claim",
    claimedAt: retryReservation.startedAt,
    kind: retryReservation.kind,
    originalIntentId: target.intent.intentId,
    originalRunId: target.capture.runId,
    retryIntentId: retryIntent.intentId,
    retryRunId: retryReservation.runId,
    role: retryReservation.role,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
  };
  await writeJsonExclusive(
    externalRetryClaimPath(target.intentPath, target.capture.runId),
    claim,
    `evidence retry target ${target.capture.runId} already used its one allowed retry`,
  );
}

async function readExternalRetryClaim(
  originalIntentPath: string,
  originalRunId: string,
): Promise<ExternalRetryClaim | undefined> {
  const claimPath = externalRetryClaimPath(originalIntentPath, originalRunId);
  if (!await pathExists(claimPath)) {
    return undefined;
  }
  await assertPhysicalFile(claimPath, "external evidence retry claim");
  const value = JSON.parse(await fs.readFile(claimPath, "utf8")) as unknown;
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "artifactType",
      "claimedAt",
      "kind",
      "originalIntentId",
      "originalRunId",
      "retryIntentId",
      "retryRunId",
      "role",
      "schemaVersion",
    ])
    || value.artifactType !== "forge-evidence-external-retry-claim"
    || value.schemaVersion !== EVIDENCE_SCHEMA_VERSION
    || (value.kind !== "eval" && value.kind !== "live")
    || !["baseline", "candidate", "live", "observation"].includes(value.role as string)
    || typeof value.originalIntentId !== "string"
    || typeof value.originalRunId !== "string"
    || typeof value.retryIntentId !== "string"
    || typeof value.retryRunId !== "string"
    || !isIsoDate(value.claimedAt)) {
    throw new Error("invalid external evidence retry claim");
  }
  requireSafeIdentifier(value.originalIntentId, "original retry intent id");
  requireSafeIdentifier(value.originalRunId, "original retry run id");
  requireSafeIdentifier(value.retryIntentId, "retry intent id");
  requireSafeIdentifier(value.retryRunId, "retry run id");
  if ((value.kind === "live") !== (value.role === "live")) {
    throw new Error("invalid external evidence retry claim role");
  }
  return value as unknown as ExternalRetryClaim;
}

function externalRetryClaimPath(originalIntentPath: string, originalRunId: string): string {
  return path.join(
    path.dirname(originalIntentPath),
    "retry-claims",
    `${requireSafeIdentifier(originalRunId, "original retry run id")}.json`,
  );
}

function assertCompatibleRetryIntent(current: EvidenceIntent, previous: EvidenceIntent): void {
  if (current.mode !== previous.mode
    || current.subject.ref !== previous.subject.ref
    || current.subject.commit !== previous.subject.commit
    || current.subject.tree !== previous.subject.tree
    || current.environment.endpointHash !== previous.environment.endpointHash
    || current.environment.model !== previous.environment.model
    || current.environment.providerId !== previous.environment.providerId
    || current.selectionPolicy.evalAttemptsPerBatch !== previous.selectionPolicy.evalAttemptsPerBatch
    || current.selectionPolicy.evalBatchLimit !== previous.selectionPolicy.evalBatchLimit
    || current.selectionPolicy.keepEveryRun !== previous.selectionPolicy.keepEveryRun
    || current.selectionPolicy.retry !== previous.selectionPolicy.retry
    || current.selectionPolicy.selection !== previous.selectionPolicy.selection) {
    throw new Error("external evidence retry target belongs to an incompatible intent");
  }
}

async function readEvidenceRunReservations(intentPath: string): Promise<EvidenceRunReservation[]> {
  const intentRoot = path.dirname(intentPath);
  await assertReservationTreeShape(path.join(intentRoot, "reservations"));
  const locations: Array<{ kind: EvidenceRunKind; role: EvidenceRunRole }> = [
    { kind: "live", role: "live" },
    { kind: "eval", role: "observation" },
    { kind: "eval", role: "baseline" },
    { kind: "eval", role: "candidate" },
  ];
  const reservations: EvidenceRunReservation[] = [];
  for (const location of locations) {
    for (const slot of ["original", "retry"] as const) {
      const reservationPath = path.join(
        intentRoot,
        "reservations",
        location.kind,
        location.role,
        `${slot}.json`,
      );
      if (!await pathExists(reservationPath)) {
        continue;
      }
      await assertPhysicalFile(reservationPath, "evidence run reservation");
      const reservation = parseEvidenceRunReservation(JSON.parse(
        await fs.readFile(reservationPath, "utf8"),
      ) as unknown);
      if (reservation.kind !== location.kind
        || reservation.role !== location.role
        || (slot === "original") !== (reservation.retryOf === undefined)) {
        throw new Error("evidence run reservation does not match its ledger slot");
      }
      reservations.push(reservation);
    }
  }
  const runIds = reservations.map((reservation) => reservation.runId);
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("evidence run ledger contains duplicate run ids");
  }
  return reservations;
}

async function assertReservationTreeShape(reservationsRoot: string): Promise<void> {
  if (!await pathExists(reservationsRoot)) {
    return;
  }
  const allowedRoles = new Map<string, Set<string>>([
    ["eval", new Set(["baseline", "candidate", "observation"])],
    ["live", new Set(["live"])],
  ]);
  for (const kindEntry of await fs.readdir(reservationsRoot, { withFileTypes: true })) {
    const roles = allowedRoles.get(kindEntry.name);
    if (!roles || !kindEntry.isDirectory() || kindEntry.isSymbolicLink()) {
      throw new Error("evidence reservation root contains an unexpected entry");
    }
    const kindRoot = path.join(reservationsRoot, kindEntry.name);
    for (const roleEntry of await fs.readdir(kindRoot, { withFileTypes: true })) {
      if (!roles.has(roleEntry.name) || !roleEntry.isDirectory() || roleEntry.isSymbolicLink()) {
        throw new Error("evidence reservation kind contains an unexpected entry");
      }
      const roleRoot = path.join(kindRoot, roleEntry.name);
      for (const slotEntry of await fs.readdir(roleRoot, { withFileTypes: true })) {
        const pending = /^(?:original|retry)\.json\.\d+\.[a-f0-9]+\.tmp$/.test(slotEntry.name);
        if ((!pending && slotEntry.name !== "original.json" && slotEntry.name !== "retry.json")
          || !slotEntry.isFile()
          || slotEntry.isSymbolicLink()) {
          throw new Error("evidence reservation role contains an unexpected entry");
        }
      }
    }
  }
}

function parseEvidenceRunReservation(value: unknown): EvidenceRunReservation {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "artifactType",
      "intentId",
      "kind",
      ...(value.retryOf === undefined ? [] : ["retryOf"]),
      "role",
      "runId",
      "schemaVersion",
      "startedAt",
    ])
    || value.artifactType !== "forge-evidence-run-reservation"
    || value.schemaVersion !== EVIDENCE_SCHEMA_VERSION
    || typeof value.intentId !== "string"
    || typeof value.runId !== "string"
    || (value.kind !== "eval" && value.kind !== "live")
    || !["baseline", "candidate", "live", "observation"].includes(value.role as string)
    || !isIsoDate(value.startedAt)
    || (value.retryOf !== undefined && typeof value.retryOf !== "string")) {
    throw new Error("invalid evidence run reservation");
  }
  requireSafeIdentifier(value.intentId, "reservation intent id");
  requireSafeIdentifier(value.runId, "reservation run id");
  if (value.retryOf !== undefined) {
    requireSafeIdentifier(value.retryOf as string, "reservation retry target");
  }
  if ((value.kind === "live") !== (value.role === "live")) {
    throw new Error("invalid evidence run reservation role");
  }
  return value as unknown as EvidenceRunReservation;
}

function assertRunRole(intent: EvidenceIntent, kind: EvidenceRunKind, role: EvidenceRunRole): void {
  if ((kind === "live") !== (role === "live")) {
    throw new Error("evidence run kind and role do not match");
  }
  if (kind === "eval") {
    if (intent.mode === "observation" && role !== "observation") {
      throw new Error("an observation intent accepts only observational Eval runs");
    }
    if (intent.mode === "regression" && role === "observation") {
      throw new Error("a regression intent accepts only baseline and candidate Eval runs");
    }
  }
}

async function materializeInterruptedCapture(
  intentRoot: string,
  intent: EvidenceIntent,
  reservation: EvidenceRunReservation,
): Promise<void> {
  const runsRoot = path.join(intentRoot, "runs");
  await fs.mkdir(runsRoot, { recursive: true });
  const runRoot = path.join(runsRoot, reservation.runId);
  if (await pathExists(runRoot)) {
    return;
  }
  const temporaryRoot = await fs.mkdtemp(path.join(runsRoot, `.${reservation.runId}.interrupted.`));
  const result: EvidenceCaptureResult = {
    artifactType: "forge-evidence-capture-result",
    baselineEligible: false,
    behavioralVerdict: "UNKNOWN:capture_interrupted",
    captureStatus: "failed",
    infrastructureInvalid: true,
    intentId: intent.intentId,
    kind: reservation.kind,
    promotionEligible: false,
    reasonCode: "capture_interrupted",
    ...(reservation.retryOf ? { retryOf: reservation.retryOf } : {}),
    role: reservation.role,
    runId: reservation.runId,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
  };
  await fs.writeFile(
    path.join(temporaryRoot, "capture-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryRoot, runRoot);
}
