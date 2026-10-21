import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { createToolboxServer } from '../src/server.js';
import { isAllowedHostHeader, serveHttp, type RunningHttpServer } from '../src/transports/http.js';
import { createFixture, resultJson, type Fixture } from './helpers.js';

function rawRequest(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method, headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});

describe('isAllowedHostHeader', () => {
  it('accepts loopback names with the bound port or no port, nothing else', () => {
    expect(isAllowedHostHeader('127.0.0.1:3333', 3333)).toBe(true);
    expect(isAllowedHostHeader('localhost:3333', 3333)).toBe(true);
    expect(isAllowedHostHeader('LOCALHOST', 3333)).toBe(true);
    expect(isAllowedHostHeader('[::1]:3333', 3333)).toBe(true);
    expect(isAllowedHostHeader('127.0.0.1:4444', 3333)).toBe(false);
    expect(isAllowedHostHeader('evil.example.com', 3333)).toBe(false);
    expect(isAllowedHostHeader('evil.example.com:3333', 3333)).toBe(false);
    expect(isAllowedHostHeader(undefined, 3333)).toBe(false);
  });
});

describe('Streamable HTTP transport', () => {
  let fx: Fixture;
  let running: RunningHttpServer;
  const audit = new AuditLog(undefined, undefined, true);

  beforeAll(async () => {
    fx = await createFixture();
    running = await serveHttp(() => createToolboxServer(fx.config, { audit }), { host: '127.0.0.1', port: 0, log: () => {} });
  });

  afterAll(async () => {
    await running.close();
    await fx.cleanup();
  });

  it('serves full sessions to SDK clients and tears them down on DELETE', async () => {
    const client = new Client({ name: 'http-test', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(running.url));
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(8);
    const q = resultJson<{ rows: unknown[][] }>(await client.callTool({ name: 'sqlite_query', arguments: { database: 'demo', sql: 'SELECT count(*) FROM people' } }));
    expect(q.rows).toEqual([[3]]);
    expect(running.sessionCount()).toBe(1);

    const second = new Client({ name: 'http-test-2', version: '0' });
    await second.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    expect(running.sessionCount()).toBe(2);

    await transport.terminateSession();
    await client.close();
    await second.close();
    expect(running.sessionCount()).toBe(1);
    expect(audit.entries.some((e) => e.name === 'sqlite_query' && e.ok)).toBe(true);
  });

  it('rejects non-loopback Host headers (DNS rebinding) and malformed session use', async () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const rebinding = await rawRequest(running.url, { method: 'POST', headers: { ...headers, host: 'evil.example.com' }, body: INITIALIZE });
    expect(rebinding.status).toBe(403);
    expect(rebinding.body).toContain('Host header');

    const ok = await rawRequest(running.url, { method: 'POST', headers: { ...headers, host: `localhost:${running.port}` }, body: INITIALIZE });
    expect(ok.status).toBe(200);

    const noSession = await rawRequest(running.url, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(noSession.status).toBe(400);
    const unknownSession = await rawRequest(running.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': 'nope' }, body: INITIALIZE });
    expect(unknownSession.status).toBe(404);
    const wrongPath = await rawRequest(running.url.replace('/mcp', '/other'), { method: 'POST', headers, body: INITIALIZE });
    expect(wrongPath.status).toBe(404);
    const health = await rawRequest(running.url.replace('/mcp', '/healthz'), { method: 'GET', headers: {} });
    expect(health).toEqual({ status: 200, body: 'ok' });
  });
});
