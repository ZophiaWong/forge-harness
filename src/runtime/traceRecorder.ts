import fs from "node:fs/promises";

import type {
  RecordedTraceEvent,
  RecordedTracePayload,
  TraceEventPayload,
  TraceRecorder,
} from "./trace.js";

export interface JsonlTraceRecorderOptions {
  appendFile?: (tracePath: string, data: string, encoding: "utf8") => Promise<void>;
  now?: () => Date;
  sessionId: string;
  tracePath: string;
}

export function createJsonlTraceRecorder(options: JsonlTraceRecorderOptions): TraceRecorder {
  let sequence = 0;
  let writeTail = Promise.resolve();
  const appendFile = options.appendFile
    ?? ((tracePath: string, data: string, encoding: "utf8") => (
      fs.appendFile(tracePath, data, encoding)
    ));
  const now = options.now ?? (() => new Date());

  return {
    record(event: TraceEventPayload) {
      sequence += 1;

      const recordedEvent: RecordedTraceEvent = {
        ...toRecordedTracePayload(event),
        sequence,
        sessionId: options.sessionId,
        timestamp: now().toISOString(),
      };

      const write = writeTail.then(() => (
        appendFile(options.tracePath, `${JSON.stringify(recordedEvent)}\n`, "utf8")
      ));
      writeTail = write;
      return write;
    },
  };
}

function toRecordedTracePayload(event: TraceEventPayload): RecordedTracePayload {
  switch (event.type) {
    case "cron_run_finished":
    case "teammate_approval_brokered":
    case "teammate_registered":
    case "teammate_rejoined":
    case "teammate_state_changed": {
      const { sessionId: subjectSessionId, ...payload } = event;
      return { ...payload, subjectSessionId };
    }
    default:
      return event;
  }
}
