import { beforeEach, describe, expect, it, vi } from "vitest";

const { createResponseMock } = vi.hoisted(() => ({
  createResponseMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function MockOpenAI() {
    return {
      responses: {
        create: createResponseMock,
      },
    };
  }),
}));

import { runMinimalLoop } from "../../src/core/minimalLoop.js";

describe("runMinimalLoop", () => {
  beforeEach(() => {
    createResponseMock.mockReset();
  });

  it("appends function call output and continues until the model returns a final answer", async () => {
    createResponseMock
      .mockResolvedValueOnce({
        output: [
          {
            arguments: JSON.stringify({ command: "printf loop-ok" }),
            call_id: "call_1",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [],
        output_text: "done",
      });

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      task: "inspect",
    });

    expect(result).toEqual({ finalAnswer: "done", rounds: 2 });
    expect(createResponseMock).toHaveBeenCalledTimes(2);

    const secondInput = createResponseMock.mock.calls[1]?.[0].input;
    expect(secondInput).toContainEqual(
      expect.objectContaining({
        call_id: "call_1",
        output: expect.stringContaining("stdout:\nloop-ok"),
        type: "function_call_output",
      }),
    );
  });

  it("stops immediately when the model returns no tool calls", async () => {
    createResponseMock.mockResolvedValueOnce({
      output: [],
      output_text: "final response\n",
    });

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      task: "answer directly",
    });

    expect(result).toEqual({ finalAnswer: "final response", rounds: 1 });
    expect(createResponseMock).toHaveBeenCalledTimes(1);
  });

  it("fails when tool calls exceed the configured round limit", async () => {
    createResponseMock.mockResolvedValue({
      output: [
        {
          arguments: JSON.stringify({ command: "printf still-running" }),
          call_id: "call_again",
          name: "bash",
          type: "function_call",
        },
      ],
      output_text: "",
    });

    await expect(
      runMinimalLoop({
        apiKey: "test-key",
        cwd: process.cwd(),
        maxToolRounds: 1,
        task: "keep going",
      }),
    ).rejects.toThrow("Minimal loop stopped after 1 tool rounds without a final answer.");
  });

  it("emits input history snapshots before each model call", async () => {
    const events: string[] = [];

    createResponseMock
      .mockImplementationOnce(() => {
        events.push("model:1");
        return Promise.resolve({
          output: [
            {
              arguments: JSON.stringify({ command: "printf snapshot-ok" }),
              call_id: "call_snapshot",
              name: "bash",
              type: "function_call",
            },
          ],
          output_text: "",
        });
      })
      .mockImplementationOnce(() => {
        events.push("model:2");
        return Promise.resolve({
          output: [],
          output_text: "done",
        });
      });

    const snapshots: Array<{ input: unknown[]; round: number }> = [];

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      task: "inspect",
      transcript: {
        finalAnswer() {},
        historySnapshot(round, input) {
          events.push(`snapshot:${round}`);
          snapshots.push({ input: [...input], round });
        },
        roundStart() {},
        toolCall() {},
        toolResult() {},
      },
    });

    expect(snapshots).toHaveLength(2);
    expect(events).toEqual(["snapshot:1", "model:1", "snapshot:2", "model:2"]);
    expect(snapshots[0]).toMatchObject({
      input: [expect.objectContaining({ content: "inspect", role: "user" })],
      round: 1,
    });
    expect(snapshots[1]?.round).toBe(2);
    expect(snapshots[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_snapshot",
        output: expect.stringContaining("stdout:\nsnapshot-ok"),
        type: "function_call_output",
      }),
    );
  });
});
