import { fork as forkChildProcess, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  TeammateProcess,
  TeammateProcessAdapter,
  TeammateToLeaderMessage,
} from "../domain/teammate.js";

export function createNodeTeammateProcessAdapter(): TeammateProcessAdapter {
  return {
    fork(config) {
      const modulePath = fileURLToPath(new URL("../cli/teammateWorker.js", import.meta.url));
      const child = forkChildProcess(modulePath, [], {
        cwd: config.baseCwd,
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const stdoutTail = captureBoundedTail(child.stdout);
      const stderrTail = captureBoundedTail(child.stderr);
      return wrapChildProcess(child, stdoutTail, stderrTail);
    },
  };
}

function wrapChildProcess(
  child: ChildProcess,
  stdoutTail: () => string,
  stderrTail: () => string,
): TeammateProcess {
  return {
    disconnect() {
      if (child.connected) {
        child.disconnect();
      }
    },
    kill(signal) {
      return child.kill(signal);
    },
    onExit(listener) {
      child.on("exit", listener);
    },
    onMessage(listener) {
      child.on("message", (message) => {
        listener(message as TeammateToLeaderMessage);
      });
    },
    outputTail() {
      return {
        stderr: stderrTail(),
        stdout: stdoutTail(),
      };
    },
    send(message) {
      if (!child.connected) {
        throw new Error("teammate worker IPC is disconnected");
      }
      child.send(message);
    },
  };
}

function captureBoundedTail(stream: NodeJS.ReadableStream | null, limit = 8_192): () => string {
  let tail = "";
  stream?.on("data", (chunk: Buffer | string) => {
    tail = `${tail}${String(chunk)}`.slice(-limit);
  });
  return () => tail;
}
