import type { Observation } from "./observation.js";

export interface ContextProjection {
  projectObservation(observation: Observation): string;
}

export function createContextProjection(): ContextProjection {
  return {
    projectObservation(observation) {
      return projectObservation(observation);
    },
  };
}

export function projectObservation(observation: Observation): string {
  const content = observation.content.length > 0 ? observation.content : "(empty)";

  return [
    `tool: ${observation.toolName}`,
    `status: ${observation.status}`,
    `observation: ${observation.summary}`,
    content,
  ].join("\n");
}
