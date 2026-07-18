import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { LifecycleEmitter } from "./lifecycle.js";
import type { PermissionDecision } from "../governance/types.js";
import type { ToolCallRequest, ToolDefinition, ToolResult, ToolRuntime } from "../tools/types.js";
import type { McpServerConfig } from "./mcpConfig.js";
import {
  adaptMcpCallError,
  createMcpToolCatalog,
  projectMcpCallResult,
  type McpToolCatalog,
  type McpToolCatalogDiagnostics,
} from "./mcpToolAdapter.js";

export interface StartMcpSessionOptions {
  baseCwd: string;
  lifecycleEmitter?: LifecycleEmitter;
  server: McpServerConfig;
  transport?: Transport;
}

export class McpSessionStartError extends Error {
  constructor(
    readonly phase: "connect" | "discovery",
    message: string,
  ) {
    super(message);
    this.name = "McpSessionStartError";
  }
}

export class McpSession implements ToolRuntime {
  readonly permissionPolicies: ReadonlyMap<string, PermissionDecision>;
  readonly diagnostics: McpToolCatalogDiagnostics;

  private closePromise: Promise<void> | undefined;
  private connected = false;
  private expectedClose = false;
  private stoppedEventEmitted = false;
  private startup = true;

  private constructor(
    private readonly client: Client,
    private readonly server: McpServerConfig,
    private readonly catalog: McpToolCatalog,
    private readonly lifecycleEmitter?: LifecycleEmitter,
  ) {
    this.permissionPolicies = catalog.permissions;
    this.diagnostics = catalog.diagnostics;
  }

  static async start(options: StartMcpSessionOptions): Promise<McpSession> {
    const client = new Client({ name: "forge-harness", version: "0.0.0" });
    const transport = options.transport ?? new StdioClientTransport({
      args: options.server.args,
      command: options.server.command,
      cwd: options.baseCwd,
      stderr: "inherit",
    });
    let session: McpSession | undefined;
    let phase: "connect" | "discovery" = "connect";

    client.onclose = () => {
      session?.handleTransportClose();
    };
    client.onerror = (error) => {
      session?.handleTransportError(error);
    };

    try {
      await client.connect(transport, { timeout: options.server.connectTimeoutMs });
      phase = "discovery";
      const result = await client.listTools(undefined, { timeout: options.server.connectTimeoutMs });
      const catalog = createMcpToolCatalog(options.server, result.tools);
      session = new McpSession(client, options.server, catalog, options.lifecycleEmitter);
      session.connected = true;
      session.startup = false;
      await options.lifecycleEmitter?.emit({
        ...catalog.diagnostics,
        serverId: options.server.id,
        type: "mcp_server_connected",
      });
      return session;
    } catch (error) {
      const message = formatError(error);
      await options.lifecycleEmitter?.emit({
        phase,
        reason: message,
        serverId: options.server.id,
        type: "mcp_server_failed",
      });
      try {
        await client.close();
      } catch {
        // Startup already failed; preserve the original connection or discovery error.
      }
      await options.lifecycleEmitter?.emit({
        reason: "startup_failed",
        serverId: options.server.id,
        type: "mcp_server_stopped",
      });
      throw new McpSessionStartError(phase, message);
    }
  }

  toolDefinitions(): ToolDefinition[] {
    return this.connected ? [...this.catalog.definitions] : [];
  }

  async execute(
    toolCall: ToolCallRequest,
    context?: { callId?: string; round?: number },
  ): Promise<ToolResult> {
    const rawToolName = this.catalog.exposedToRaw.get(toolCall.name);

    if (!rawToolName) {
      return {
        content: `blocked_reason: unknown MCP tool "${toolCall.name}"`,
        status: "blocked",
        toolName: toolCall.name,
      };
    }

    if (!this.connected) {
      return adaptMcpCallError(
        this.server.id,
        rawToolName,
        toolCall.name,
        new Error(`MCP server "${this.server.id}" is unavailable`),
      );
    }

    const argumentsValue = parseObjectArguments(toolCall.arguments);
    if (!argumentsValue) {
      return adaptMcpCallError(
        this.server.id,
        rawToolName,
        toolCall.name,
        new Error(`MCP tool "${toolCall.name}" arguments must be a JSON object`),
      );
    }

    try {
      const result = await this.client.callTool(
        { arguments: argumentsValue, name: rawToolName },
        CallToolResultSchema,
        { timeout: this.server.toolCallTimeoutMs },
      );
      const callResult = CallToolResultSchema.safeParse(result);
      if (!callResult.success) {
        throw new Error(`MCP tool "${rawToolName}" returned an unsupported task result`);
      }
      return projectMcpCallResult(this.server.id, rawToolName, toolCall.name, callResult.data);
    } catch (error) {
      await this.lifecycleEmitter?.emit({
        ...(context?.round !== undefined ? { round: context.round } : {}),
        phase: "call",
        reason: formatError(error),
        serverId: this.server.id,
        toolName: toolCall.name,
        type: "mcp_server_failed",
      });
      return adaptMcpCallError(this.server.id, rawToolName, toolCall.name, error);
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeClient();
    return this.closePromise;
  }

  private async closeClient(): Promise<void> {
    this.expectedClose = true;
    this.connected = false;

    try {
      await this.client.close();
    } catch (error) {
      await this.lifecycleEmitter?.emit({
        phase: "close",
        reason: formatError(error),
        serverId: this.server.id,
        type: "mcp_server_failed",
      });
    }

    await this.emitStopped("session_end");
  }

  private handleTransportClose(): void {
    if (this.expectedClose || this.startup || !this.connected) {
      return;
    }

    this.connected = false;
    void this.recordUnexpectedClose();
  }

  private handleTransportError(error: Error): void {
    if (this.expectedClose || this.startup) {
      return;
    }

    void this.lifecycleEmitter?.emit({
      phase: "transport",
      reason: error.message,
      serverId: this.server.id,
      type: "mcp_server_failed",
    });
  }

  private async recordUnexpectedClose(): Promise<void> {
    await this.lifecycleEmitter?.emit({
      phase: "transport",
      reason: `MCP server "${this.server.id}" closed unexpectedly`,
      serverId: this.server.id,
      type: "mcp_server_failed",
    });
    await this.emitStopped("unexpected_close");
  }

  private async emitStopped(reason: "session_end" | "unexpected_close"): Promise<void> {
    if (this.stoppedEventEmitted) {
      return;
    }

    this.stoppedEventEmitted = true;
    await this.lifecycleEmitter?.emit({
      reason,
      serverId: this.server.id,
      type: "mcp_server_stopped",
    });
  }
}

export function startMcpSession(options: StartMcpSessionOptions): Promise<McpSession> {
  return McpSession.start(options);
}

function parseObjectArguments(argumentsText: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
