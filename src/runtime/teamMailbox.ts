import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MAILBOX_SCHEMA_VERSION = 1;
export const TEAMMATE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_TEAMMATE_NAME_LENGTH = 32;

export type TeamMessageKind = "direct" | "broadcast" | "turn_result" | "failure_notice";
export type MailboxStoreErrorCode =
  | "cursor_malformed"
  | "invalid_address"
  | "invalid_message"
  | "mailbox_malformed"
  | "mailbox_missing"
  | "schema_unsupported"
  | "store_io";

export interface TeammateWorkspaceReference {
  branch: string;
  path: string;
}

export interface TeamMessage {
  changedFiles?: string[];
  content: string;
  createdAt: string;
  from: string;
  id: string;
  kind: TeamMessageKind;
  schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
  sequence: number;
  sessionId?: string;
  to: string;
  workspace?: TeammateWorkspaceReference;
}

export interface AppendTeamMessageInput {
  changedFiles?: string[];
  content: string;
  from: string;
  kind: TeamMessageKind;
  sessionId?: string;
  to: string;
  workspace?: TeammateWorkspaceReference;
}

export interface MailboxClaim {
  cursor: number;
  messages: TeamMessage[];
}

export interface MailboxInspection {
  cursor: number;
  nextSequence: number;
  unreadCount: number;
}

export interface MailboxStore {
  append(input: AppendTeamMessageInput): Promise<TeamMessage>;
  claimUnread(address: string): Promise<MailboxClaim>;
  initialize(address: string): Promise<void>;
  inspect(address: string): Promise<MailboxInspection>;
}

export interface FileMailboxStoreOptions {
  now?: () => Date;
  teamRoot: string;
}

interface MailboxCursorFile {
  lastClaimedSequence: number;
  schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
}

export class MailboxStoreError extends Error {
  readonly code: MailboxStoreErrorCode;

  constructor(code: MailboxStoreErrorCode, message: string) {
    super(message);
    this.name = "MailboxStoreError";
    this.code = code;
  }
}

