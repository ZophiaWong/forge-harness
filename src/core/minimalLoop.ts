import { performance } from "node:perf_hooks";

import OpenAI from "openai";
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";

import {
  buildCompactionSource,
  createInputHistoryManager,
  DEFAULT_COMPACTION_OPTIONS,
  estimateInputCharCount,
  inspectCompactionSummary,
  type CompactableInputItem,
  type ContextCompactionOptions,
  type ContextCompactionTrigger,
} from "../context/compaction.js";
import { createToolObservation } from "../context/observation.js";
import {
  assemblePrompt,
  loadRepoPromptAssets,
  type PromptAssets,
  type PromptAssemblySummary,
} from "../context/promptAssembly.js";
import { createContextProjection, type ContextProjection } from "../context/projection.js";
import type { ModelCallTelemetry, ModelUsage } from "../domain/model.js";
import {
  createAsyncChildSessionManager,
  formatChildSessionNotification,
  type AsyncChildSessionManager,
  type AsyncChildSessionNotification,
  type ChildSessionRunner,
} from "../extensions/childSessions.js";
import type { TeammateManager } from "../extensions/teammates.js";
import { createLifecycleEmitter, type LifecycleEmitter } from "../extensions/lifecycle.js";
import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
import type {
  ApprovalResult,
  PermissionApprover,
  PermissionDecision,
  PermissionPolicy,
} from "../governance/types.js";
import type {
  TeamTaskFailureCode,
  TeamTaskMutationOperation,
  TeamTaskStatus,
} from "../domain/teamTask.js";
import {
  createBackgroundTaskManager,
  formatBackgroundTaskNotification,
  type BackgroundTaskKind,
  type BackgroundTaskManager,
  type BackgroundTaskNotification,
} from "../runtime/backgroundTasks.js";
import type { CronSchedule, CronScheduleStore } from "../runtime/cronStore.js";
import type { RuntimeState } from "../runtime/state.js";
import type { SessionWorkspaceMetadata } from "../runtime/session.js";
import type { TeamMessage } from "../runtime/teamMailbox.js";
import { isTaskState } from "../runtime/task.js";
import { createNoopTraceRecorder } from "../runtime/trace.js";
import type { SessionEndStatus, TraceTaskGraphProjection } from "../runtime/trace.js";
import type { VerificationResult, Verifier } from "../runtime/verification.js";
import { createDefaultToolRuntime } from "../tools/defaultRuntime.js";
import { composeToolRuntimes } from "../tools/compositeRuntime.js";
import type { TeamTaskToolRuntimeOptions } from "../tools/teamTaskTools.js";
import { createGitIntegrationService } from "../runtime/gitIntegration.js";
import {
  createCompletionGate,
  formatCompletionBlockers,
} from "../runtime/completionGate.js";
import type { ToolCallRequest, ToolDefinition, ToolResult, ToolRuntime } from "../tools/types.js";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_MAX_TOOL_ROUNDS = 48;
export const DEFAULT_MAX_RECOVERY_ATTEMPTS = 1;
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MODEL_REQUEST_MAX_RETRIES = 2;

export type { ModelCallTelemetry, ModelUsage } from "../domain/model.js";

export interface UserInputItem {
  role: "user";
  content: string;
}

export interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ResponseFunctionToolCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export type ResponseOutputItem = ResponseFunctionToolCall | { type: string; [key: string]: unknown };

export type ResponseInputItem = UserInputItem | FunctionCallOutputItem | ResponseOutputItem;

export interface ResponseCreateRequest {
  include: string[];
  input: ResponseInputItem[];
  instructions: string;
  model: string;
  parallel_tool_calls: false;
  reasoning: {
    effort: "low";
  };
  store: false;
  text: {
    verbosity: "low";
  };
  tools: ToolDefinition[];
}

export interface MinimalResponse {
  output: ResponseOutputItem[];
  output_text: string;
  telemetry?: ModelCallTelemetry;
}

export type ResponseCreate = (request: ResponseCreateRequest) => Promise<MinimalResponse>;

export interface MinimalLoopTranscript {
  contextCompaction?(compaction: {
    afterCharCount: number;
    beforeCharCount: number;
    compactedRoundCount: number;
    keptRecentRoundCount: number;
    missingHeadings: Array<"Task" | "Progress" | "Evidence" | "Open Questions" | "Next Step">;
    reason: string;
    round: number;
    sourceItemCount: number;
    sourceRoundCount: number;
    summaryCharCount: number;
    trigger: ContextCompactionTrigger;
  }): void;
  finalAnswer(answer: string): void;
  finalState?(state: RuntimeState): void;
  permissionDecision?(round: number, decision: PermissionDecision): void;
  promptAssembly?(round: number, summary: PromptAssemblySummary): void;
  recoveryAttempt?(round: number, attempt: number, maxAttempts: number, summary: string): void;
  roundStart(round: number, model: string): void;
  roundState?(round: number, state: RuntimeState): void;
  toolCall(round: number, toolName: string, argumentsText: string): void;
  toolResult(round: number, resultText: string): void;
  verificationResult?(round: number, result: VerificationResult): void;
}

export interface MinimalLoopOptions {
  additionalToolRuntimes?: ToolRuntime[];
  apiKey?: string;
  approver?: PermissionApprover;
  baseURL?: string;
  contextProjection?: ContextProjection;
  contextCompaction?: false | Partial<ContextCompactionOptions>;
  baseCwd?: string;
  cwd: string;
  lifecycleEmitter?: LifecycleEmitter;
  maxRecoveryAttempts?: number;
  maxToolRounds?: number;
  model?: string;
  permissionPolicy?: PermissionPolicy;
  promptAssets?: PromptAssets;
  responseCreate?: ResponseCreate;
  runtimeState?: () => RuntimeState;
  cronSchedules?: CronScheduleStore;
  childSessionRunner?: ChildSessionRunner;
  task: string;
  teamTasks?: TeamTaskToolRuntimeOptions;
  teammates?: TeammateManager;
  toolRuntime?: ToolRuntime;
  transcript?: MinimalLoopTranscript;
  verifier?: Verifier;
  workspace?: SessionWorkspaceMetadata;
}

