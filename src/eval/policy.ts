import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
import type {
  PermissionAllowlistRule,
  PermissionApprover,
  PermissionPolicy,
} from "../governance/types.js";
import type { EvalScenario, EvalTraceSession } from "./scenario.js";

export interface EvalSessionIdentity {
  name?: string;
  profile?: "edit" | "research";
  role: EvalTraceSession["role"];
  sessionId: string;
}

export interface CreateEvalPermissionPolicyOptions {
  base?: PermissionPolicy;
  scenario: EvalScenario;
  session: EvalSessionIdentity;
}

export function createEvalPermissionPolicy(
  options: CreateEvalPermissionPolicyOptions,
): PermissionPolicy {
  const base = options.base ?? createDefaultPermissionPolicy();
  return {
    decide(toolCall) {
      if (!options.scenario.isToolCallAllowed(toTraceSession(options.session), toolCall.name, toolCall.arguments)) {
        return {
          action: "deny",
          reason: `eval scenario ${options.scenario.id} does not allow this tool call`,
          risk: "unknown",
        };
      }
      return base.decide(toolCall);
    },
  };
}

export function createEvalApprover(scenario: EvalScenario): PermissionApprover {
  return {
    async approve(request) {
      const candidateSessions: EvalSessionIdentity[] = request.toolCall.name === "write"
        ? [{
            name: "protocol-editor",
            profile: "edit",
            role: "teammate",
            sessionId: "approval-candidate",
          }]
        : [{ role: "root", sessionId: "approval-candidate" }];
      const approved = candidateSessions.some((session) => scenario.isToolCallAllowed(
        toTraceSession(session),
        request.toolCall.name,
        request.toolCall.arguments,
      ));
      return approved
        ? { approved: true, reason: "pre-authorized by the canonical eval action policy" }
        : { approved: false, reason: "outside the canonical eval action policy" };
    },
  };
}

export function createEvalTeammatePermissionRules(
  scenario: EvalScenario,
  teammateName: string,
): PermissionAllowlistRule[] {
  return scenario.manifest.actionPolicy.tools
    .filter((rule) => (
      rule.session === "teammate"
      && (rule.actor === undefined || rule.actor === teammateName)
    ))
    .map((rule) => ({
      ...(rule.arguments ? { arguments: rule.arguments } : {}),
      name: rule.name,
    }));
}

function toTraceSession(identity: EvalSessionIdentity): EvalTraceSession {
  return {
    events: [],
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.profile ? { profile: identity.profile } : {}),
    role: identity.role,
    sessionId: identity.sessionId,
  };
}
