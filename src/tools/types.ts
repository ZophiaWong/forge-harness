export type ToolStatus = "completed" | "failed" | "blocked" | "timed_out";

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  strict: boolean;
  parameters: {
    type: "object";
    [key: string]: unknown;
  };
}

export interface ToolCallRequest {
  name: string;
  arguments: string;
}

export interface ToolResult {
  toolName: string;
  status: ToolStatus;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolHandlerInput {
  callId?: string;
  rawArguments: string;
  round?: number;
}

export type ToolHandler = (input: ToolHandlerInput) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface ToolRuntime {
  close?(): Promise<void>;
  toolDefinitions(): ToolDefinition[];
  execute(toolCall: ToolCallRequest, context?: { callId?: string; round?: number }): Promise<ToolResult>;
}
