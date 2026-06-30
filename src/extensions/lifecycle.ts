import type { TraceEventPayload, TraceRecorder } from "../runtime/trace.js";

export interface LifecycleEmitter {
  emit(event: TraceEventPayload): Promise<void>;
}

export type HookableTraceEvent = Exclude<TraceEventPayload, { type: "hook_result" }>;
export type HookableTraceEventType = HookableTraceEvent["type"];

export interface LifecycleHook {
  events?: HookableTraceEventType[];
  handle(event: HookableTraceEvent): Promise<void> | void;
  name: string;
}

export interface LifecycleEmitterOptions {
  hookResultRecorder?: TraceRecorder;
  hooks?: LifecycleHook[];
  recorder: TraceRecorder;
}

export function createLifecycleEmitter(options: LifecycleEmitterOptions): LifecycleEmitter {
  const hooks = options.hooks ?? [];
  const hookResultRecorder = options.hookResultRecorder ?? options.recorder;

  return {
    async emit(event) {
      await options.recorder.record(event);

      if (event.type === "hook_result") {
        return;
      }

      for (const hook of hooks) {
        if (!matchesHookEvent(hook, event.type)) {
          continue;
        }

        try {
          await hook.handle(event);
          await hookResultRecorder.record(createHookResult(event, hook.name, "completed"));
        } catch (error) {
          await hookResultRecorder.record(createHookResult(event, hook.name, "failed", formatHookError(error)));
        }
      }
    },
  };
}

function matchesHookEvent(hook: LifecycleHook, eventType: HookableTraceEventType): boolean {
  return !hook.events || hook.events.includes(eventType);
}

function createHookResult(
  sourceEvent: HookableTraceEvent,
  hookName: string,
  status: "completed" | "failed",
  error?: string,
): TraceEventPayload {
  return {
    ...("round" in sourceEvent && typeof sourceEvent.round === "number" ? { round: sourceEvent.round } : {}),
    ...(error ? { error } : {}),
    hookName,
    sourceEventType: sourceEvent.type,
    status,
    type: "hook_result",
  };
}

function formatHookError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
