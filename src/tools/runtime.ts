import type { RegisteredTool, ToolRuntime } from "./types.js";

export function createToolRuntime(tools: RegisteredTool[]): ToolRuntime {
  const registry = new Map(tools.map((tool) => [tool.definition.name, tool]));

  return {
    toolDefinitions() {
      return tools.map((tool) => tool.definition);
    },
    async execute(toolCall) {
      const tool = registry.get(toolCall.name);

      if (!tool) {
        return {
          content: `blocked_reason: unknown tool "${toolCall.name}"`,
          status: "blocked",
          toolName: toolCall.name,
        };
      }

      try {
        return await tool.handler({ rawArguments: toolCall.arguments });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: `failed_reason: ${message}`,
          status: "failed",
          toolName: toolCall.name,
        };
      }
    },
  };
}
