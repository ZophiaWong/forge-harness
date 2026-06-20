export type ToolStatus = "completed" | "failed" | "blocked" | "timed_out";

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  strict: boolean;
  parameters: {
    type: "object";
    additionalProperties: false;
    properties: Record<
      string,
      {
        type: string | string[];
        description?: string;
        [key: string]: unknown;
      }
    >;
    required?: string[];
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
  rawArguments: string;
}

export type ToolHandler = (input: ToolHandlerInput) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface ToolRuntime {
  toolDefinitions(): ToolDefinition[];
  execute(toolCall: ToolCallRequest): Promise<ToolResult>;
}
