import { describe, expect, it } from "vitest";

import { createTaskStateStore } from "../../src/runtime/task.js";
import { createTodoTool } from "../../src/tools/todoTool.js";

const validSnapshot = {
  acceptance: ["npm run build exits with code 0"],
  items: [
    {
      id: "inspect",
      status: "completed",
      title: "Inspect the current failure",
    },
    {
      id: "patch",
      note: "Changing the focused source file",
      status: "in_progress",
      title: "Patch the source file",
    },
  ],
  summary: "Fix the build with a focused patch.",
};

describe("todo tool", () => {
  it("replaces the run task snapshot and returns a compact projected result", async () => {
    const store = createTaskStateStore();
    const tool = createTodoTool(store);

    const result = await tool.handler({
      rawArguments: JSON.stringify(validSnapshot),
    });

    expect(result.status).toBe("completed");
    expect(result.toolName).toBe("todo");
    expect(result.metadata?.observationSummary).toBe(
      "task plan updated: 2 items, 1 in_progress, 1 completed, 0 blocked",
    );
    expect(result.metadata?.taskState).toEqual(validSnapshot);
    expect(store.getState()).toEqual(validSnapshot);
    expect(result.content).toContain("summary: Fix the build with a focused patch.");
    expect(result.content).toContain("- completed inspect: Inspect the current failure");
    expect(result.content).toContain("- in_progress patch: Patch the source file");
    expect(result.content).toContain("  note: Changing the focused source file");
    expect(result.content).toContain("- npm run build exits with code 0");
  });

  it("rejects malformed arguments without changing the current task snapshot", async () => {
    const store = createTaskStateStore();
    const tool = createTodoTool(store);

    const result = await tool.handler({
      rawArguments: "{bad json",
    });

    expect(result).toEqual({
      content:
        "failed_reason: todo arguments must be JSON with summary, non-empty items, and non-empty acceptance fields",
      metadata: {
        observationSummary: "todo failed",
      },
      status: "failed",
      toolName: "todo",
    });
    expect(store.getState()).toBeUndefined();
  });

  it("rejects duplicate ids, invalid statuses, and multiple active items", async () => {
    const store = createTaskStateStore();
    const tool = createTodoTool(store);

    await expect(
      tool.handler({
        rawArguments: JSON.stringify({
          ...validSnapshot,
          items: [
            { id: "same", status: "pending", title: "First" },
            { id: "same", status: "completed", title: "Second" },
          ],
        }),
      }),
    ).resolves.toMatchObject({
      content: 'failed_reason: duplicate todo id "same"',
      status: "failed",
      toolName: "todo",
    });

    await expect(
      tool.handler({
        rawArguments: JSON.stringify({
          ...validSnapshot,
          items: [{ id: "bad-status", status: "started", title: "Use an invalid status" }],
        }),
      }),
    ).resolves.toMatchObject({
      content: 'failed_reason: todo item "bad-status" has invalid status "started"',
      status: "failed",
      toolName: "todo",
    });

    await expect(
      tool.handler({
        rawArguments: JSON.stringify({
          ...validSnapshot,
          items: [
            { id: "first", status: "in_progress", title: "First active item" },
            { id: "second", status: "in_progress", title: "Second active item" },
          ],
        }),
      }),
    ).resolves.toMatchObject({
      content: "failed_reason: todo snapshot can have at most one in_progress item",
      status: "failed",
      toolName: "todo",
    });
    expect(store.getState()).toBeUndefined();
  });

  it("rejects snapshots above the c10 size caps", async () => {
    const store = createTaskStateStore();
    const tool = createTodoTool(store);

    const result = await tool.handler({
      rawArguments: JSON.stringify({
        acceptance: ["one"],
        items: Array.from({ length: 13 }, (_, index) => ({
          id: `item-${index + 1}`,
          status: "pending",
          title: `Item ${index + 1}`,
        })),
        summary: "Too many items.",
      }),
    });

    expect(result).toMatchObject({
      content: "failed_reason: todo snapshot can have at most 12 items",
      status: "failed",
      toolName: "todo",
    });
    expect(store.getState()).toBeUndefined();
  });
});
