import OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import { formatBashResultForModel, runBashCommand } from "./bashTool.js";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

const BASH_TOOL_NAME = "bash";

const SYSTEM_INSTRUCTIONS = [
  "You are running inside a minimal coding-agent loop.",
  "You may call the bash tool to inspect the local project.",
  "Call at most one bash command at a time unless the task clearly needs otherwise.",
  "After receiving a tool result, decide whether another command is needed.",
  "When no more tool calls are needed, answer the user directly and briefly.",
].join("\n");

interface BashToolArguments {
  command: string;
}

export interface MinimalLoopTranscript {
  finalAnswer(answer: string): void;
  roundStart(round: number, model: string): void;
  toolCall(round: number, command: string): void;
  toolResult(round: number, resultText: string): void;
}

export interface MinimalLoopOptions {
  apiKey?: string;
  cwd: string;
  maxToolRounds?: number;
  model?: string;
  task: string;
  transcript?: MinimalLoopTranscript;
}

export interface MinimalLoopResult {
  finalAnswer: string;
  rounds: number;
}

export const bashToolDefinition: FunctionTool = {
  type: "function",
  name: BASH_TOOL_NAME,
  description: "Run one bash command in the current project directory and return stdout, stderr, and exit code.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "The bash command to run.",
      },
    },
    required: ["command"],
  },
};

export async function runMinimalLoop(options: MinimalLoopOptions): Promise<MinimalLoopResult> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const client = new OpenAI({ apiKey });
  const input: ResponseInputItem[] = [
    {
      role: "user",
      content: options.task,
    },
  ];

  for (let round = 1; round <= maxToolRounds; round += 1) {
    options.transcript?.roundStart(round, model);

    const response = await client.responses.create({
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
      tools: [bashToolDefinition],
    });

    input.push(...response.output);

    const toolCalls = response.output.filter(isFunctionToolCall);

    if (toolCalls.length === 0) {
      const finalAnswer = response.output_text.trim();
      options.transcript?.finalAnswer(finalAnswer);
      return { finalAnswer, rounds: round };
    }

    for (const toolCall of toolCalls) {
      const resultText = await executeToolCall(toolCall, options.cwd, round, options.transcript);
      input.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: resultText,
      });
    }
  }

  throw new Error(`Minimal loop stopped after ${maxToolRounds} tool rounds without a final answer.`);
}

function isFunctionToolCall(item: Response["output"][number]): item is ResponseFunctionToolCall {
  return item.type === "function_call";
}

async function executeToolCall(
  toolCall: ResponseFunctionToolCall,
  cwd: string,
  round: number,
  transcript: MinimalLoopTranscript | undefined,
): Promise<string> {
  if (toolCall.name !== BASH_TOOL_NAME) {
    return `status: blocked\nblocked_reason: unknown tool "${toolCall.name}"`;
  }

  const args = parseBashToolArguments(toolCall.arguments);

  if (!args) {
    return "status: blocked\nblocked_reason: bash arguments must be JSON with a string command field";
  }

  transcript?.toolCall(round, args.command);
  const result = await runBashCommand(args.command, { cwd });
  const resultText = formatBashResultForModel(result);
  transcript?.toolResult(round, resultText);
  return resultText;
}

function parseBashToolArguments(rawArguments: string): BashToolArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "command" in parsed &&
      typeof parsed.command === "string" &&
      parsed.command.trim().length > 0
    ) {
      return { command: parsed.command };
    }
  } catch {
    return undefined;
  }

  return undefined;
}
