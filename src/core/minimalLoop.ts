import OpenAI from "openai";

import { createDefaultToolRuntime } from "../tools/defaultRuntime.js";
import { formatToolResultForModel } from "../tools/result.js";
import type { ToolDefinition, ToolRuntime } from "../tools/types.js";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

const SYSTEM_INSTRUCTIONS = [
  "You are running inside a minimal coding-agent loop.",
  "You may call tools to inspect the local project.",
  "Prefer ls for directory listings and read for reading text files.",
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
  roundStart(round: number, model: string): void;
  toolCall(round: number, toolName: string, argumentsText: string): void;
  toolResult(round: number, resultText: string): void;
}

export interface MinimalLoopOptions {
  apiKey?: string;
  baseURL?: string;
  cwd: string;
  maxToolRounds?: number;
  model?: string;
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
  const toolRuntime = options.toolRuntime ?? createDefaultToolRuntime({ cwd: options.cwd });
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
      const resultText = await executeToolCall(toolCall, toolRuntime, round, options.transcript);
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
  round: number,
  transcript: MinimalLoopTranscript | undefined,
): Promise<string> {
  transcript?.toolCall(round, toolCall.name, toolCall.arguments);

  const result = await toolRuntime.execute({
    arguments: toolCall.arguments,
    name: toolCall.name,
  });
  const resultText = formatToolResultForModel(result);
  transcript?.toolResult(round, resultText);
  return resultText;
}

function normalizeBaseURL(baseURL: string | undefined): string | undefined {
  const normalized = baseURL?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
