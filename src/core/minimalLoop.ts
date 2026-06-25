import OpenAI from "openai";

import { createToolObservation } from "../context/observation.js";
import { createContextProjection, type ContextProjection } from "../context/projection.js";
import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
import type {
  ApprovalResult,
  PermissionApprover,
  PermissionDecision,
  PermissionPolicy,
} from "../governance/types.js";
import { createDefaultToolRuntime } from "../tools/defaultRuntime.js";
import type { ToolCallRequest, ToolDefinition, ToolResult, ToolRuntime } from "../tools/types.js";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

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
  permissionDecision?(round: number, decision: PermissionDecision): void;
  roundStart(round: number, model: string): void;
  toolCall(round: number, toolName: string, argumentsText: string): void;
  toolResult(round: number, resultText: string): void;
}

export interface MinimalLoopOptions {
  apiKey?: string;
  approver?: PermissionApprover;
  baseURL?: string;
  contextProjection?: ContextProjection;
  cwd: string;
  maxToolRounds?: number;
  model?: string;
  permissionPolicy?: PermissionPolicy;
  responseCreate?: ResponseCreate;
  task: string;
  toolRuntime?: ToolRuntime;
  transcript?: MinimalLoopTranscript;
}

export interface MinimalLoopResult {
  finalAnswer: string;
  rounds: number;
}

export async function runMinimalLoop(options: MinimalLoopOptions): Promise<MinimalLoopResult> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseURL = normalizeBaseURL(options.baseURL ?? process.env.OPENAI_BASE_URL);
  const responseCreate = options.responseCreate ?? createOpenAIResponseCreate(apiKey, baseURL);
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const permissionPolicy = options.permissionPolicy ?? createDefaultPermissionPolicy();
  const approver = options.approver ?? createRejectingApprover();
  const toolRuntime = options.toolRuntime ?? createDefaultToolRuntime({ cwd: options.cwd });
  const contextProjection = options.contextProjection ?? createContextProjection();
  const input: ResponseInputItem[] = [
    {
      role: "user",
      content: options.task,
    },
  ];

  for (let round = 1; round <= maxToolRounds; round += 1) {
    options.transcript?.roundStart(round, model);

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
      tools: toolRuntime.toolDefinitions(),
    });

    input.push(...response.output);

    const toolCalls = response.output.filter(isFunctionToolCall);

    if (toolCalls.length === 0) {
      const finalAnswer = response.output_text.trim();
      options.transcript?.finalAnswer(finalAnswer);
      return { finalAnswer, rounds: round };
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
      );
      input.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: resultText,
      });
    }
  }

  throw new Error(`Minimal loop stopped after ${maxToolRounds} tool rounds without a final answer.`);
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
): Promise<string> {
  transcript?.toolCall(round, toolCall.name, toolCall.arguments);

  const request: ToolCallRequest = {
    arguments: toolCall.arguments,
    name: toolCall.name,
  };
  const decision = permissionPolicy.decide(request);
  transcript?.permissionDecision?.(round, decision);

  if (decision.action === "deny") {
    const resultText = projectToolResult(createPermissionBlockedResult(request, decision), contextProjection);
    transcript?.toolResult(round, resultText);
    return resultText;
  }

  if (decision.action === "ask") {
    const approval = await approver.approve({ decision, toolCall: request });

    if (!approval.approved) {
      const resultText = projectToolResult(createPermissionBlockedResult(request, decision, approval), contextProjection);
      transcript?.toolResult(round, resultText);
      return resultText;
    }
  }

  const result = await toolRuntime.execute(request);
  const resultText = projectToolResult(result, contextProjection);
  transcript?.toolResult(round, resultText);
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
