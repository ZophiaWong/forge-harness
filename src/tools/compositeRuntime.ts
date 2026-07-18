import type { ToolRuntime } from "./types.js";

export function composeToolRuntimes(runtimes: ToolRuntime[]): ToolRuntime {
  const owners = new Map<string, ToolRuntime>();
  let closePromise: Promise<void> | undefined;

  return {
    close() {
      closePromise ??= closeRuntimes(runtimes);
      return closePromise;
    },
    async execute(toolCall, context) {
      const owner = owners.get(toolCall.name);

      if (!owner) {
        return {
          content: `blocked_reason: unknown tool "${toolCall.name}"`,
          status: "blocked",
          toolName: toolCall.name,
        };
      }

      return owner.execute(toolCall, context);
    },
    toolDefinitions() {
      const definitions = [];
      const currentOwners = new Map<string, ToolRuntime>();

      for (const runtime of runtimes) {
        for (const definition of runtime.toolDefinitions()) {
          if (currentOwners.has(definition.name)) {
            throw new Error(`Duplicate tool definition "${definition.name}"`);
          }

          currentOwners.set(definition.name, runtime);
          owners.set(definition.name, runtime);
          definitions.push(definition);
        }
      }

      return definitions;
    },
  };
}

async function closeRuntimes(runtimes: ToolRuntime[]): Promise<void> {
  for (const runtime of [...runtimes].reverse()) {
    await runtime.close?.();
  }
}
