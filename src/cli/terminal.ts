export interface CliTerminalCoordinator {
  error(message: string): void;
  log(message: string): void;
  withPrompt<T>(run: () => Promise<T>): Promise<T>;
}

export interface CreateCliTerminalCoordinatorOptions {
  stderr?: Pick<NodeJS.WriteStream, "write">;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

interface BufferedWrite {
  output: Pick<NodeJS.WriteStream, "write">;
  text: string;
}

export function createCliTerminalCoordinator(
  options: CreateCliTerminalCoordinatorOptions = {},
): CliTerminalCoordinator {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const bufferedWrites: BufferedWrite[] = [];
  let promptActive = false;
  let promptTail = Promise.resolve();

  const writeLine = (
    output: Pick<NodeJS.WriteStream, "write">,
    message: string,
  ): void => {
    const write = { output, text: `${message}\n` };
    if (promptActive) {
      bufferedWrites.push(write);
      return;
    }
    write.output.write(write.text);
  };

  const flush = (): void => {
    for (const write of bufferedWrites.splice(0)) {
      write.output.write(write.text);
    }
  };

  return {
    error(message) {
      writeLine(stderr, message);
    },
    log(message) {
      writeLine(stdout, message);
    },
    withPrompt(run) {
      const result = promptTail.then(async () => {
        promptActive = true;
        try {
          return await run();
        } finally {
          promptActive = false;
          flush();
        }
      });
      promptTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
