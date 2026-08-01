import { expect, it } from "vitest";

import {
  runMinimalLoop,
  type ResponseCreate,
} from "../../../src/core/minimalLoop.js";
import type {
  PermissionDecision,
  PermissionPolicy,
} from "../../../src/governance/types.js";
import type { ToolRuntime } from "../../../src/tools/types.js";

it("characterizes direct multi-call serial and source ordering", async () => {
  const events: string[] = [];
  const requests: Parameters<ResponseCreate>[0][] = [];
  const responseCreate: ResponseCreate = async (request) => {
    requests.push(request);

    if (requests.length === 1) {
      return {
        output: [
          {
            arguments: JSON.stringify({ label: "A" }),
            call_id: "call_a",
            name: "alpha",
            type: "function_call",
          },
          {
            arguments: JSON.stringify({ label: "B" }),
            call_id: "call_b",
            name: "beta",
            type: "function_call",
          },
        ],
        output_text: "",
      };
    }

    if (requests.length === 2) {
      return { output: [], output_text: "done" };
    }

    throw new Error("unexpected model request");
  };
  const permissionPolicy: PermissionPolicy = {
    decide(call): PermissionDecision {
      events.push(`permission:${call.name}`);
      return { action: "allow", reason: "research fixture", risk: "inspect" };
    },
  };
  const toolRuntime: ToolRuntime = {
    async execute(call) {
      events.push(`execute-start:${call.name}`);
      await Promise.resolve();
      events.push(`execute-end:${call.name}`);
      return {
        content: `observed ${call.name}`,
        status: "completed",
        toolName: call.name,
      };
    },
    toolDefinitions() {
      return ["alpha", "beta"].map((name) => ({
        description: `${name} research tool`,
        name,
        parameters: {
          additionalProperties: false,
          properties: { label: { type: "string" } },
          required: ["label"],
          type: "object",
        },
        strict: true,
        type: "function" as const,
      }));
    },
  };

  await runMinimalLoop({
    apiKey: "research-fixture",
    contextCompaction: false,
    cwd: process.cwd(),
    permissionPolicy,
    responseCreate,
    task: "characterize direct multi-call ordering",
    toolRuntime,
  });

  expect(events).toEqual([
    "permission:alpha",
    "execute-start:alpha",
    "execute-end:alpha",
    "permission:beta",
    "execute-start:beta",
    "execute-end:beta",
  ]);
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => request.parallel_tool_calls)).toEqual([false, false]);
  expect(
    requests[1]?.input
      .filter((item) => item.type === "function_call_output")
      .map((item) => "call_id" in item ? item.call_id : undefined),
  ).toEqual(["call_a", "call_b"]);
});
