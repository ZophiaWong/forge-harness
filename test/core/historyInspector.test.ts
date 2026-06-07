import { describe, expect, it } from "vitest";
import type { ResponseInputItem } from "openai/resources/responses/responses";

import { formatHistorySnapshot } from "../../src/core/historyInspector.js";

describe("formatHistorySnapshot", () => {
  it("summarizes user messages with role, type, size, and preview", () => {
    const snapshot = formatHistorySnapshot(
      [
        {
          role: "user",
          content: "inspect this project",
        },
      ],
      { previewLength: 80 },
    );

    expect(snapshot).toContain("[0] type=message role=user");
    expect(snapshot).toContain("chars=20");
    expect(snapshot).toContain('preview="inspect this project"');
  });

  it("summarizes function calls and function call outputs", () => {
    const snapshot = formatHistorySnapshot(
      [
        {
          arguments: JSON.stringify({ command: "ls -la" }),
          call_id: "call_1",
          name: "bash",
          type: "function_call",
        },
        {
          call_id: "call_1",
          output: "status: completed\nstdout:\npackage.json",
          type: "function_call_output",
        },
      ],
      { previewLength: 80 },
    );

    expect(snapshot).toContain("[0] type=function_call name=bash call_id=call_1");
    expect(snapshot).toContain('preview="{\\"command\\":\\"ls -la\\"}"');
    expect(snapshot).toContain("[1] type=function_call_output call_id=call_1");
    expect(snapshot).toContain("stdout:");
  });

  it("truncates long previews", () => {
    const snapshot = formatHistorySnapshot(
      [
        {
          call_id: "call_1",
          output: "abcdefghijklmnopqrstuvwxyz",
          type: "function_call_output",
        },
      ],
      { previewLength: 8 },
    );

    expect(snapshot).toContain('preview="abcdefgh..."');
  });

  it("uses a generic preview for unknown provider items", () => {
    const item = {
      custom: "value",
      type: "future_provider_item",
    } as unknown as ResponseInputItem;

    const snapshot = formatHistorySnapshot([item], { previewLength: 80 });

    expect(snapshot).toContain("[0] type=future_provider_item");
    expect(snapshot).toContain('preview="[unsupported provider item]"');
    expect(snapshot).not.toContain("custom");
  });

  it("uses the default preview length for invalid preview lengths", () => {
    const output = "a".repeat(130);
    const snapshot = formatHistorySnapshot(
      [
        {
          call_id: "call_1",
          output,
          type: "function_call_output",
        },
      ],
      { previewLength: -1 },
    );

    expect(snapshot).toContain(`preview="${"a".repeat(120)}..."`);
  });
});
