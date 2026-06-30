import OpenAI from "openai";

import { createToolObservation } from "../context/observation.js";
import { createContextProjection, type ContextProjection } from "../context/projection.js";
import { createLifecycleEmitter, type LifecycleEmitter } from "../extensions/lifecycle.js";
import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
import type {
  ApprovalResult,
  PermissionApprover,
  PermissionDecision,
  PermissionPolicy,
} from "../governance/types.js";
import type { RuntimeState } from "../runtime/state.js";
import { createNoopTraceRecorder } from "../runtime/trace.js";
import type { VerificationResult, Verifier } from "../runtime/verification.js";
import { createDefaultToolRuntime } from "../tools/defaultRuntime.js";
import type { ToolCallRequest, ToolDefinition, ToolResult, ToolRuntime } from "../tools/types.js";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 1;

const SYSTEM_INSTRUCTIONS = [
  "You are running inside a minimal coding-agent loop.",
  "You may call tools to inspect the local project.",
  "Prefer ls for directory listings, find for locating files, grep for searching text, and read for reading text files.",
  "Use edit for exact file text replacements and write for full-file create or overwrite operations.",
  "Use bash only when a shell command is needed.",
  "Use inspect-only commands unless the user explicitly asks for something else.",
  "Call at most one tool at a time.",
  "After receiving a tool result, decide whether another command is needed.",
  "When no more tool calls are needed, answer the user directly and briefly.",
].join("\n");

export interface UserInputItem {
  role: "user";
  content: string;
}

export interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ResponseFunctionToolCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export type ResponseOutputItem = ResponseFunctionToolCall | { type: string; [key: string]: unknown };

export type ResponseInputItem = UserInputItem | FunctionCallOutputItem | ResponseOutputItem;

export interface ResponseCreateRequest {
  include: string[];
  input: ResponseInputItem[];
  instructions: string;
  model: string;
  parallel_tool_calls: false;
  reasoning: {
    effort: "low";
  };
  store: false;
  text: {
    verbosity: "low";
  };
  tools: ToolDefinition[];
}

export interface MinimalResponse {
  output: ResponseOutputItem[];
  output_text: string;
}

export type ResponseCreate = (request: ResponseCreateRequest) => Promise<MinimalResponse>;

export interface MinimalLoopTranscript {
  finalAnswer(answer: string): void;
  finalState?(state: RuntimeState): void;
  permissionDecision?(round: number, decision: PermissionDecision): void;
  recoveryAttempt?(round: number, attempt: number, maxAttempts: number, summary: string): void;
  roundStart(round: number, model: string): void;
  roundState?(round: number, state: RuntimeState): void;
  toolCall(round: number, toolName: string, argumentsText: string): void;
  toolResult(round: number, resultText: string): void;
  verificationResult?(round: number, result: VerificationResult): void;
}

export interface MinimalLoopOptions {
  apiKey?: string;
  approver?: PermissionApprover;
  baseURL?: string;
  contextProjection?: ContextProjection;
  cwd: string;
  lifecycleEmitter?: LifecycleEmitter;
  maxRecoveryAttempts?: number;
  maxToolRounds?: number;
  model?: string;
  permissionPolicy?: PermissionPolicy;
  responseCreate?: ResponseCreate;
  runtimeState?: () => RuntimeState;
  task: string;
  toolRuntime?: ToolRuntime;
  transcript?: MinimalLoopTranscript;
  verifier?: Verifier;
}

export interface MinimalLoopResult {
  finalAnswer: string;
  rounds: number;
}

