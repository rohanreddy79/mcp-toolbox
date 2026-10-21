/**
 * Assembles an McpServer from a resolved config. A fresh instance is created per transport
 * connection (the SDK binds one server to one transport); the audit log can be shared across them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuditLog } from './audit.js';
import type { ToolboxConfig } from './config.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import type { ServerContext } from './tooling.js';
import { registerFsTools } from './tools/fs.js';
import { registerHttpTools } from './tools/http.js';
import { registerSqliteTools, SqliteRegistry } from './tools/sqlite.js';

export const SERVER_NAME = 'mcp-toolbox';
export const SERVER_VERSION = '0.1.0';

export interface ToolboxServer {
  server: McpServer;
  context: ServerContext;
  /** Closes the transport, database handles and flushes the audit log. */
  close(): Promise<void>;
}

export interface CreateServerOptions {
  audit?: AuditLog;
}

function buildInstructions(config: ToolboxConfig): string {
  const databases = Object.keys(config.databases).sort();
  return [
    'mcp-toolbox gives you sandboxed access to local data. Everything is logged.',
    `Filesystem roots (read${config.writeEnabled ? '/write' : '-only'}): ${config.roots.join(', ') || 'none'}.`,
    `SQLite databases (read-only; SELECT/WITH only): ${databases.join(', ') || 'none'}.`,
    `HTTP GET allowed hosts: ${config.allowedHosts.join(', ') || 'none'}.`,
    'Paths are root-relative ("notes/todo.md"). Errors come back as "[CODE] message" tool results.',
  ].join('\n');
}

export function createToolboxServer(config: ToolboxConfig, options: CreateServerOptions = {}): ToolboxServer {
  const audit = options.audit ?? new AuditLog(config.auditLog);
  const databases = new SqliteRegistry(config.databases);
  const context: ServerContext = { config, audit, databases };
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: buildInstructions(config) });

  registerSqliteTools(server, context);
  registerFsTools(server, context);
  registerHttpTools(server, context);
  registerResources(server, context);
  registerPrompts(server, context);

  return {
    server,
    context,
    close: async () => {
      await server.close();
      databases.closeAll();
      await audit.flush();
    },
  };
}
