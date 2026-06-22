import type { ToolCallRequest } from "../tools/types.js";

export type PermissionDecisionAction = "allow" | "deny" | "ask";
export type PermissionRisk = "inspect" | "mutating" | "destructive" | "unknown";

export interface PermissionDecision {
  action: PermissionDecisionAction;
  risk: PermissionRisk;
  reason: string;
}

export interface PermissionPolicy {
  decide(toolCall: ToolCallRequest): PermissionDecision;
}

export interface ApprovalRequest {
  decision: PermissionDecision;
  toolCall: ToolCallRequest;
}

export interface ApprovalResult {
  approved: boolean;
  reason?: string;
}

export interface PermissionApprover {
  approve(request: ApprovalRequest): Promise<ApprovalResult>;
}
