/**
 * Shared plumbing for registrations: uniform result shaping, error-to-result conversion (the model
 * sees `[CODE] message` as a tool result with isError instead of a protocol failure) and audit logging.
 */
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { ErrorCode, McpError, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AuditKind, AuditLog } from './audit.js';
import type { ToolboxConfig } from './config.js';
import { describeError, isToolboxError } from './errors.js';
import type { SqliteRegistry } from './tools/sqlite.js';

export interface ServerContext {
  config: ToolboxConfig;
  audit: AuditLog;
  databases: SqliteRegistry;
}

/** Handlers return plain text or a JSON-serialisable value; both become a single text content block. */
export type ToolOutput = string | { json: unknown };

export interface ToolSpec<Shape extends ZodRawShapeCompat> {
  title: string;
  description: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: describeError(err) }] };
}

const elapsedMs = (started: number): number => Math.round((performance.now() - started) * 100) / 100;

/** Registers a tool whose handler is timed, audited and whose failures become `isError` results. */
export function registerToolboxTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  ctx: ServerContext,
  name: string,
  spec: ToolSpec<Shape>,
  handler: (args: ShapeOutput<Shape>) => Promise<ToolOutput>,
): void {
  const callback = async (args: ShapeOutput<Shape>): Promise<CallToolResult> => {
    const started = performance.now();
    try {
      const output = await handler(args);
      ctx.audit.record({ kind: 'tool', name, args, ok: true, ms: elapsedMs(started) });
      return typeof output === 'string' ? textResult(output) : jsonResult(output.json);
    } catch (err) {
      ctx.audit.record({ kind: 'tool', name, args, ok: false, error: describeError(err), ms: elapsedMs(started) });
      return errorResult(err);
    }
  };
  // ToolCallback<Shape> is a conditional type the compiler cannot resolve for a generic Shape; for a raw
  // zod shape it resolves to exactly the signature of `callback`.
  server.registerTool(name, spec, callback as unknown as ToolCallback<Shape>);
}

/**
 * Times and audits a resource read or prompt render. Resources and prompts have no `isError` result
 * shape, so a ToolboxError becomes a JSON-RPC InvalidParams error whose message keeps the `[CODE]`.
 */
export async function audited<T>(ctx: ServerContext, kind: AuditKind, name: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    ctx.audit.record({ kind, name, args, ok: true, ms: elapsedMs(started) });
    return result;
  } catch (err) {
    ctx.audit.record({ kind, name, args, ok: false, error: describeError(err), ms: elapsedMs(started) });
    if (isToolboxError(err)) throw new McpError(ErrorCode.InvalidParams, err.toString());
    throw err;
  }
}
