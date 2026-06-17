import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAIResponseMock, OpenAIMock } = vi.hoisted(() => {
  const createOpenAIResponseMock = vi.fn();
  const OpenAIMock = vi.fn().mockImplementation(() => ({
    responses: {
      create: createOpenAIResponseMock,
    },
  }));

  return { createOpenAIResponseMock, OpenAIMock };
});

vi.mock("openai", () => ({
  default: OpenAIMock,
}));

import { runMinimalLoop, type ResponseCreate } from "../../src/core/minimalLoop.js";

function createResponseCreate(...responses: Awaited<ReturnType<ResponseCreate>>[]): ResponseCreate {
  const calls: Parameters<ResponseCreate>[0][] = [];

  const responseCreate: ResponseCreate = async (request) => {
    calls.push(request);
    const response = responses.shift();

    if (!response) {
      throw new Error("unexpected model request");
    }

    return response;
  };

  Object.defineProperty(responseCreate, "calls", {
    value: calls,
  });

  return responseCreate;
}

function callsFor(responseCreate: ResponseCreate): Parameters<ResponseCreate>[0][] {
  return (responseCreate as ResponseCreate & { calls: Parameters<ResponseCreate>[0][] }).calls;
}

describe("runMinimalLoop", () => {
  beforeEach(() => {
    createOpenAIResponseMock.mockReset();
    OpenAIMock.mockClear();
  });

  it("appends function call output and continues until the model returns a final answer", async () => {
    const rawArguments = JSON.stringify({ command: "printf loop-ok" });
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: rawArguments,
            call_id: "call_1",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "done",
      },
    );

    const transcript = {
      finalAnswer: vi.fn(),
      roundStart: vi.fn(),
      toolCall: vi.fn(),
      toolResult: vi.fn(),
    };

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      responseCreate,
      task: "inspect",
      transcript,
    });

    expect(result).toEqual({ finalAnswer: "done", rounds: 2 });
    expect(callsFor(responseCreate)).toHaveLength(2);
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_1",
        output: expect.stringContaining("stdout:\nloop-ok"),
        type: "function_call_output",
      }),
    );
    expect(transcript.toolCall).toHaveBeenCalledWith(1, "bash", rawArguments);
    expect(transcript.finalAnswer).toHaveBeenCalledWith("done");
  });

  it("creates the OpenAI client with a configured baseURL", async () => {
    createOpenAIResponseMock.mockResolvedValueOnce({
      output: [],
      output_text: "done",
    });

    const result = await runMinimalLoop({
      apiKey: "test-key",
      baseURL: "https://gateway.example/v1",
      cwd: process.cwd(),
      task: "answer directly",
    });

    expect(result).toEqual({ finalAnswer: "done", rounds: 1 });
    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "test-key",
      baseURL: "https://gateway.example/v1",
    });
  });

  it("treats an empty baseURL as the default OpenAI endpoint", async () => {
    createOpenAIResponseMock.mockResolvedValueOnce({
      output: [],
      output_text: "done",
    });

    await runMinimalLoop({
      apiKey: "test-key",
      baseURL: "",
      cwd: process.cwd(),
      task: "answer directly",
    });

    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "test-key",
    });
  });

  it("reads OPENAI_BASE_URL from the environment", async () => {
    const previousBaseURL = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://env-gateway.example/v1";
    createOpenAIResponseMock.mockResolvedValueOnce({
      output: [],
      output_text: "done",
    });

    try {
      await runMinimalLoop({
        apiKey: "test-key",
        cwd: process.cwd(),
        task: "answer directly",
      });
    } finally {
      if (previousBaseURL === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = previousBaseURL;
      }
    }

    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "test-key",
      baseURL: "https://env-gateway.example/v1",
    });
  });

  it("stops immediately when the model returns no tool calls", async () => {
    const responseCreate = createResponseCreate({
      output: [],
      output_text: "final response\n",
    });

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      responseCreate,
      task: "answer directly",
    });

    expect(result).toEqual({ finalAnswer: "final response", rounds: 1 });
    expect(callsFor(responseCreate)).toHaveLength(1);
  });

  it("fails when tool calls exceed the configured round limit", async () => {
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ command: "printf still-running" }),
            call_id: "call_again",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [
          {
            arguments: JSON.stringify({ command: "printf still-running" }),
            call_id: "call_again_2",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
    );

    await expect(
      runMinimalLoop({
        apiKey: "test-key",
        cwd: process.cwd(),
        maxToolRounds: 1,
        responseCreate,
        task: "keep going",
      }),
    ).rejects.toThrow("Minimal loop stopped after 1 tool rounds without a final answer.");
  });

  it("feeds blocked results back to the model for malformed tool arguments", async () => {
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: "{bad json",
            call_id: "call_bad",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "reported bad args",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      responseCreate,
      task: "inspect",
    });

    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_bad",
        output: expect.stringContaining("blocked_reason: bash arguments must be JSON"),
        type: "function_call_output",
      }),
    );
  });
});
