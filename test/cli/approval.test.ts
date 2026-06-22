import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createCliApprover } from "../../src/cli/approval.js";

const approvalRequest = {
  decision: {
    action: "ask" as const,
    reason: "bash command may modify files or external state",
    risk: "mutating" as const,
  },
  toolCall: {
    arguments: JSON.stringify({ command: "touch c03-permission-demo.txt" }),
    name: "bash",
  },
};

function readableInput(text: string, isTTY = true): NodeJS.ReadStream {
  const input = Readable.from([text]) as NodeJS.ReadStream;
  Object.defineProperty(input, "isTTY", { value: isTTY });
  return input;
}

function writableOutput(isTTY = true): { output: NodeJS.WriteStream; text: () => string } {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  }) as NodeJS.WriteStream;
  Object.defineProperty(output, "isTTY", { value: isTTY });
  return {
    output,
    text: () => text,
  };
}

describe("createCliApprover", () => {
  it("approves when the user enters yes", async () => {
    const { output, text } = writableOutput();
    const approver = createCliApprover({
      input: readableInput("yes\n"),
      output,
    });

    await expect(approver.approve(approvalRequest)).resolves.toEqual({
      approved: true,
    });
    expect(text()).toContain("Approve bash command?");
    expect(text()).toContain("command: touch c03-permission-demo.txt");
    expect(text()).toContain("[y/N]:");
  });

  it("rejects by default when the user presses enter", async () => {
    const { output } = writableOutput();
    const approver = createCliApprover({
      input: readableInput("\n"),
      output,
    });

    await expect(approver.approve(approvalRequest)).resolves.toEqual({
      approved: false,
      reason: "approval rejected by user",
    });
  });

  it("rejects without prompting when the terminal is non-interactive", async () => {
    const { output, text } = writableOutput(false);
    const approver = createCliApprover({
      input: readableInput("", false),
      output,
    });

    await expect(approver.approve(approvalRequest)).resolves.toEqual({
      approved: false,
      reason: "approval requires an interactive terminal",
    });
    expect(text()).toBe("");
  });
});
