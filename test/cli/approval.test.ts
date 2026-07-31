import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createCliApprover } from "../../src/cli/approval.js";
import { createCliTerminalCoordinator } from "../../src/cli/terminal.js";

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

const editApprovalRequest = {
  decision: {
    action: "ask" as const,
    reason: "file edit may modify project files",
    risk: "mutating" as const,
  },
  toolCall: {
    arguments: JSON.stringify({
      newText: "new line",
      oldText: "old line",
      path: "sample.txt",
    }),
    name: "edit",
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

  it("prints arguments for non-bash tool approval prompts", async () => {
    const { output, text } = writableOutput();
    const approver = createCliApprover({
      input: readableInput("yes\n"),
      output,
    });

    await expect(approver.approve(editApprovalRequest)).resolves.toEqual({
      approved: true,
    });
    expect(text()).toContain("Approve edit tool call?");
    expect(text()).toContain('arguments: {"newText":"new line","oldText":"old line","path":"sample.txt"}');
    expect(text()).not.toContain("command:");
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

  it("buffers background output without changing a pending yes answer", async () => {
    const input = controlledInput();
    const { output, text } = writableOutput();
    const terminal = createCliTerminalCoordinator({
      stderr: output,
      stdout: output,
    });
    const approver = createCliApprover({ input, output, terminal });
    const approval = approver.approve(editApprovalRequest);
    await waitUntil(() => text().includes("[y/N]:"));

    input.write("y");
    terminal.log("[mailbox] id=msg_leader_000001 kind=turn_result");
    const outputBeforeNewline = text();
    input.write("\n");

    await expect(approval).resolves.toEqual({ approved: true });
    expect(outputBeforeNewline).not.toContain("[mailbox]");
    expect(text()).toContain("[mailbox] id=msg_leader_000001 kind=turn_result");
  });

  it("serializes concurrent approval prompts through one terminal", async () => {
    const input = controlledInput();
    const { output, text } = writableOutput();
    const terminal = createCliTerminalCoordinator({
      stderr: output,
      stdout: output,
    });
    const approver = createCliApprover({ input, output, terminal });

    const first = approver.approve(approvalRequest);
    const second = approver.approve(editApprovalRequest);
    await waitUntil(() => text().includes("[y/N]:"));
    const promptsBeforeFirstAnswer = occurrences(text(), "[y/N]:");

    input.write("yes\n");
    await expect(first).resolves.toEqual({ approved: true });
    await waitUntil(() => occurrences(text(), "[y/N]:") === 2);
    input.write("no\n");

    await expect(second).resolves.toEqual({
      approved: false,
      reason: "approval rejected by user",
    });
    expect(promptsBeforeFirstAnswer).toBe(1);
  });
});

function controlledInput(): NodeJS.ReadStream {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(input, "isTTY", { value: true });
  return input;
}

function occurrences(text: string, pattern: string): number {
  return text.split(pattern).length - 1;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}
