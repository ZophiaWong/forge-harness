import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createCliTerminalCoordinator } from "../../src/cli/terminal.js";

describe("createCliTerminalCoordinator", () => {
  it("writes stdout and stderr immediately when no prompt is active", () => {
    const fixture = outputFixture();
    const terminal = createCliTerminalCoordinator(fixture);

    terminal.log("ready");
    terminal.error("failed");

    expect(fixture.events).toEqual([
      "stdout:ready\n",
      "stderr:failed\n",
    ]);
  });

  it("buffers background output during a prompt and flushes it in call order", async () => {
    const fixture = outputFixture();
    const terminal = createCliTerminalCoordinator(fixture);
    const promptGate = deferred<void>();
    const prompt = terminal.withPrompt(async () => {
      fixture.events.push("prompt:start");
      await promptGate.promise;
      fixture.events.push("prompt:end");
    });
    await waitUntil(() => fixture.events.includes("prompt:start"));

    terminal.log("[mailbox] result");
    terminal.error("[team] failure");
    terminal.log("[team] idle");

    expect(fixture.events).toEqual(["prompt:start"]);

    promptGate.resolve();
    await prompt;

    expect(fixture.events).toEqual([
      "prompt:start",
      "prompt:end",
      "stdout:[mailbox] result\n",
      "stderr:[team] failure\n",
      "stdout:[team] idle\n",
    ]);
  });

  it("flushes buffered output after a prompt throws", async () => {
    const fixture = outputFixture();
    const terminal = createCliTerminalCoordinator(fixture);

    await expect(terminal.withPrompt(async () => {
      terminal.log("queued");
      throw new Error("prompt failed");
    })).rejects.toThrow("prompt failed");

    expect(fixture.events).toEqual(["stdout:queued\n"]);
  });

  it("flushes buffered output before starting the next queued prompt", async () => {
    const fixture = outputFixture();
    const terminal = createCliTerminalCoordinator(fixture);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const firstPrompt = terminal.withPrompt(async () => {
      fixture.events.push("prompt:first");
      await firstGate.promise;
    });
    const secondPrompt = terminal.withPrompt(async () => {
      fixture.events.push("prompt:second");
      await secondGate.promise;
    });
    await waitUntil(() => fixture.events.includes("prompt:first"));

    terminal.log("between prompts");
    expect(fixture.events).toEqual(["prompt:first"]);

    firstGate.resolve();
    await firstPrompt;
    await waitUntil(() => fixture.events.includes("prompt:second"));

    expect(fixture.events).toEqual([
      "prompt:first",
      "stdout:between prompts\n",
      "prompt:second",
    ]);

    secondGate.resolve();
    await secondPrompt;
  });
});

function outputFixture(): {
  events: string[];
  stderr: NodeJS.WriteStream;
  stdout: NodeJS.WriteStream;
} {
  const events: string[] = [];
  return {
    events,
    stderr: recordedStream("stderr", events),
    stdout: recordedStream("stdout", events),
  };
}

function recordedStream(name: string, events: string[]): NodeJS.WriteStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      events.push(`${name}:${chunk.toString("utf8")}`);
      callback();
    },
  }) as NodeJS.WriteStream;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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
