export const CANONICAL_SCENARIO_REPETITIONS = {
  "async-child-handoff": 3,
  "c17c-team-completion": 1,
  "compaction-retention": 3,
  "governed-read-only": 3,
  "verification-recovery": 3,
} as const;

export const CANONICAL_SCENARIO_ORDER = [
  "governed-read-only",
  "verification-recovery",
  "compaction-retention",
  "async-child-handoff",
  "c17c-team-completion",
] as const;

export const CANONICAL_ATTEMPT_COUNT = Object.values(CANONICAL_SCENARIO_REPETITIONS)
  .reduce((total, repetitions) => total + repetitions, 0);
