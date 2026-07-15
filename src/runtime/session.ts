import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createJsonlTraceRecorder } from "./traceRecorder.js";
import type { TraceRecorder } from "./trace.js";

export interface SessionWorkspaceMetadata {
  baseBranch: string;
  baseCommit: string;
  branch: string;
  mode: "git_worktree";
  path: string;
}

export type ChildSessionProfile = "research" | "edit";

export interface ChildSessionMetadata {
  parentCallId: string;
  parentSessionId: string;
  profile: ChildSessionProfile;
  role: "child";
}

export interface SessionMetadata {
  baseCwd?: string;
  child?: ChildSessionMetadata;
  cwd: string;
  id: string;
  maxToolRounds: number;
  model: string;
  startedAt: string;
  task: string;
  tracePath: string;
  workspace?: SessionWorkspaceMetadata;
}

export interface SessionPaths {
  sessionDir: string;
  sessionMetadataPath: string;
  tracePath: string;
}

export interface CreateSessionMetadataInput {
  baseCwd?: string;
  child?: ChildSessionMetadata;
  cwd: string;
  id: string;
  maxToolRounds: number;
  model: string;
  startedAt: string;
  task: string;
  tracePath: string;
  workspace?: SessionWorkspaceMetadata;
}

export interface CreateCliSessionTraceOptions {
  baseCwd?: string;
  child?: ChildSessionMetadata;
  cwd: string;
  maxToolRounds: number;
  model: string;
  now?: () => Date;
  randomSuffix?: () => string;
  task: string;
  workspace?: SessionWorkspaceMetadata;
}

export interface CliSessionTrace {
  metadata: SessionMetadata;
  paths: SessionPaths;
  recorder: TraceRecorder;
}

export function createSessionId(now = new Date(), randomSuffix = createRandomSuffix): string {
  return `${formatSessionDate(now)}-${randomSuffix()}`;
}

export function createSessionPaths(cwd: string, sessionId: string): SessionPaths {
  const sessionDir = path.join(cwd, ".forge", "sessions", sessionId);

  return {
    sessionDir,
    sessionMetadataPath: path.join(sessionDir, "session.json"),
    tracePath: path.join(sessionDir, "trace.jsonl"),
  };
}

export function createSessionMetadata(input: CreateSessionMetadataInput): SessionMetadata {
  return {
    ...(input.baseCwd ? { baseCwd: input.baseCwd } : {}),
    ...(input.child ? { child: input.child } : {}),
    cwd: input.cwd,
    id: input.id,
    maxToolRounds: input.maxToolRounds,
    model: input.model,
    startedAt: input.startedAt,
    task: input.task,
    tracePath: input.tracePath,
    ...(input.workspace ? { workspace: input.workspace } : {}),
  };
}

export async function createCliSessionTrace(options: CreateCliSessionTraceOptions): Promise<CliSessionTrace> {
  const now = options.now ?? (() => new Date());
  const startedAtDate = now();
  const sessionId = createSessionId(startedAtDate, options.randomSuffix ?? createRandomSuffix);
  const paths = createSessionPaths(options.baseCwd ?? options.cwd, sessionId);
  const metadata = createSessionMetadata({
    ...(options.baseCwd ? { baseCwd: options.baseCwd } : {}),
    ...(options.child ? { child: options.child } : {}),
    cwd: options.cwd,
    id: sessionId,
    maxToolRounds: options.maxToolRounds,
    model: options.model,
    startedAt: startedAtDate.toISOString(),
    task: options.task,
    tracePath: paths.tracePath,
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });

  await fs.mkdir(paths.sessionDir, { recursive: true });
  await fs.writeFile(paths.sessionMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await fs.writeFile(paths.tracePath, "", "utf8");

  return {
    metadata,
    paths,
    recorder: createJsonlTraceRecorder({
      now,
      sessionId,
      tracePath: paths.tracePath,
    }),
  };
}

export async function writeSessionMetadata(pathname: string, metadata: SessionMetadata): Promise<void> {
  await fs.writeFile(pathname, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function createRandomSuffix(): string {
  return crypto.randomBytes(4).toString("hex");
}

function formatSessionDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}
