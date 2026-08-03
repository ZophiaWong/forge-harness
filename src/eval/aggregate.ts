import type {
  EvalAttemptResult,
  EvalScenarioAggregate,
} from "./types.js";

export function aggregateAttempts(attempts: EvalAttemptResult[]): EvalScenarioAggregate[] {
  const grouped = new Map<string, EvalAttemptResult[]>();
  for (const attempt of attempts) {
    const current = grouped.get(attempt.scenarioId) ?? [];
    current.push(attempt);
    grouped.set(attempt.scenarioId, current);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scenarioId, scenarioAttempts]) => {
      const assertionIds = [...new Set(scenarioAttempts.flatMap((attempt) => attempt.assertions
        .filter((assertion) => assertion.kind === "outcome")
        .map((assertion) => assertion.id)))].sort((left, right) => left.localeCompare(right));
      const assertionPassCounts = Object.fromEntries(assertionIds.map((assertionId) => [
        assertionId,
        scenarioAttempts.filter((attempt) => attempt.assertions.some((assertion) => (
          assertion.kind === "outcome"
          && assertion.id === assertionId
          && assertion.status === "passed"
        ))).length,
      ]));

      return {
        assertionPassCounts,
        attemptCount: scenarioAttempts.length,
        passCount: scenarioAttempts.filter((attempt) => attempt.outcome === "passed").length,
        scenarioId,
      };
    });
}
