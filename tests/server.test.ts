import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import { createToolboxServer, type ToolboxServer } from '../src/server.js';
import { createFixture, isError, resultJson, resultText, type Fixture } from './helpers.js';

interface Harness {
  fx: Fixture;
  client: Client;
  toolbox: ToolboxServer;
  audit: AuditLog;
  close(): Promise<void>;
}

async function connect(fx: Fixture): Promise<Harness> {
  const audit = new AuditLog(undefined, undefined, true);
  const toolbox = createToolboxServer(fx.config, { audit });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    fx,
    client,
    toolbox,
    audit,
    close: async () => {
      await client.close();
      await toolbox.close();
      await fx.cleanup();
    },
  };
}

const call = (h: Harness, name: string, args: Record<string, unknown>) => h.client.callTool({ name, arguments: args });

const contentText = (resource: { contents: Array<{ text?: string; blob?: string }> }): string => resource.contents[0]?.text ?? '';

async function expectRejected(h: Harness, name: string, args: Record<string, unknown>, code: string): Promise<string> {
  const result = await call(h, name, args);
  expect(isError(result), `expected ${name} to fail with ${code}`).toBe(true);
  const text = resultText(result);
  expect(text).toContain(`[${code}]`);
  return text;
}

describe('toolbox over InMemoryTransport (read-only config)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await connect(await createFixture());
  });

  afterAll(async () => {
    await h.close();
  });

  it('advertises every tool, both resource templates and both prompts', async () => {
    const tools = (await h.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['fs_list', 'fs_read', 'fs_search', 'fs_write', 'http_fetch', 'sqlite_describe_table', 'sqlite_list_tables', 'sqlite_query']);
    const templates = (await h.client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate).sort();
    expect(templates).toEqual(['file://{+path}', 'sqlite://{database}/schema']);
    const resources = (await h.client.listResources()).resources.map((r) => r.uri);
    expect(resources).toContain('sqlite://demo/schema');
    expect(resources).toContain('file://notes/todo.md');
    expect(resources).not.toContain('file://.git/HEAD');
    expect((await h.client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(['explain_schema', 'summarize_file']);
    expect(h.client.getInstructions()).toContain('read-only');
  });

  describe('sqlite tools', () => {
    it('lists, describes and queries with parameters', async () => {
      expect(resultJson<{ tables: unknown[] }>(await call(h, 'sqlite_list_tables', { database: 'demo' })).tables).toEqual([
        { name: 'adults', type: 'view' },
        { name: 'people', type: 'table' },
      ]);
      const described = resultJson<{ rowCount: number; indexes: unknown[] }>(await call(h, 'sqlite_describe_table', { database: 'demo', table: 'people' }));
      expect(described.rowCount).toBe(3);
      expect(described.indexes).toHaveLength(1);
      const q = resultJson<{ rows: unknown[][]; truncated: boolean }>(
        await call(h, 'sqlite_query', { database: 'demo', sql: 'SELECT name FROM people WHERE age >= :min ORDER BY name', params: { min: 18 } }),
      );
      expect(q.rows).toEqual([['Ada'], ['Cy']]);
      expect(q.truncated).toBe(false);
    });

    it('caps rows at maxRows and refuses a larger request', async () => {
      const q = resultJson<{ rowCount: number; truncated: boolean }>(await call(h, 'sqlite_query', { database: 'demo', sql: 'SELECT id FROM people' }));
      expect(q).toMatchObject({ rowCount: 2, truncated: true });
      const tooMany = await call(h, 'sqlite_query', { database: 'demo', sql: 'SELECT 1', maxRows: 999 });
      expect(isError(tooMany)).toBe(true);
      expect(resultText(tooMany)).toMatch(/maxRows/);
    });

    it('rejects DROP, chained statements, PRAGMA and unknown databases, leaving the data intact', async () => {
      await expectRejected(h, 'sqlite_query', { database: 'demo', sql: 'DROP TABLE people' }, 'SQL_REJECTED');
      await expectRejected(h, 'sqlite_query', { database: 'demo', sql: 'SELECT 1; DELETE FROM people' }, 'SQL_REJECTED');
      await expectRejected(h, 'sqlite_query', { database: 'demo', sql: 'PRAGMA table_info(people)' }, 'SQL_REJECTED');
      await expectRejected(h, 'sqlite_query', { database: 'demo', sql: "ATTACH DATABASE '/tmp/x.db' AS x" }, 'SQL_REJECTED');
      await expectRejected(h, 'sqlite_query', { database: 'other', sql: 'SELECT 1' }, 'UNKNOWN_DATABASE');
      await expectRejected(h, 'sqlite_describe_table', { database: 'demo', table: 'nope' }, 'UNKNOWN_TABLE');
      const count = resultJson<{ rows: unknown[][] }>(await call(h, 'sqlite_query', { database: 'demo', sql: 'SELECT count(*) FROM people' }));
      expect(count.rows).toEqual([[3]]);
    });
  });

  describe('filesystem tools', () => {
    it('lists recursively, ignoring .git and node_modules, and honours depth', async () => {
      const listing = resultJson<{ entries: Array<{ path: string; type: string }> }>(await call(h, 'fs_list', {}));
      const paths = listing.entries.map((e) => e.path);
      expect(paths).toContain('notes/todo.md');
      expect(paths).toContain('sub/deeper');
      expect(paths).not.toContain('sub/deeper/data.json');
      expect(paths.some((p) => p.startsWith('.git') || p.startsWith('node_modules'))).toBe(false);
      expect(listing.entries.find((e) => e.path === 'escape')).toMatchObject({ type: 'symlink' });
      const deep = resultJson<{ entries: Array<{ path: string }> }>(await call(h, 'fs_list', { path: 'sub', depth: 3 }));
      expect(deep.entries.map((e) => e.path)).toEqual(['sub/deeper', 'sub/deeper/data.json']);
    });

    it('reads whole files and line ranges', async () => {
      expect(resultText(await call(h, 'fs_read', { path: 'notes/todo.md' }))).toBe('# Todo\n- buy milk\n- call Bob\n');
      expect(resultText(await call(h, 'fs_read', { path: 'big.txt', startLine: 2, endLine: 3 }))).toBe(
        '[big.txt: lines 2-3]\nline 2 of the big file\nline 3 of the big file',
      );
    });

    it('rejects traversal, absolute paths outside the root and escaping symlinks', async () => {
      await expectRejected(h, 'fs_read', { path: '../../etc/passwd' }, 'PATH_OUTSIDE_ROOT');
      await expectRejected(h, 'fs_read', { path: '/etc/passwd' }, 'PATH_OUTSIDE_ROOT');
      await expectRejected(h, 'fs_read', { path: path.join(h.fx.outside, 'secret.txt') }, 'PATH_OUTSIDE_ROOT');
      await expectRejected(h, 'fs_read', { path: 'escape' }, 'PATH_OUTSIDE_ROOT');
      await expectRejected(h, 'fs_read', { path: 'escape-dir/secret.txt' }, 'PATH_OUTSIDE_ROOT');
      await expectRejected(h, 'fs_list', { path: 'escape-dir' }, 'PATH_OUTSIDE_ROOT');
      await expectRejected(h, 'fs_search', { pattern: 'SECRET', path: 'escape-dir' }, 'PATH_OUTSIDE_ROOT');
      await expectRejected(h, 'fs_read', { path: 'missing.md' }, 'NOT_FOUND');
    });

    it('rejects binary files and files above the size cap, but allows a slice of a big file', async () => {
      await expectRejected(h, 'fs_read', { path: 'binary.bin' }, 'BINARY_FILE');
      const text = await expectRejected(h, 'fs_read', { path: 'big.txt' }, 'SIZE_CAP');
      expect(text).toContain('startLine');
      await expectRejected(h, 'fs_read', { path: 'big.txt', startLine: 1, endLine: 400 }, 'SIZE_CAP');
    });

    it('searches with globs and context, skipping ignored directories and binaries', async () => {
      const found = resultJson<{ matches: Array<{ path: string; line: number; text: string; before: string[]; after: string[] }>; filesSkipped: number }>(
        await call(h, 'fs_search', { pattern: 'milk', contextLines: 1 }),
      );
      expect(found.matches.map((m) => m.path).sort()).toEqual(['notes/todo.md', 'sub/deeper/data.json']);
      expect(found.matches.find((m) => m.path === 'notes/todo.md')).toMatchObject({ line: 2, before: ['# Todo'], after: ['- call Bob'] });
      expect(found.filesSkipped).toBeGreaterThanOrEqual(1);
      const onlyMd = resultJson<{ matches: Array<{ path: string }> }>(await call(h, 'fs_search', { pattern: 'MILK', include: ['*.md'], ignoreCase: true }));
      expect(onlyMd.matches.map((m) => m.path)).toEqual(['notes/todo.md']);
      const capped = resultJson<{ matches: unknown[]; truncated: boolean }>(await call(h, 'fs_search', { pattern: '.', maxMatches: 3 }));
      expect(capped).toMatchObject({ truncated: true });
      expect(capped.matches).toHaveLength(3);
      await expectRejected(h, 'fs_search', { pattern: '(' }, 'INVALID_ARGUMENT');
    });

    it('refuses writes when writeEnabled is false and advertises that in the description', async () => {
      await expectRejected(h, 'fs_write', { path: 'notes/new.md', content: 'hello' }, 'WRITE_DISABLED');
      await expect(stat(path.join(h.fx.root, 'notes', 'new.md'))).rejects.toThrow();
      const tool = (await h.client.listTools()).tools.find((t) => t.name === 'fs_write');
      expect(tool?.description).toContain('Disabled');
    });
  });

  describe('resources and prompts', () => {
    it('serves the schema and files, and applies the same path checks', async () => {
      const schema = await h.client.readResource({ uri: 'sqlite://demo/schema' });
      expect(contentText(schema)).toContain('CREATE TABLE people');
      const file = await h.client.readResource({ uri: 'file://notes/todo.md' });
      expect(file.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: '# Todo\n- buy milk\n- call Bob\n' });
      const absolute = await h.client.readResource({ uri: `file://${path.join(h.fx.root, 'notes', 'readme.md')}` });
      expect(contentText(absolute)).toContain('# Readme');
      await expect(h.client.readResource({ uri: 'file://../../etc/passwd' })).rejects.toThrow(/PATH_OUTSIDE_ROOT/);
      await expect(h.client.readResource({ uri: 'file://escape' })).rejects.toThrow(/PATH_OUTSIDE_ROOT/);
      await expect(h.client.readResource({ uri: 'file://binary.bin' })).rejects.toThrow(/BINARY_FILE/);
      await expect(h.client.readResource({ uri: 'sqlite://other/schema' })).rejects.toThrow(/UNKNOWN_DATABASE/);
    });

    it('renders prompts with embedded content', async () => {
      const explain = await h.client.getPrompt({ name: 'explain_schema', arguments: { database: 'demo', focus: 'people' } });
      const explainText = explain.messages[0]?.content.type === 'text' ? explain.messages[0].content.text : '';
      expect(explainText).toContain('CREATE TABLE people');
      expect(explainText).toContain('Focus on: people');
      const summary = await h.client.getPrompt({ name: 'summarize_file', arguments: { path: 'notes/todo.md', maxWords: '50' } });
      const summaryText = summary.messages[0]?.content.type === 'text' ? summary.messages[0].content.text : '';
      expect(summaryText).toContain('at most 50 words');
      expect(summaryText).toContain('- buy milk');
      await expect(h.client.getPrompt({ name: 'summarize_file', arguments: { path: 'notes/todo.md', maxWords: 'lots' } })).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(h.client.getPrompt({ name: 'summarize_file', arguments: { path: '../../etc/passwd' } })).rejects.toThrow(/PATH_OUTSIDE_ROOT/);
    });
  });

  describe('http_fetch', () => {
    let server: http.Server;
    let origin: string;
    let port: number;
    const timers = new Set<NodeJS.Timeout>();

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        switch (req.url) {
          case '/page':
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<html><head><title>Local &amp; Page</title><script>evil()</script></head><body><h1>Hi</h1><p>Body &lt;b&gt;</p></body></html>');
            return;
          case '/json':
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
            return;
          case '/big':
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('x'.repeat(20_000));
            return;
          case '/big-declared':
            res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' });
            res.end();
            return;
          case '/redirect-out':
            res.writeHead(302, { location: 'http://not-allowed.invalid/secret' });
            res.end();
            return;
          case '/redirect-in':
            res.writeHead(302, { location: '/page' });
            res.end();
            return;
          case '/loop':
            res.writeHead(302, { location: '/loop' });
            res.end();
            return;
          case '/slow': {
            const t = setTimeout(() => {
              res.end('late');
              timers.delete(t);
            }, 5_000);
            timers.add(t);
            res.on('close', () => clearTimeout(t));
            return;
          }
          case '/binary':
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(Buffer.from([0x00, 0x01, 0x02]));
            return;
          default:
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('nope');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
      origin = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('fetches HTML as readable text and JSON verbatim', async () => {
      const page = resultText(await call(h, 'http_fetch', { url: `${origin}/page` }));
      expect(page.startsWith('HTTP 200 text/html; charset=utf-8')).toBe(true);
      expect(page).toContain('Local & Page\n\nHi\n\nBody <b>');
      expect(page).not.toContain('evil()');
      const raw = resultText(await call(h, 'http_fetch', { url: `${origin}/page`, raw: true }));
      expect(raw).toContain('<script>evil()</script>');
      expect(resultText(await call(h, 'http_fetch', { url: `${origin}/json` }))).toContain('{"ok":true}');
      expect(resultText(await call(h, 'http_fetch', { url: `${origin}/missing` }))).toContain('HTTP 404');
    });

    it('rejects hosts outside the allowlist, including after a redirect', async () => {
      await expectRejected(h, 'http_fetch', { url: `http://localhost:${port}/page` }, 'HOST_NOT_ALLOWED');
      await expectRejected(h, 'http_fetch', { url: 'https://example.com/' }, 'HOST_NOT_ALLOWED');
      await expectRejected(h, 'http_fetch', { url: `${origin}/redirect-out` }, 'HOST_NOT_ALLOWED');
      await expectRejected(h, 'http_fetch', { url: `ftp://127.0.0.1/x` }, 'URL_INVALID');
      const followed = resultText(await call(h, 'http_fetch', { url: `${origin}/redirect-in` }));
      expect(followed).toContain('1 redirect(s)');
      expect(followed).toContain('Local & Page');
      await expectRejected(h, 'http_fetch', { url: `${origin}/loop` }, 'FETCH_FAILED');
    });

    it('enforces the byte cap, binary refusal and the timeout', async () => {
      await expectRejected(h, 'http_fetch', { url: `${origin}/big` }, 'SIZE_CAP');
      await expectRejected(h, 'http_fetch', { url: `${origin}/big-declared` }, 'SIZE_CAP');
      await expectRejected(h, 'http_fetch', { url: `${origin}/binary` }, 'BINARY_CONTENT');
      await expectRejected(h, 'http_fetch', { url: `${origin}/slow`, timeoutMs: 300 }, 'TIMEOUT');
    });
  });

  it('writes one audit entry per call with outcome and timing', () => {
    const entries = h.audit.entries;
    expect(entries.length).toBeGreaterThan(20);
    const rejected = entries.find((e) => e.name === 'fs_read' && e.error?.includes('PATH_OUTSIDE_ROOT'));
    expect(rejected).toMatchObject({ kind: 'tool', ok: false, args: { path: '../../etc/passwd' } });
    expect(entries.find((e) => e.kind === 'resource' && e.name === 'sqlite_schema')).toMatchObject({ ok: true });
    expect(entries.find((e) => e.kind === 'prompt' && e.name === 'explain_schema')).toMatchObject({ ok: true });
    expect(entries.every((e) => typeof e.ms === 'number' && e.ms >= 0)).toBe(true);
  });
});