export function createFileMailboxStore(options: FileMailboxStoreOptions): MailboxStore {
  const now = options.now ?? (() => new Date());
  const queues = new Map<string, Promise<void>>();

  const serialize = async <T>(address: string, action: () => Promise<T>): Promise<T> => {
    const previous = queues.get(address) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    queues.set(address, tail);

    await previous;
    try {
      return await action();
    } finally {
      release();
      if (queues.get(address) === tail) {
        queues.delete(address);
      }
    }
  };

  const mailboxPaths = (address: string) => {
    validateAddress(address);
    const root = path.join(options.teamRoot, "mailboxes", address);
    return {
      cursor: path.join(root, "cursor.json"),
      inbox: path.join(root, "inbox.jsonl"),
      root,
    };
  };

  const ensureInitialized = async (address: string): Promise<void> => {
    const paths = mailboxPaths(address);
    const rootExists = await fileExists(paths.root);

    if (rootExists) {
      const [cursorExists, inboxExists] = await Promise.all([
        fileExists(paths.cursor),
        fileExists(paths.inbox),
      ]);
      if (!cursorExists || !inboxExists) {
        throw new MailboxStoreError(
          "mailbox_missing",
          `mailbox "${address}" is missing ${cursorExists ? "inbox.jsonl" : "cursor.json"}`,
        );
      }
      return;
    }

    try {
      await fs.mkdir(paths.root, { recursive: true });
      await fs.writeFile(paths.inbox, "", { encoding: "utf8", flag: "wx" });
      await fs.writeFile(
        paths.cursor,
        `${JSON.stringify({
          lastClaimedSequence: 0,
          schemaVersion: MAILBOX_SCHEMA_VERSION,
        }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      throw storeIoError(`initialize mailbox "${address}"`, error);
    }
  };

  const readInbox = async (address: string): Promise<TeamMessage[]> => {
    const paths = mailboxPaths(address);
    let raw: string;
    try {
      raw = await fs.readFile(paths.inbox, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new MailboxStoreError("mailbox_missing", `mailbox "${address}" inbox is missing`);
      }
      throw storeIoError(`read mailbox "${address}" inbox`, error);
    }

    const rows = raw.length === 0
      ? []
      : raw.split("\n").filter((line) => line.length > 0);
    const messages = rows.map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new MailboxStoreError(
          "mailbox_malformed",
          `mailbox "${address}" row ${index + 1} contains malformed JSON: ${errorMessage(error)}`,
        );
      }
      return parsePersistedMessage(value, address, index + 1);
    });

    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.sequence !== index + 1) {
        throw new MailboxStoreError(
          "mailbox_malformed",
          `mailbox "${address}" sequences must be contiguous from 1`,
        );
      }
    }
    return messages;
  };

  const readCursor = async (address: string, maxSequence: number): Promise<MailboxCursorFile> => {
    const paths = mailboxPaths(address);
    let raw: string;
    try {
      raw = await fs.readFile(paths.cursor, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new MailboxStoreError("mailbox_missing", `mailbox "${address}" cursor is missing`);
      }
      throw storeIoError(`read mailbox "${address}" cursor`, error);
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new MailboxStoreError(
        "cursor_malformed",
        `mailbox "${address}" cursor contains malformed JSON: ${errorMessage(error)}`,
      );
    }
    if (!isRecord(value) || !hasExactKeys(value, ["lastClaimedSequence", "schemaVersion"])) {
      throw new MailboxStoreError(
        "cursor_malformed",
        `mailbox "${address}" cursor has invalid fields`,
      );
    }
    if (value.schemaVersion !== MAILBOX_SCHEMA_VERSION) {
      throw new MailboxStoreError(
        "schema_unsupported",
        `mailbox "${address}" has unsupported cursor schema ${String(value.schemaVersion)}`,
      );
    }
    if (
      !Number.isSafeInteger(value.lastClaimedSequence)
      || (value.lastClaimedSequence as number) < 0
      || (value.lastClaimedSequence as number) > maxSequence
    ) {
      throw new MailboxStoreError(
        "cursor_malformed",
        `mailbox "${address}" cursor is outside the persisted sequence range`,
      );
    }
    return {
      lastClaimedSequence: value.lastClaimedSequence as number,
      schemaVersion: MAILBOX_SCHEMA_VERSION,
    };
  };

  const writeCursor = async (address: string, cursor: MailboxCursorFile): Promise<void> => {
    const paths = mailboxPaths(address);
    const temporaryPath = path.join(
      paths.root,
      `.cursor.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(cursor, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await fs.rename(temporaryPath, paths.cursor);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw storeIoError(`advance mailbox "${address}" cursor`, error);
    }
  };

  return {
    async append(input) {
      validateAppendInput(input);
      return serialize(input.to, async () => {
        await ensureInitialized(input.to);
        const messages = await readInbox(input.to);
        const sequence = messages.length + 1;
        const message: TeamMessage = {
          content: input.content.trim(),
          createdAt: now().toISOString(),
          from: input.from,
          id: formatMessageId(input.to, sequence),
          kind: input.kind,
          schemaVersion: MAILBOX_SCHEMA_VERSION,
          sequence,
          ...(input.sessionId ? { sessionId: input.sessionId.trim() } : {}),
          to: input.to,
          ...(input.workspace
            ? {
                workspace: {
                  branch: input.workspace.branch.trim(),
                  path: input.workspace.path.trim(),
                },
              }
            : {}),
          ...(input.changedFiles
            ? { changedFiles: [...new Set(input.changedFiles.map((file) => file.trim()))].sort() }
            : {}),
        };
        const paths = mailboxPaths(input.to);
        try {
          await fs.appendFile(paths.inbox, `${JSON.stringify(message)}\n`, "utf8");
        } catch (error) {
          throw storeIoError(`append mailbox "${input.to}" message`, error);
        }
        return structuredClone(message);
      });
    },
    async claimUnread(address) {
      validateAddress(address);
      return serialize(address, async () => {
        await ensureInitialized(address);
        const messages = await readInbox(address);
        const cursor = await readCursor(address, messages.length);
        const snapshot = messages.slice(cursor.lastClaimedSequence);
        const nextCursor = snapshot.at(-1)?.sequence ?? cursor.lastClaimedSequence;
        if (nextCursor !== cursor.lastClaimedSequence) {
          await writeCursor(address, {
            lastClaimedSequence: nextCursor,
            schemaVersion: MAILBOX_SCHEMA_VERSION,
          });
        }
        return {
          cursor: nextCursor,
          messages: structuredClone(snapshot),
        };
      });
    },
    async initialize(address) {
      validateAddress(address);
      await serialize(address, () => ensureInitialized(address));
    },
    async inspect(address) {
      validateAddress(address);
      return serialize(address, async () => {
        await ensureInitialized(address);
        const messages = await readInbox(address);
        const cursor = await readCursor(address, messages.length);
        return {
          cursor: cursor.lastClaimedSequence,
          nextSequence: messages.length + 1,
          unreadCount: messages.length - cursor.lastClaimedSequence,
        };
      });
    },
  };
}

function validateAppendInput(input: AppendTeamMessageInput): void {
  if (!isRecord(input)) {
    throw new MailboxStoreError("invalid_message", "mailbox message must be an object");
  }
  validateAddress(input.from);
  validateAddress(input.to);
  if (
    input.kind !== "direct"
    && input.kind !== "broadcast"
    && input.kind !== "turn_result"
    && input.kind !== "failure_notice"
  ) {
    throw new MailboxStoreError("invalid_message", "mailbox message kind is invalid");
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new MailboxStoreError("invalid_message", "mailbox message content must not be empty");
  }

  if (input.kind === "direct" || input.kind === "broadcast") {
    if (input.sessionId !== undefined || input.workspace !== undefined || input.changedFiles !== undefined) {
      throw new MailboxStoreError(
        "invalid_message",
        `${input.kind} messages cannot contain teammate result fields`,
      );
    }
    return;
  }

  if (typeof input.sessionId !== "string" || input.sessionId.trim().length === 0) {
    throw new MailboxStoreError(
      "invalid_message",
      `${input.kind} messages require a sessionId`,
    );
  }
  if (input.kind === "failure_notice") {
    if (input.workspace !== undefined || input.changedFiles !== undefined) {
      throw new MailboxStoreError(
        "invalid_message",
        "failure notices cannot contain workspace result fields",
      );
    }
    return;
  }

  if (input.workspace !== undefined) {
    if (
      !isRecord(input.workspace)
      || !hasExactKeys(input.workspace, ["branch", "path"])
      || typeof input.workspace.branch !== "string"
      || input.workspace.branch.trim().length === 0
      || typeof input.workspace.path !== "string"
      || input.workspace.path.trim().length === 0
    ) {
      throw new MailboxStoreError("invalid_message", "turn result workspace is invalid");
    }
  }
  if (
    input.changedFiles !== undefined
    && (
      !Array.isArray(input.changedFiles)
      || input.changedFiles.some((file) => typeof file !== "string" || file.trim().length === 0)
    )
  ) {
    throw new MailboxStoreError("invalid_message", "turn result changedFiles is invalid");
  }
}

function parsePersistedMessage(value: unknown, address: string, row: number): TeamMessage {
  if (!isRecord(value)) {
    throw malformedMessage(address, row, "must be an object");
  }
  if (value.schemaVersion !== MAILBOX_SCHEMA_VERSION) {
    throw new MailboxStoreError(
      "schema_unsupported",
      `mailbox "${address}" row ${row} has unsupported schema ${String(value.schemaVersion)}`,
    );
  }
  const baseKeys = [
    "content",
    "createdAt",
    "from",
    "id",
    "kind",
    "schemaVersion",
    "sequence",
    "to",
  ];
  const optionalKeys = ["changedFiles", "sessionId", "workspace"];
  if (Object.keys(value).some((key) => !baseKeys.includes(key) && !optionalKeys.includes(key))) {
    throw malformedMessage(address, row, "contains unsupported fields");
  }
  if (
    typeof value.sequence !== "number"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || value.to !== address
    || value.id !== formatMessageId(address, value.sequence)
    || typeof value.createdAt !== "string"
  ) {
    throw malformedMessage(address, row, "has invalid identity fields");
  }

  try {
    validateAppendInput(value as unknown as AppendTeamMessageInput);
  } catch (error) {
    throw malformedMessage(address, row, errorMessage(error));
  }
  return structuredClone(value) as unknown as TeamMessage;
}

function validateAddress(address: string): void {
  if (
    typeof address !== "string"
    || address.length < 1
    || address.length > MAX_TEAMMATE_NAME_LENGTH
    || !TEAMMATE_NAME_PATTERN.test(address)
  ) {
    throw new MailboxStoreError(
      "invalid_address",
      `mailbox address must match ${TEAMMATE_NAME_PATTERN.source} and be 1..${MAX_TEAMMATE_NAME_LENGTH} characters`,
    );
  }
}

function formatMessageId(address: string, sequence: number): string {
  return `msg_${address}_${String(sequence).padStart(6, "0")}`;
}

function malformedMessage(address: string, row: number, reason: string): MailboxStoreError {
  return new MailboxStoreError(
    "mailbox_malformed",
    `mailbox "${address}" row ${row} ${reason}`,
  );
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw storeIoError(`inspect path "${pathname}"`, error);
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storeIoError(operation: string, error: unknown): MailboxStoreError {
  return new MailboxStoreError("store_io", `${operation} failed: ${errorMessage(error)}`);
}
