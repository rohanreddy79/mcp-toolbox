/**
 * Streamable HTTP transport on plain `node:http`, stateful sessions (one McpServer per session).
 * There is no authentication: the server binds to loopback by default and, when it does, rejects
 * requests whose Host header is not a loopback name, which blocks DNS-rebinding from a browser tab.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolboxServer } from '../server.js';

export interface HttpServeOptions {
  host: string;
  port: number;
  /** Endpoint path, default `/mcp`. */
  path?: string;
  log?: (message: string) => void;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  sessionCount(): number;
  close(): Promise<void>;
}

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_NAMES.has(host.toLowerCase());
}

/** Accepts `localhost`, `127.0.0.1` or `[::1]`, with the bound port or no port at all. */
export function isAllowedHostHeader(header: string | undefined, port: number): boolean {
  if (header === undefined || header === '') return false;
  const value = header.trim().toLowerCase();
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value);
  if (!match) return false;
  const [, name, portText] = match;
  if (!LOOPBACK_NAMES.has(name ?? '')) return false;
  return portText === undefined || Number(portText) === port;
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

interface Session {
  transport: StreamableHTTPServerTransport;
  toolbox: ToolboxServer;
}

export async function serveHttp(factory: () => ToolboxServer, options: HttpServeOptions): Promise<RunningHttpServer> {
  const endpoint = options.path ?? '/mcp';
  const log = options.log ?? ((message: string) => console.error(`[mcp-toolbox] ${message}`));
  const sessions = new Map<string, Session>();
  const enforceHostHeader = isLoopbackHost(options.host);
  let boundPort = options.port;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname !== endpoint) {
      jsonRpcError(res, 404, `not found; the MCP endpoint is ${endpoint}`);
      return;
    }
    if (enforceHostHeader && !isAllowedHostHeader(req.headers.host, boundPort)) {
      jsonRpcError(res, 403, 'forbidden: Host header is not a loopback address');
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId);
      if (!session) {
        jsonRpcError(res, 404, 'session not found');
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      jsonRpcError(res, 400, 'missing mcp-session-id header');
      return;
    }

    // No session yet: this must be an initialize request; the transport rejects anything else with 400.
    const toolbox = factory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, toolbox });
        log(`session ${id} opened (${sessions.size} active)`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined && sessions.delete(transport.sessionId)) {
        log(`session ${transport.sessionId} closed (${sessions.size} active)`);
      }
      void toolbox.close();
    };
    await toolbox.server.connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId === undefined) await transport.close();
  };

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) jsonRpcError(res, 500, 'internal error');
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });
  boundPort = (httpServer.address() as AddressInfo).port;
  const displayHost = options.host.includes(':') ? `[${options.host}]` : options.host;
  if (!enforceHostHeader) log(`bound to non-loopback ${options.host}: Host header checks are off; put an authenticating proxy in front`);

  return {
    url: `http://${displayHost}:${boundPort}${endpoint}`,
    port: boundPort,
    sessionCount: () => sessions.size,
    close: async () => {
      for (const session of [...sessions.values()]) await session.transport.close();
      sessions.clear();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
