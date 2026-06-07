import type { ResponseInputItem } from "openai/resources/responses/responses";

const DEFAULT_PREVIEW_LENGTH = 120;
const UNSUPPORTED_PROVIDER_ITEM_PREVIEW = "[unsupported provider item]";

export interface HistorySnapshotOptions {
  previewLength?: number;
}

export function formatHistorySnapshot(
  input: readonly ResponseInputItem[],
  options: HistorySnapshotOptions = {},
): string {
  const previewLength = normalizePreviewLength(options.previewLength);

  if (input.length === 0) {
    return "(empty history)";
  }

  return input.map((item, index) => formatHistoryItem(item, index, previewLength)).join("\n");
}

function formatHistoryItem(item: ResponseInputItem, index: number, previewLength: number): string {
  const type = getStringProperty(item, "type") ?? inferType(item);
  const metadata = formatMetadata(item);
  const previewSource = getPreviewSource(item);
  const preview = truncatePreview(previewSource, previewLength);
  const parts = [`[${index}]`, `type=${type}`, ...metadata, `chars=${previewSource.length}`];

  return `${parts.join(" ")} preview=${JSON.stringify(preview)}`;
}

function formatMetadata(item: ResponseInputItem): string[] {
  const metadata: string[] = [];
  const role = getStringProperty(item, "role");
  const name = getStringProperty(item, "name");
  const callId = getStringProperty(item, "call_id");
  const status = getStringProperty(item, "status");

  if (role) {
    metadata.push(`role=${role}`);
  }

  if (name) {
    metadata.push(`name=${name}`);
  }

  if (callId) {
    metadata.push(`call_id=${callId}`);
  }

  if (status) {
    metadata.push(`status=${status}`);
  }

  return metadata;
}

function getPreviewSource(item: ResponseInputItem): string {
  if ("content" in item) {
    return stringifyContent(item.content);
  }

  if ("arguments" in item && typeof item.arguments === "string") {
    return item.arguments;
  }

  if ("output" in item && typeof item.output === "string") {
    return item.output;
  }

  return UNSUPPORTED_PROVIDER_ITEM_PREVIEW;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null) {
          const record = part as Record<string, unknown>;

          if (typeof record.text === "string") {
            return record.text;
          }
        }

        return JSON.stringify(part) ?? String(part);
      })
      .join("\n");
  }

  return JSON.stringify(content) ?? String(content);
}

function truncatePreview(value: string, previewLength: number): string {
  if (value.length <= previewLength) {
    return value;
  }

  return `${value.slice(0, previewLength)}...`;
}

function normalizePreviewLength(previewLength: number | undefined): number {
  if (previewLength === undefined || !Number.isFinite(previewLength) || previewLength < 0) {
    return DEFAULT_PREVIEW_LENGTH;
  }

  return Math.floor(previewLength);
}

function inferType(item: ResponseInputItem): string {
  if ("role" in item && "content" in item) {
    return "message";
  }

  return "unknown";
}

function getStringProperty(item: ResponseInputItem, key: string): string | undefined {
  if (!hasProperty(item, key)) {
    return undefined;
  }

  const value = item[key];
  return typeof value === "string" ? value : undefined;
}

function hasProperty(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && key in value;
}