export async function runMinimalLoop(options: MinimalLoopOptions): Promise<MinimalLoopResult> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseURL = normalizeBaseURL(options.baseURL ?? process.env.OPENAI_BASE_URL);
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
  const maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const permissionPolicy = options.permissionPolicy ?? createDefaultPermissionPolicy();
  const approver = options.approver ?? createRejectingApprover();
  const toolRuntime = options.toolRuntime ?? createDefaultToolRuntime({ cwd: options.cwd });
  const contextProjection = options.contextProjection ?? createContextProjection();
  const lifecycleEmitter =
    options.lifecycleEmitter ??
    createLifecycleEmitter({
      recorder: createNoopTraceRecorder(),
    });
  const input: ResponseInputItem[] = [
    {
      role: "user",
      content: options.task,
    },
  ];
  let lastRound = 0;
  let recoveryAttempts = 0;

  try {
    await lifecycleEmitter.emit({
      cwd: options.cwd,
      maxToolRounds,
      model,
      task: options.task,
      type: "session_started",
    });
    const responseCreate = options.responseCreate ?? createOpenAIResponseCreate(apiKey, baseURL);

    for (let round = 1; round <= maxToolRounds; round += 1) {
      lastRound = round;
      options.transcript?.roundStart(round, model);
      const toolDefinitions = toolRuntime.toolDefinitions();

      await lifecycleEmitter.emit({
        inputItemCount: input.length,
        model,
        round,
        toolNames: toolDefinitions.map((tool) => tool.name),
        type: "model_request",
      });

      const response = await responseCreate({
        include: ["reasoning.encrypted_content"],
        input,
        instructions: SYSTEM_INSTRUCTIONS,
        model,
        parallel_tool_calls: false,
        reasoning: {
          effort: "low",
        },
        store: false,
        text: {
          verbosity: "low",
        },
        tools: toolDefinitions,
      });

      input.push(...response.output);

      const toolCalls = response.output.filter(isFunctionToolCall);

      await lifecycleEmitter.emit({
        functionCallCount: toolCalls.length,
        outputText: response.output_text,
        round,
        type: "model_response",
      });

      if (toolCalls.length === 0) {
        const candidateAnswer = response.output_text.trim();

        if (!options.verifier) {
          options.transcript?.finalAnswer(candidateAnswer);
          await lifecycleEmitter.emit({
            answer: candidateAnswer,
            round,
            type: "final_answer",
          });
          await lifecycleEmitter.emit({
            rounds: round,
            status: "completed",
            type: "session_ended",
          });
          reportFinalState(options);
          return { finalAnswer: candidateAnswer, rounds: round };
        }

        await lifecycleEmitter.emit({
          answer: candidateAnswer,
          round,
          type: "candidate_answer",
        });

        const verification = await options.verifier.verify({
          candidateAnswer,
          cwd: options.cwd,
          round,
          task: options.task,
        });
        options.transcript?.verificationResult?.(round, verification);
        await recordVerificationResult(lifecycleEmitter, round, verification);

        if (verification.status === "passed") {
          options.transcript?.finalAnswer(candidateAnswer);
          await lifecycleEmitter.emit({
            answer: candidateAnswer,
            round,
            type: "final_answer",
          });
          await lifecycleEmitter.emit({
            rounds: round,
            status: "completed",
            type: "session_ended",
          });
          reportFinalState(options);
          return { finalAnswer: candidateAnswer, rounds: round };
        }

        if (!verification.recoverable) {
          throw new Error(`Verification ${verification.status}.`);
        }

        if (recoveryAttempts >= maxRecoveryAttempts) {
          throw new Error(formatRecoveryLimitError(maxRecoveryAttempts));
        }

        recoveryAttempts += 1;
        await lifecycleEmitter.emit({
          attempt: recoveryAttempts,
          maxAttempts: maxRecoveryAttempts,
          round,
          summary: verification.summary,
          type: "recovery_attempt",
        });
        options.transcript?.recoveryAttempt?.(round, recoveryAttempts, maxRecoveryAttempts, verification.summary);
        input.push({
          role: "user",
          content: formatRecoveryUserMessage(verification),
        });
        continue;
      }

      for (const toolCall of toolCalls) {
        const resultText = await executeToolCall(
          toolCall,
          toolRuntime,
          permissionPolicy,
          approver,
          contextProjection,
          round,
          options.transcript,
          lifecycleEmitter,
        );
        input.push({
          type: "function_call_output",
          call_id: toolCall.call_id,
          output: resultText,
        });
      }

      reportRoundState(options, round);
    }

    throw new Error(`Minimal loop stopped after ${maxToolRounds} tool rounds without a final answer.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await lifecycleEmitter.emit({
      message,
      type: "session_failed",
    });
    await lifecycleEmitter.emit({
      rounds: lastRound,
      status: "failed",
      type: "session_ended",
    });
    throw error;
  }
}

async function recordVerificationResult(
  lifecycleEmitter: LifecycleEmitter,
  round: number,
  result: VerificationResult,
): Promise<void> {
  await lifecycleEmitter.emit({
    ...(result.command !== undefined ? { command: result.command } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    name: result.name,
    round,
    status: result.status,
    summary: result.summary,
    type: "verification_result",
  });
}

function formatRecoveryUserMessage(result: VerificationResult): string {
  return [
    "Verification failed for the previous candidate answer.",
    "",
    result.summary,
    "",
    "Continue fixing the task. Use tools if needed, then provide a new final answer.",
  ].join("\n");
}

function formatRecoveryLimitError(maxRecoveryAttempts: number): string {
  const suffix = maxRecoveryAttempts === 1 ? "attempt" : "attempts";
  return `Verification failed after ${maxRecoveryAttempts} recovery ${suffix}.`;
}

function reportRoundState(options: MinimalLoopOptions, round: number): void {
  const runtimeState = options.runtimeState?.();
  if (runtimeState) {
    options.transcript?.roundState?.(round, runtimeState);
  }
}

function reportFinalState(options: MinimalLoopOptions): void {
  const runtimeState = options.runtimeState?.();
  if (runtimeState) {
    options.transcript?.finalState?.(runtimeState);
  }
}

function createOpenAIResponseCreate(apiKey: string | undefined, baseURL: string | undefined): ResponseCreate {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const client = new OpenAI(baseURL ? { apiKey, baseURL } : { apiKey });

  return async (request) => {
    const response = await client.responses.create(request as Parameters<typeof client.responses.create>[0]);
    return response as unknown as MinimalResponse;
  };
}

function isFunctionToolCall(item: ResponseOutputItem): item is ResponseFunctionToolCall {
  return item.type === "function_call";
}

async function executeToolCall(
  toolCall: ResponseFunctionToolCall,
  toolRuntime: ToolRuntime,
  permissionPolicy: PermissionPolicy,
  approver: PermissionApprover,
  contextProjection: ContextProjection,
  round: number,
  transcript: MinimalLoopTranscript | undefined,
  lifecycleEmitter: LifecycleEmitter,
): Promise<string> {
  transcript?.toolCall(round, toolCall.name, toolCall.arguments);
  await lifecycleEmitter.emit({
    argumentsText: toolCall.arguments,
    callId: toolCall.call_id,
    round,
    toolName: toolCall.name,
    type: "tool_call",
  });

  const request: ToolCallRequest = {
    arguments: toolCall.arguments,
    name: toolCall.name,
  };
  const decision = permissionPolicy.decide(request);
  transcript?.permissionDecision?.(round, decision);
  await lifecycleEmitter.emit({
    action: decision.action,
    callId: toolCall.call_id,
    reason: decision.reason,
    risk: decision.risk,
    round,
    toolName: toolCall.name,
    type: "permission_decision",
  });

  if (decision.action === "deny") {
    const result = createPermissionBlockedResult(request, decision);
    const resultText = projectToolResult(result, contextProjection);
    transcript?.toolResult(round, resultText);
    await lifecycleEmitter.emit({
      callId: toolCall.call_id,
      projectedOutput: resultText,
      round,
      status: result.status,
      toolName: toolCall.name,
      type: "tool_result",
    });
    return resultText;
  }

  if (decision.action === "ask") {
    const approval = await approver.approve({ decision, toolCall: request });
    const approvalEvent = {
      approved: approval.approved,
      callId: toolCall.call_id,
      round,
      toolName: toolCall.name,
      type: "approval_result" as const,
      ...(approval.reason ? { reason: approval.reason } : {}),
    };
    await lifecycleEmitter.emit(approvalEvent);

    if (!approval.approved) {
      const result = createPermissionBlockedResult(request, decision, approval);
      const resultText = projectToolResult(result, contextProjection);
      transcript?.toolResult(round, resultText);
      await lifecycleEmitter.emit({
        callId: toolCall.call_id,
        projectedOutput: resultText,
        round,
        status: result.status,
        toolName: toolCall.name,
        type: "tool_result",
      });
      return resultText;
    }
  }

  const result = await toolRuntime.execute(request);
  const resultText = projectToolResult(result, contextProjection);
  transcript?.toolResult(round, resultText);
  await lifecycleEmitter.emit({
    callId: toolCall.call_id,
    projectedOutput: resultText,
    round,
    status: result.status,
    toolName: toolCall.name,
    type: "tool_result",
  });
  return resultText;
}

function projectToolResult(result: ToolResult, contextProjection: ContextProjection): string {
  return contextProjection.projectObservation(createToolObservation(result));
}

function createPermissionBlockedResult(
  toolCall: ToolCallRequest,
  decision: PermissionDecision,
  approval?: ApprovalResult,
): ToolResult {
  const reason = approval?.reason ?? decision.reason;
  const lines = [
    "permission_denied: true",
    `decision: ${decision.action}`,
    `risk: ${decision.risk}`,
    `reason: ${reason}`,
  ];

  if (approval?.reason && approval.reason !== decision.reason) {
    lines.push(`policy_reason: ${decision.reason}`);
  }

  return {
    content: lines.join("\n"),
    metadata: {
      permissionDecision: decision,
      rejectionReason: approval?.reason,
    },
    status: "blocked",
    toolName: toolCall.name,
  };
}

function createRejectingApprover(): PermissionApprover {
  return {
    async approve() {
      return {
        approved: false,
        reason: "approval requires an approver",
      };
    },
  };
}

function normalizeBaseURL(baseURL: string | undefined): string | undefined {
  const normalized = baseURL?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
