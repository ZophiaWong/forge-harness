import fs from "node:fs/promises";
import path from "node:path";

import type { ExperimentIdentity } from "./fingerprint.js";
import { evalBaselinePath, safeEvalSlug } from "./baseline.js";
import { parseEvalBaseline } from "./schema.js";
import type { EvalBaseline } from "./types.js";

export async function loadComparisonBaseline(
  repositoryRoot: string,
  identity: ExperimentIdentity,
): Promise<EvalBaseline | undefined> {
  const exactPath = evalBaselinePath(repositoryRoot, identity);
  const exact = await readBaselineIfExists(exactPath);
  if (exact) {
    return exact;
  }

  const directory = path.join(
    path.resolve(repositoryRoot),
    "eval",
    "baselines",
    safeEvalSlug(identity.providerId),
    safeEvalSlug(identity.model),
  );
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const baselines = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readBaselineIfExists(path.join(directory, entry.name))));
  return baselines
    .filter((baseline): baseline is EvalBaseline => baseline !== undefined)
    .sort((left, right) => (
      right.promotedAt.localeCompare(left.promotedAt)
      || right.sourceRunId.localeCompare(left.sourceRunId)
    ))[0];
}

export function scopeBaselineToScenario(
  baseline: EvalBaseline,
  scenarioId: string,
): EvalBaseline {
  return {
    ...baseline,
    aggregates: baseline.aggregates.filter((aggregate) => aggregate.scenarioId === scenarioId),
  };
}

async function readBaselineIfExists(pathname: string): Promise<EvalBaseline | undefined> {
  try {
    return parseEvalBaseline(JSON.parse(await fs.readFile(pathname, "utf8")) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