describe('toolbox with writes enabled', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await connect(await createFixture({ writeEnabled: true }));
  });

  afterAll(async () => {
    await h.close();
  });

  it('writes inside the root and still refuses every escape', async () => {
    const written = resultJson<{ path: string; bytes: number }>(await call(h, 'fs_write', { path: 'notes/new.md', content: '# New\n' }));
    expect(written).toEqual({ path: 'notes/new.md', root: h.fx.root, bytes: 6 });
    expect(await readFile(path.join(h.fx.root, 'notes', 'new.md'), 'utf8')).toBe('# New\n');
    expect(resultText(await call(h, 'fs_read', { path: 'notes/new.md' }))).toBe('# New\n');
    await expectRejected(h, 'fs_write', { path: '../evil.md', content: 'x' }, 'PATH_OUTSIDE_ROOT');
    await expectRejected(h, 'fs_write', { path: 'escape', content: 'x' }, 'PATH_OUTSIDE_ROOT');
    await expectRejected(h, 'fs_write', { path: 'escape-dir/evil.md', content: 'x' }, 'PATH_OUTSIDE_ROOT');
    await expectRejected(h, 'fs_write', { path: 'nodir/x.md', content: 'x' }, 'NOT_FOUND');
    await expectRejected(h, 'fs_write', { path: 'sub', content: 'x' }, 'NOT_A_FILE');
    expect(await readFile(path.join(h.fx.outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET\n');
  });

  it('applies the byte cap to writes at the schema level', async () => {
    const huge = await call(h, 'fs_write', { path: 'notes/huge.md', content: 'x'.repeat(5000) });
    expect(isError(huge)).toBe(true);
    expect(resultText(huge)).toMatch(/content/);
    await expect(stat(path.join(h.fx.root, 'notes', 'huge.md'))).rejects.toThrow();
  });
});