export interface MinimalLoopResult {
  finalAnswer: string;
  rounds: number;
}

export interface MinimalLoopTurnOptions {
  maxToolRounds?: number;
}

export interface MinimalLoopSession {
  close(status: SessionEndStatus): Promise<void>;
  runTurn(input?: string, options?: MinimalLoopTurnOptions): Promise<MinimalLoopResult>;
}

const COMPACTION_INSTRUCTIONS = [
  "You are compacting an agent session history.",
  "Write a concise handoff summary that preserves task intent, progress, evidence, open questions, and the next step.",
  "Use these fixed Markdown headings when possible:",
  "## Task",
  "## Progress",
  "## Evidence",
  "## Open Questions",
  "## Next Step",
  "The supplied source contains only older history selected for compaction. Recent raw rounds are kept separately in the next model input.",
  "Do not say recent-round evidence is missing just because it is not included in the compaction source.",
  "Do not invent facts. Do not call tools. Summarize only the supplied history and state.",
].join("\n");

export async function runMinimalLoop(options: MinimalLoopOptions): Promise<MinimalLoopResult> {
  const session = await createMinimalLoopSession(options);

  try {
    const result = await session.runTurn();
    await session.close("completed");
    reportFinalState(options);
    return result;
  } catch (error) {
    await session.close("failed");
    throw error;
  }
}

