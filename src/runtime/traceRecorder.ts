import fs from "node:fs/promises";

import type { RecordedTraceEvent, TraceEventPayload, TraceRecorder } from "./trace.js";

export interface JsonlTraceRecorderOptions {
  now?: () => Date;
  sessionId: string;
  tracePath: string;
}

export function createJsonlTraceRecorder(options: JsonlTraceRecorderOptions): TraceRecorder {
  let sequence = 0;
  const now = options.now ?? (() => new Date());

  return {
    async record(event: TraceEventPayload) {
      sequence += 1;

      const recordedEvent: RecordedTraceEvent = {
        ...event,
        sequence,
        sessionId: options.sessionId,
        timestamp: now().toISOString(),
      };

      await fs.appendFile(options.tracePath, `${JSON.stringify(recordedEvent)}\n`, "utf8");
    },
  };
}