export async function createMinimalLoopSession(options: MinimalLoopOptions): Promise<MinimalLoopSession> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseURL = normalizeBaseURL(options.baseURL ?? process.env.OPENAI_BASE_URL);
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
  const maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const permissionPolicy = options.permissionPolicy ?? createDefaultPermissionPolicy();
  const approver = options.approver ?? createRejectingApprover();
  let lastRound = 0;
  const lifecycleEmitter =
    options.lifecycleEmitter ??
    createLifecycleEmitter({
      recorder: createNoopTraceRecorder(),
    });
  const backgroundTasks = options.toolRuntime
    ? undefined
    : createBackgroundTaskManager({
        onTaskFinished: async (task) => {
          await lifecycleEmitter.emit({
            command: task.command,
            exitCode: task.exitCode,
            kind: task.kind,
            round: lastRound,
            status: task.status,
            taskId: task.id,
            type: "background_task_finished",
          });
        },
      });
  const childSessions =
    !options.toolRuntime && options.childSessionRunner
      ? createAsyncChildSessionManager({ runner: options.childSessionRunner })
      : undefined;
  const primaryToolRuntime = options.toolRuntime ??
    createDefaultToolRuntime({
      backgroundTasks,
      ...(childSessions ? { childSessionRunner: childSessions } : {}),
      cronSchedules: options.cronSchedules,
      cwd: options.cwd,
      maxToolRounds,
      ...(options.teamTasks
        ? {
            teamTasks: {
              ...options.teamTasks,
              ...(childSessions ? { childSessions } : {}),
              gitIntegration: options.teamTasks.gitIntegration
                ?? createGitIntegrationService({ targetCwd: options.cwd }),
              ...(options.teammates ? { teammates: options.teammates } : {}),
            },
          }
        : {}),
      ...(options.teammates ? { teammates: options.teammates } : {}),
    });
  const toolRuntime = options.additionalToolRuntimes?.length
    ? composeToolRuntimes([primaryToolRuntime, ...options.additionalToolRuntimes])
    : primaryToolRuntime;
  const completionGate = createCompletionGate({
    ...(backgroundTasks ? { backgroundTasks } : {}),
    ...(childSessions ? { childSessions } : {}),
    cwd: options.cwd,
    ...(options.runtimeState
      ? {
          taskGraphState: () => options.runtimeState?.().taskGraph,
        }
      : {}),
    ...(options.teamTasks ? { taskStore: options.teamTasks.store } : {}),
    ...(options.teammates ? { teammates: options.teammates } : {}),
  });
  const contextProjection = options.contextProjection ?? createContextProjection();
  const contextCompaction =
    options.contextCompaction === false
      ? undefined
      : {
          ...DEFAULT_COMPACTION_OPTIONS,
          ...options.contextCompaction,
        };
  const promptAssets = options.promptAssets ?? (await loadRepoPromptAssets(options.cwd));
  const promptAssembly = assemblePrompt({
    assets: promptAssets,
    task: options.task,
  });
  const inputHistory = createInputHistoryManager({
    pinnedTask: {
      role: "user",
      content: promptAssembly.task,
    },
    recentRoundsToKeep: contextCompaction?.recentRoundsToKeep ?? DEFAULT_COMPACTION_OPTIONS.recentRoundsToKeep,
  });
  let closed = false;
  let running = false;
  let responseCreate: ResponseCreate;

  try {
    await lifecycleEmitter.emit({
      ...(options.baseCwd ? { baseCwd: options.baseCwd } : {}),
      cwd: options.cwd,
      maxToolRounds,
      model,
      task: options.task,
      type: "session_started",
      ...(options.workspace ? { workspace: options.workspace } : {}),
    });
    if (options.workspace && options.baseCwd) {
      await lifecycleEmitter.emit({
        baseBranch: options.workspace.baseBranch,
        baseCommit: options.workspace.baseCommit,
        baseCwd: options.baseCwd,
        branch: options.workspace.branch,
        type: "workspace_created",
        workspacePath: options.workspace.path,
      });
    }
    responseCreate = options.responseCreate ?? createOpenAIResponseCreate(apiKey, baseURL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await lifecycleEmitter.emit({
      message,
      type: "session_failed",
    });
    await finishSession(lifecycleEmitter, backgroundTasks, toolRuntime, lastRound, "failed");
    throw error;
  }

  return {
    async close(status) {
      if (closed) {
        return;
      }
      closed = true;
      await finishSession(lifecycleEmitter, backgroundTasks, toolRuntime, lastRound, status);
    },
    async runTurn(input, turnOptions) {
      if (closed) {
        throw new Error("Minimal loop session is closed.");
      }
      if (running) {
        throw new Error("Minimal loop session is already running a turn.");
      }

      const turnMaxToolRounds = turnOptions?.maxToolRounds ?? maxToolRounds;
      if (!Number.isSafeInteger(turnMaxToolRounds) || turnMaxToolRounds < 1) {
        throw new Error("maxToolRounds must be a positive integer.");
      }

      if (input !== undefined) {
        const normalizedInput = input.trim();
        if (normalizedInput.length === 0) {
          throw new Error("Minimal loop turn input must not be empty.");
        }
        inputHistory.appendRoundItems(lastRound + 1, [{
          role: "user",
          content: normalizedInput,
        }]);
      }

      let recoveryAttempts = 0;
      running = true;

      try {
        for (let turnRound = 1; turnRound <= turnMaxToolRounds; turnRound += 1) {
          const round = lastRound + 1;
          lastRound = round;
          options.transcript?.roundStart(round, model);
          const toolDefinitions = toolRuntime.toolDefinitions();
          await appendBackgroundTaskNotifications({
            backgroundTasks,
            inputHistory,
            lifecycleEmitter,
            round,
            running: false,
          });
          await appendChildSessionNotifications({
            childSessions,
            inputHistory,
            lifecycleEmitter,
            round,
            running: false,
          });
          await appendTeammateMessages({
            inputHistory,
            messages: options.teammates
              ? await options.teammates.drainLeaderMessages()
              : [],
            round,
          });
          await maybeAutoCompactInputHistory({
            contextCompaction,
            inputHistory,
            lifecycleEmitter,
            model,
            options,
            responseCreate,
            round,
            task: promptAssembly.task,
          });
          const input = inputHistory.modelInput() as ResponseInputItem[];

          options.transcript?.promptAssembly?.(round, promptAssembly.summary);
          await lifecycleEmitter.emit({
            catalogSkillIds: promptAssembly.summary.catalogSkillIds,
            instructionCharCount: promptAssembly.summary.instructionCharCount,
            round,
            sectionNames: promptAssembly.summary.sectionNames,
            selectedSkillIds: promptAssembly.summary.selectedSkillIds,
            type: "prompt_assembled",
          });
          await lifecycleEmitter.emit({
            inputItemCount: input.length,
            model,
            round,
            toolNames: toolDefinitions.map((tool) => tool.name),
            type: "model_request",
          });

          const response = await responseCreate({
            include: ["reasoning.encrypted_content"],
            input,
            instructions: promptAssembly.instructions,
            model,
            parallel_tool_calls: false,
            reasoning: {
              effort: "low",
            },
            store: false,
            text: {
              verbosity: "low",
            },
            tools: toolDefinitions,
          });

          inputHistory.appendRoundItems(round, response.output as CompactableInputItem[]);

          const toolCalls = response.output.filter(isFunctionToolCall);

          await lifecycleEmitter.emit({
            functionCallCount: toolCalls.length,
            outputText: response.output_text,
            round,
            ...(response.telemetry ? { telemetry: response.telemetry } : {}),
            type: "model_response",
          });

          if (toolCalls.length === 0) {
            const candidateAnswer = response.output_text.trim();
            const backgroundGateInjected = await appendBackgroundTaskNotifications({
              backgroundTasks,
              inputHistory,
              lifecycleEmitter,
              round,
              running: true,
            });
            const childGateInjected = await appendChildSessionNotifications({
              childSessions,
              inputHistory,
              lifecycleEmitter,
              round,
              running: true,
            });
            const teammateGateMessages = options.teammates
              ? await options.teammates.settleBeforeFinal()
              : [];
            const teammateGateInjected = await appendTeammateMessages({
              inputHistory,
              messages: teammateGateMessages,
              round,
            });

            if (backgroundGateInjected + childGateInjected + teammateGateInjected > 0) {
              await maybeReactiveCompactInputHistory({
                contextCompaction,
                inputHistory,
                lifecycleEmitter,
                model,
                options,
                responseCreate,
                round,
                task: promptAssembly.task,
              });
              continue;
            }

            const completion = await completionGate.evaluate();
            if (completion.status === "incomplete") {
              inputHistory.appendRoundItems(round, [{
                role: "user",
                content: formatCompletionBlockers(completion.blockers),
              }]);
              await maybeReactiveCompactInputHistory({
                contextCompaction,
                inputHistory,
                lifecycleEmitter,
                model,
                options,
                responseCreate,
                round,
                task: promptAssembly.task,
              });
              continue;
            }
            if (completion.status === "failed") {
              await lifecycleEmitter.emit({
                problems: completion.problems.map((problem) => ({ ...problem })),
                type: "completion_gate_failed",
              });
              throw new Error(
                `Completion gate failed: ${JSON.stringify(completion.problems)}`,
              );
            }

            if (!options.verifier) {
              options.transcript?.finalAnswer(candidateAnswer);
              await lifecycleEmitter.emit({
                answer: candidateAnswer,
                round,
                type: "final_answer",
              });
              return { finalAnswer: candidateAnswer, rounds: turnRound };
            }

            await lifecycleEmitter.emit({
              answer: candidateAnswer,
              round,
              type: "candidate_answer",
            });

            const verification = await options.verifier.verify({
              candidateAnswer,
              cwd: options.cwd,
              round,
              task: options.task,
            });
            options.transcript?.verificationResult?.(round, verification);
            await recordVerificationResult(lifecycleEmitter, round, verification);

            if (verification.status === "passed") {
              options.transcript?.finalAnswer(candidateAnswer);
              await lifecycleEmitter.emit({
                answer: candidateAnswer,
                round,
                type: "final_answer",
              });
              return { finalAnswer: candidateAnswer, rounds: turnRound };
            }

            if (!verification.recoverable) {
              throw new Error(`Verification ${verification.status}.`);
            }

            if (recoveryAttempts >= maxRecoveryAttempts) {
              throw new Error(formatRecoveryLimitError(maxRecoveryAttempts));
            }

            recoveryAttempts += 1;
            await lifecycleEmitter.emit({
              attempt: recoveryAttempts,
              maxAttempts: maxRecoveryAttempts,
              round,
              summary: verification.summary,
              type: "recovery_attempt",
            });
            options.transcript?.recoveryAttempt?.(round, recoveryAttempts, maxRecoveryAttempts, verification.summary);
            inputHistory.appendRoundItems(round, [{
              role: "user",
              content: formatRecoveryUserMessage(verification),
            }]);
            await maybeReactiveCompactInputHistory({
              contextCompaction,
              inputHistory,
              lifecycleEmitter,
              model,
              options,
              responseCreate,
              round,
              task: promptAssembly.task,
            });
            continue;
          }

          for (const toolCall of toolCalls) {
            const resultText = await executeToolCall(
              toolCall,
              toolRuntime,
              permissionPolicy,
              approver,
              contextProjection,
              round,
              options.transcript,
              lifecycleEmitter,
            );
            inputHistory.appendRoundItems(round, [{
              type: "function_call_output",
              call_id: toolCall.call_id,
              output: resultText,
            }]);
            await maybeReactiveCompactInputHistory({
              contextCompaction,
              inputHistory,
              lifecycleEmitter,
              model,
              options,
              responseCreate,
              round,
              task: promptAssembly.task,
            });
          }

          reportRoundState(options, round);
        }

        throw new Error(`Minimal loop stopped after ${turnMaxToolRounds} tool rounds without a final answer.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await lifecycleEmitter.emit({
          message,
          type: "session_failed",
        });
        if (!closed) {
          closed = true;
          await finishSession(lifecycleEmitter, backgroundTasks, toolRuntime, lastRound, "failed");
        }
        throw error;
      } finally {
        running = false;
      }
    },
  };
}

async function appendTeammateMessages(options: {
  inputHistory: ReturnType<typeof createInputHistoryManager>;
  messages: TeamMessage[];
  round: number;
}): Promise<number> {
  for (const message of options.messages) {
    options.inputHistory.appendRoundItems(options.round, [{
      role: "user",
      content: [
        "<team_mailbox_message>",
        `id: ${message.id}`,
        `from: ${message.from}`,
        `kind: ${message.kind}`,
        "content:",
        message.content,
        ...(message.sessionId ? [`session_id: ${message.sessionId}`] : []),
        ...(message.workspace
          ? [
              `workspace_path: ${message.workspace.path}`,
              `workspace_branch: ${message.workspace.branch}`,
            ]
          : []),
        ...(message.changedFiles
          ? [
              "changed_files:",
              ...(message.changedFiles.length > 0
                ? message.changedFiles.map((file) => `- ${file}`)
                : ["(none)"]),
            ]
          : []),
        "</team_mailbox_message>",
      ].join("\n"),
    }]);
  }
  return options.messages.length;
}

interface MaybeCompactOptions {
  contextCompaction: ContextCompactionOptions | undefined;
  inputHistory: ReturnType<typeof createInputHistoryManager>;
  lifecycleEmitter: LifecycleEmitter;
  model: string;
  options: MinimalLoopOptions;
  responseCreate: ResponseCreate;
  round: number;
  task: string;
}

async function maybeAutoCompactInputHistory(options: MaybeCompactOptions): Promise<void> {
  if (!options.contextCompaction) {
    return;
  }

  const beforeCharCount = estimateInputCharCount(options.inputHistory.modelInput());

  if (beforeCharCount <= options.contextCompaction.softCharBudget) {
    return;
  }

  if (options.inputHistory.compactableHistory().length === 0) {
    return;
  }

  await compactInputHistory({
    ...options,
    beforeCharCount,
    reason: `input chars ${beforeCharCount} exceeded soft budget ${options.contextCompaction.softCharBudget}`,
    trigger: "auto",
  });
}

async function maybeReactiveCompactInputHistory(options: MaybeCompactOptions): Promise<void> {
  if (!options.contextCompaction) {
    return;
  }

  const beforeCharCount = estimateInputCharCount(options.inputHistory.modelInput());

  if (beforeCharCount <= options.contextCompaction.hardCharBudget) {
    return;
  }

  if (options.inputHistory.compactableHistory().length === 0) {
    await recordCompactionFailure({
      afterCharCount: beforeCharCount,
      beforeCharCount,
      hardCharBudget: options.contextCompaction.hardCharBudget,
      lifecycleEmitter: options.lifecycleEmitter,
      reason: `input chars ${beforeCharCount} exceeded hard budget ${options.contextCompaction.hardCharBudget}, but no older history was compactable`,
      round: options.round,
      trigger: "reactive",
    });
    throw new Error("Context compaction failed: no older history was compactable.");
  }

  const compacted = await compactInputHistory({
    ...options,
    beforeCharCount,
    reason: `input chars ${beforeCharCount} exceeded hard budget ${options.contextCompaction.hardCharBudget} after appending new context`,
    trigger: "reactive",
  });

  if (compacted.afterCharCount > options.contextCompaction.hardCharBudget) {
    await recordCompactionFailure({
      afterCharCount: compacted.afterCharCount,
      beforeCharCount,
      hardCharBudget: options.contextCompaction.hardCharBudget,
      lifecycleEmitter: options.lifecycleEmitter,
      reason: `reactive compaction still exceeded hard budget ${options.contextCompaction.hardCharBudget}`,
      round: options.round,
      trigger: "reactive",
    });
    throw new Error("Context compaction failed: reactive compaction still exceeded hard budget.");
  }
}

interface CompactInputHistoryOptions extends MaybeCompactOptions {
  beforeCharCount: number;
  reason: string;
  trigger: ContextCompactionTrigger;
}

async function compactInputHistory(
  options: CompactInputHistoryOptions,
): Promise<{ afterCharCount: number }> {
  if (!options.contextCompaction) {
    return {
      afterCharCount: options.beforeCharCount,
    };
  }

  const source = buildCompactionSource({
    history: options.inputHistory.compactableHistory(),
    recentHistory: options.inputHistory.recentHistory(),
    sourceItemCharLimit: options.contextCompaction.sourceItemCharLimit,
    state: options.options.runtimeState?.(),
    task: options.task,
  });
  const response = await options.responseCreate({
    include: ["reasoning.encrypted_content"],
    input: [
      {
        role: "user",
        content: source.text,
      },
    ],
    instructions: COMPACTION_INSTRUCTIONS,
    model: options.model,
    parallel_tool_calls: false,
    reasoning: {
      effort: "low",
    },
    store: false,
    text: {
      verbosity: "low",
    },
    tools: [],
  });
  const inspection = inspectCompactionSummary(response.output_text);

  if (inspection.status === "invalid") {
    await recordCompactionFailure({
      beforeCharCount: options.beforeCharCount,
      hardCharBudget: options.contextCompaction.hardCharBudget,
      lifecycleEmitter: options.lifecycleEmitter,
      reason: inspection.reason,
      round: options.round,
      trigger: options.trigger,
    });
    throw new Error(`Context compaction failed: ${inspection.reason}.`);
  }

  const applyResult = options.inputHistory.applyCompaction({
    missingHeadings: inspection.missingHeadings,
    sourceRoundCount: source.sourceRoundCount,
    summary: inspection.summary,
    trigger: options.trigger,
  });
  const afterCharCount = estimateInputCharCount(options.inputHistory.modelInput());
  const event = {
    afterCharCount,
    beforeCharCount: options.beforeCharCount,
    compactedRoundCount: applyResult.compactedRoundCount,
    keptRecentRoundCount: applyResult.keptRecentRoundCount,
    missingHeadings: inspection.missingHeadings,
    omittedSourceCharCount: source.omittedCharCount,
    reason: options.reason,
    round: options.round,
    sourceItemCount: source.sourceItemCount,
    sourceRoundCount: source.sourceRoundCount,
    summary: inspection.summary,
    summaryCharCount: inspection.summary.length,
    ...(response.telemetry ? { telemetry: response.telemetry } : {}),
    trigger: options.trigger,
    type: "context_compacted" as const,
  };

  await options.lifecycleEmitter.emit(event);
  options.options.transcript?.contextCompaction?.({
    afterCharCount: event.afterCharCount,
    beforeCharCount: event.beforeCharCount,
    compactedRoundCount: event.compactedRoundCount,
    keptRecentRoundCount: event.keptRecentRoundCount,
    missingHeadings: event.missingHeadings,
    reason: event.reason,
    round: event.round,
    sourceItemCount: event.sourceItemCount,
    sourceRoundCount: event.sourceRoundCount,
    summaryCharCount: event.summaryCharCount,
    trigger: event.trigger,
  });

  return {
    afterCharCount,
  };
}

interface RecordCompactionFailureOptions {
  afterCharCount?: number;
  beforeCharCount: number;
  hardCharBudget: number;
  lifecycleEmitter: LifecycleEmitter;
  reason: string;
  round: number;
  trigger: ContextCompactionTrigger;
}

async function recordCompactionFailure(options: RecordCompactionFailureOptions): Promise<void> {
  await options.lifecycleEmitter.emit({
    ...(options.afterCharCount !== undefined ? { afterCharCount: options.afterCharCount } : {}),
    beforeCharCount: options.beforeCharCount,
    hardCharBudget: options.hardCharBudget,
    reason: options.reason,
    round: options.round,
    trigger: options.trigger,
    type: "context_compaction_failed",
  });
}

async function recordVerificationResult(
  lifecycleEmitter: LifecycleEmitter,
  round: number,
  result: VerificationResult,
): Promise<void> {
  await lifecycleEmitter.emit({
    ...(result.command !== undefined ? { command: result.command } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    name: result.name,
    round,
    status: result.status,
    summary: result.summary,
    type: "verification_result",
  });
}

function formatRecoveryUserMessage(result: VerificationResult): string {
  return [
    "Verification failed for the previous candidate answer.",
    "",
    result.summary,
    "",
    "Continue fixing the task. Use tools if needed, then provide a new final answer.",
  ].join("\n");
}

function formatRecoveryLimitError(maxRecoveryAttempts: number): string {
  const suffix = maxRecoveryAttempts === 1 ? "attempt" : "attempts";
  return `Verification failed after ${maxRecoveryAttempts} recovery ${suffix}.`;
}

function reportRoundState(options: MinimalLoopOptions, round: number): void {
  const runtimeState = options.runtimeState?.();
  if (runtimeState) {
    options.transcript?.roundState?.(round, runtimeState);
  }
}

function reportFinalState(options: MinimalLoopOptions): void {
  const runtimeState = options.runtimeState?.();
  if (runtimeState) {
    options.transcript?.finalState?.(runtimeState);
  }
}

interface AppendBackgroundTaskNotificationsOptions {
  backgroundTasks: BackgroundTaskManager | undefined;
  inputHistory: ReturnType<typeof createInputHistoryManager>;
  lifecycleEmitter: LifecycleEmitter;
  round: number;
  running: boolean;
}

async function appendBackgroundTaskNotifications(
  options: AppendBackgroundTaskNotificationsOptions,
): Promise<number> {
  if (!options.backgroundTasks) {
    return 0;
  }

  const notifications = options.running
    ? await options.backgroundTasks.settleBeforeFinal()
    : options.backgroundTasks.drainNotifications();

  for (const notification of notifications) {
    options.inputHistory.appendRoundItems(options.round, [
      {
        role: "user",
        content: formatBackgroundTaskNotification(notification),
      } as CompactableInputItem,
    ]);
    await recordBackgroundTaskNotification(options.lifecycleEmitter, options.round, notification);
  }

  return notifications.length;
}

async function recordBackgroundTaskNotification(
  lifecycleEmitter: LifecycleEmitter,
  round: number,
  notification: BackgroundTaskNotification,
): Promise<void> {
  await lifecycleEmitter.emit({
    command: notification.command,
    kind: notification.kind,
    round,
    status: notification.status,
    taskId: notification.id,
    type: "background_task_notification",
  });
}

interface AppendChildSessionNotificationsOptions {
  childSessions: AsyncChildSessionManager | undefined;
  inputHistory: ReturnType<typeof createInputHistoryManager>;
  lifecycleEmitter: LifecycleEmitter;
  round: number;
  running: boolean;
}

async function appendChildSessionNotifications(
  options: AppendChildSessionNotificationsOptions,
): Promise<number> {
  if (!options.childSessions) {
    return 0;
  }

  const notifications = options.running
    ? await options.childSessions.settleBeforeFinal()
    : options.childSessions.drainNotifications();

  for (const notification of notifications) {
    options.inputHistory.appendRoundItems(options.round, [
      {
        role: "user",
        content: formatChildSessionNotification(notification),
      } as CompactableInputItem,
    ]);
    await recordChildSessionNotification(options.lifecycleEmitter, options.round, notification);
  }

  return notifications.length;
}

async function recordChildSessionNotification(
  lifecycleEmitter: LifecycleEmitter,
  round: number,
  notification: AsyncChildSessionNotification,
): Promise<void> {
  await lifecycleEmitter.emit({
    childSessionId: notification.childSessionId,
    profile: notification.profile,
    round,
    status: notification.status,
    tracePath: notification.tracePath,
    type: "child_session_notification",
  });
}

async function finishSession(
  lifecycleEmitter: LifecycleEmitter,
  backgroundTasks: BackgroundTaskManager | undefined,
  toolRuntime: ToolRuntime,
  rounds: number,
  status: SessionEndStatus,
): Promise<void> {
  await cleanupBackgroundTasks(backgroundTasks);
  await toolRuntime.close?.();
  await lifecycleEmitter.emit({
    rounds,
    status,
    type: "session_ended",
  });
}

async function cleanupBackgroundTasks(backgroundTasks: BackgroundTaskManager | undefined): Promise<void> {
  if (!backgroundTasks) {
    return;
  }

  await backgroundTasks.flushEvents();
  await backgroundTasks.cancelRunning();
  await backgroundTasks.flushEvents();
}

export function createOpenAIResponseCreate(apiKey: string | undefined, baseURL: string | undefined): ResponseCreate {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    maxRetries: DEFAULT_MODEL_REQUEST_MAX_RETRIES,
    timeout: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  });

  return async (request) => {
    const startedAt = performance.now();
    const response: OpenAIResponse = await client.responses.create(
      request as unknown as ResponseCreateParamsNonStreaming,
    );
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const usage: ModelUsage | undefined = response.usage
      ? {
          ...(response.usage.input_tokens_details?.cached_tokens !== undefined
            ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens }
            : {}),
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          ...(response.usage.output_tokens_details?.reasoning_tokens !== undefined
            ? { reasoningTokens: response.usage.output_tokens_details.reasoning_tokens }
            : {}),
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    return {
      output: response.output as unknown as ResponseOutputItem[],
      output_text: response.output_text,
      telemetry: {
        durationMs,
        ...(usage ? { usage } : {}),
      },
    };
  };
}

function isFunctionToolCall(item: ResponseOutputItem): item is ResponseFunctionToolCall {
  return item.type === "function_call";
}

async function executeToolCall(
  toolCall: ResponseFunctionToolCall,
  toolRuntime: ToolRuntime,
  permissionPolicy: PermissionPolicy,
  approver: PermissionApprover,
  contextProjection: ContextProjection,
  round: number,
  transcript: MinimalLoopTranscript | undefined,
  lifecycleEmitter: LifecycleEmitter,
): Promise<string> {
  transcript?.toolCall(round, toolCall.name, toolCall.arguments);
  await lifecycleEmitter.emit({
    argumentsText: toolCall.arguments,
    callId: toolCall.call_id,
    round,
    toolName: toolCall.name,
    type: "tool_call",
  });

  const request: ToolCallRequest = {
    arguments: toolCall.arguments,
    name: toolCall.name,
  };
  const decision = permissionPolicy.decide(request);
  transcript?.permissionDecision?.(round, decision);
  await lifecycleEmitter.emit({
    action: decision.action,
    callId: toolCall.call_id,
    reason: decision.reason,
    risk: decision.risk,
    round,
    toolName: toolCall.name,
    type: "permission_decision",
  });

  if (decision.action === "deny") {
    const result = createPermissionBlockedResult(request, decision);
    const resultText = projectToolResult(result, contextProjection);
    transcript?.toolResult(round, resultText);
    await lifecycleEmitter.emit({
      callId: toolCall.call_id,
      projectedOutput: resultText,
      round,
      status: result.status,
      toolName: toolCall.name,
      type: "tool_result",
    });
    return resultText;
  }

  if (decision.action === "ask") {
    const approval = await approver.approve({ decision, toolCall: request });
    const approvalEvent = {
      approved: approval.approved,
      callId: toolCall.call_id,
      round,
      toolName: toolCall.name,
      type: "approval_result" as const,
      ...(approval.reason ? { reason: approval.reason } : {}),
    };
    await lifecycleEmitter.emit(approvalEvent);

    if (!approval.approved) {
      const result = createPermissionBlockedResult(request, decision, approval);
      const resultText = projectToolResult(result, contextProjection);
      transcript?.toolResult(round, resultText);
      await lifecycleEmitter.emit({
        callId: toolCall.call_id,
        projectedOutput: resultText,
        round,
        status: result.status,
        toolName: toolCall.name,
        type: "tool_result",
      });
      return resultText;
    }
  }

  const result = await toolRuntime.execute(request, { callId: toolCall.call_id, round });
  const resultText = projectToolResult(result, contextProjection);
  const taskGraph = readTaskGraphTraceProjection(result);
  transcript?.toolResult(round, resultText);
  await lifecycleEmitter.emit({
    callId: toolCall.call_id,
    projectedOutput: resultText,
    round,
    status: result.status,
    ...(taskGraph ? { taskGraph } : {}),
    toolName: toolCall.name,
    type: "tool_result",
  });
  await recordTaskGraphMutationFromToolResult(lifecycleEmitter, result);
  await recordTaskStateUpdateFromToolResult(lifecycleEmitter, round, toolCall.call_id, result);
  await recordBackgroundTaskStartedFromToolResult(lifecycleEmitter, round, result);
  await recordCronScheduleEventFromToolResult(lifecycleEmitter, round, result);
  return resultText;
}

async function recordTaskGraphMutationFromToolResult(
  lifecycleEmitter: LifecycleEmitter,
  result: ToolResult,
): Promise<void> {
  if (result.status !== "completed") {
    return;
  }

  const mutation = readTaskGraphMutation(result.metadata?.taskGraphMutation);
  if (!mutation) {
    return;
  }

  await lifecycleEmitter.emit({
    ...(mutation.nextStatus ? { nextStatus: mutation.nextStatus } : {}),
    operation: mutation.operation,
    ...(mutation.previousStatus ? { previousStatus: mutation.previousStatus } : {}),
    revision: mutation.revision,
    taskId: mutation.taskId,
    type: "task_graph_mutated",
  });
}

function readTaskGraphTraceProjection(result: ToolResult): TraceTaskGraphProjection | undefined {
  if (!TEAM_TASK_TOOL_NAMES.has(result.toolName) || !isRecord(result.metadata)) {
    return undefined;
  }

  const revision = readRevision(result.metadata.revision);
  const graphHealth = readGraphHealth(result.metadata.graphHealth);
  if (result.status === "completed" && revision !== undefined) {
    const warningCode = readFailureCode(result.metadata.warningCode);
    const warningReason = readNonEmptyString(result.metadata.warningReason);
    return {
      ...(warningCode && warningReason
        ? {
            error: {
              code: warningCode,
              message: warningReason,
            },
          }
        : {}),
      health: graphHealth ?? "healthy",
      revision,
    };
  }

  const reasonCode = readFailureCode(result.metadata.reasonCode);
  const reason = readNonEmptyString(result.metadata.observationSummary);
  if (!graphHealth || !reasonCode || !reason) {
    return undefined;
  }

  return {
    error: {
      code: reasonCode,
      message: reason,
    },
    health: graphHealth,
  };
}

function readTaskGraphMutation(value: unknown): {
  nextStatus?: TeamTaskStatus;
  operation: TeamTaskMutationOperation;
  previousStatus?: TeamTaskStatus;
  revision: number;
  taskId: string;
} | undefined {
  if (
    !isRecord(value) ||
    !isMutationOperation(value.operation) ||
    typeof value.taskId !== "string" ||
    value.taskId.length === 0
  ) {
    return undefined;
  }

  const revision = readRevision(value.revision);
  if (revision === undefined) {
    return undefined;
  }
  if (value.previousStatus !== undefined && !isTeamTaskStatus(value.previousStatus)) {
    return undefined;
  }
  if (value.nextStatus !== undefined && !isTeamTaskStatus(value.nextStatus)) {
    return undefined;
  }

  return {
    ...(value.nextStatus ? { nextStatus: value.nextStatus } : {}),
    operation: value.operation,
    ...(value.previousStatus ? { previousStatus: value.previousStatus } : {}),
    revision,
    taskId: value.taskId,
  };
}

const TEAM_TASK_TOOL_NAMES = new Set([
  "task_add_evidence",
  "task_create",
  "task_get",
  "task_integrate",
  "task_list",
  "task_transition",
  "task_update",
  "task_verify",
]);

const TEAM_TASK_FAILURE_CODES = new Set([
  "capacity_exceeded",
  "child_source_invalid",
  "cherry_pick_in_progress",
  "contract_frozen",
  "delegated_task_mismatch",
  "delete_not_allowed",
  "dependencies_incomplete",
  "dirty_target",
  "evidence_not_allowed",
  "evidence_required",
  "fingerprint_mismatch",
  "git_identity_missing",
  "graph_invalid",
  "graph_malformed",
  "graph_missing",
  "handoff_required",
  "integration_conflict",
  "invalid_actor",
  "invalid_input",
  "invalid_transition",
  "owner_mismatch",
  "plan_not_approved",
  "source_drift",
  "stale_approval",
  "task_store_busy",
  "permission_denied",
  "schema_unsupported",
  "store_io",
  "task_frozen",
  "task_not_found",
  "task_not_ready",
  "transfer_exhausted",
  "verification_failed",
]);

function isMutationOperation(value: unknown): value is TeamTaskMutationOperation {
  return value === "create" ||
    value === "update" ||
    value === "add_evidence" ||
    value === "delete" ||
    value === "transition" ||
    value === "verify" ||
    value === "integrate";
}

function isTeamTaskStatus(value: unknown): value is TeamTaskStatus {
  return value === "pending" ||
    value === "in_progress" ||
    value === "submitted" ||
    value === "blocked" ||
    value === "completed";
}

function readFailureCode(value: unknown): TeamTaskFailureCode | undefined {
  return typeof value === "string" && TEAM_TASK_FAILURE_CODES.has(value)
    ? value as TeamTaskFailureCode
    : undefined;
}

function readGraphHealth(value: unknown): "healthy" | "degraded" | undefined {
  return value === "healthy" || value === "degraded" ? value : undefined;
}

function readRevision(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectToolResult(result: ToolResult, contextProjection: ContextProjection): string {
  return contextProjection.projectObservation(createToolObservation(result));
}

async function recordTaskStateUpdateFromToolResult(
  lifecycleEmitter: LifecycleEmitter,
  round: number,
  callId: string,
  result: ToolResult,
): Promise<void> {
  const taskState = result.metadata?.taskState;

  if (result.status !== "completed" || result.toolName !== "todo" || !isTaskState(taskState)) {
    return;
  }

  await lifecycleEmitter.emit({
    callId,
    round,
    taskState,
    type: "task_state_updated",
  });
}

async function recordBackgroundTaskStartedFromToolResult(
  lifecycleEmitter: LifecycleEmitter,
  round: number,
  result: ToolResult,
): Promise<void> {
  if (result.status !== "completed" || result.toolName !== "bash") {
    return;
  }

  const task = readBackgroundTaskMetadata(result.metadata?.backgroundTask);

  if (!task) {
    return;
  }

  await lifecycleEmitter.emit({
    command: task.command,
    kind: task.kind,
    round,
    taskId: task.id,
    type: "background_task_started",
  });
}

interface BackgroundTaskMetadata {
  command: string;
  id: string;
  kind: BackgroundTaskKind;
}

function readBackgroundTaskMetadata(value: unknown): BackgroundTaskMetadata | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("command" in value) ||
    typeof value.command !== "string" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("kind" in value) ||
    value.kind !== "bash"
  ) {
    return undefined;
  }

  return {
    command: value.command,
    id: value.id,
    kind: value.kind,
  };
}

async function recordCronScheduleEventFromToolResult(
  lifecycleEmitter: LifecycleEmitter,
  round: number,
  result: ToolResult,
): Promise<void> {
  if (result.status !== "completed") {
    return;
  }

  const schedule = readCronScheduleMetadata(result.metadata?.cronSchedule);

  if (!schedule) {
    return;
  }

  if (result.toolName === "schedule_cron") {
    await lifecycleEmitter.emit({
      cron: schedule.cron,
      cronId: schedule.id,
      recurring: schedule.recurring,
      round,
      title: schedule.title,
      type: "cron_scheduled",
    });
    return;
  }

  if (result.toolName === "cancel_cron") {
    await lifecycleEmitter.emit({
      cronId: schedule.id,
      round,
      status: schedule.status,
      title: schedule.title,
      type: "cron_canceled",
    });
  }
}

function readCronScheduleMetadata(value: unknown): CronSchedule | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("cron" in value) ||
    typeof value.cron !== "string" ||
    !("prompt" in value) ||
    typeof value.prompt !== "string" ||
    !("recurring" in value) ||
    typeof value.recurring !== "boolean" ||
    !("status" in value) ||
    typeof value.status !== "string"
  ) {
    return undefined;
  }

  return value as CronSchedule;
}

function createPermissionBlockedResult(
  toolCall: ToolCallRequest,
  decision: PermissionDecision,
  approval?: ApprovalResult,
): ToolResult {
  const reason = approval?.reason ?? decision.reason;
  const lines = [
    "permission_denied: true",
    `decision: ${decision.action}`,
    `risk: ${decision.risk}`,
    `reason: ${reason}`,
  ];

  if (approval?.reason && approval.reason !== decision.reason) {
    lines.push(`policy_reason: ${decision.reason}`);
  }

  return {
    content: lines.join("\n"),
    metadata: {
      permissionDecision: decision,
      rejectionReason: approval?.reason,
    },
    status: "blocked",
    toolName: toolCall.name,
  };
}

function createRejectingApprover(): PermissionApprover {
  return {
    async approve() {
      return {
        approved: false,
        reason: "approval requires an approver",
      };
    },
  };
}

function normalizeBaseURL(baseURL: string | undefined): string | undefined {
  const normalized = baseURL?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
