/** End-to-end over the built artifact: spawns dist/cli.js exactly as Claude Desktop would. */
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, resultJson, resultText, type Fixture } from './helpers.js';

const execFileAsync = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js');

describe('dist/cli.js over stdio', () => {
  let fx: Fixture;

  beforeAll(async () => {
    await access(CLI).catch(() => {
      throw new Error(`${CLI} is missing: run "pnpm build" first (pnpm test does this for you)`);
    });
    fx = await createFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('answers initialize, tools/list and a tool call, and writes the audit log', async () => {
    const auditFile = path.join(fx.base, 'audit.jsonl');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, '--root', fx.root, '--db', `demo=${fx.dbPath}`, '--allow-host', '127.0.0.1', '--audit-log', auditFile, '--max-rows', '5'],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(transport);
    expect(client.getServerVersion()).toMatchObject({ name: 'mcp-toolbox' });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('sqlite_query');
    const q = resultJson<{ rows: unknown[][] }>(await client.callTool({ name: 'sqlite_query', arguments: { database: 'demo', sql: 'SELECT name FROM people ORDER BY id LIMIT 1' } }));
    expect(q.rows).toEqual([['Ada']]);
    expect(resultText(await client.callTool({ name: 'fs_read', arguments: { path: '../outside/secret.txt' } }))).toContain('[PATH_OUTSIDE_ROOT]');
    await client.close();

    await new Promise((resolve) => setTimeout(resolve, 100));
    const lines = (await readFile(auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { name: string; ok: boolean });
    expect(lines.map((l) => [l.name, l.ok])).toEqual([
      ['sqlite_query', true],
      ['fs_read', false],
    ]);
  });

  it('prints help and version, and fails fast on a bad config', async () => {
    const help = await execFileAsync(process.execPath, [CLI, '--help']);
    expect(help.stdout).toContain('--write-enabled');
    const version = await execFileAsync(process.execPath, [CLI, '--version']);
    expect(version.stdout.trim()).toBe('mcp-toolbox 0.1.0');
    const bad = await execFileAsync(process.execPath, [CLI, '--root', path.join(fx.base, 'does-not-exist')]).catch((err: { code: number; stderr: string }) => err);
    expect(bad).toMatchObject({ code: 1 });
    expect((bad as { stderr: string }).stderr).toContain('[CONFIG_INVALID]');
    const badFlag = await execFileAsync(process.execPath, [CLI, '--db', 'nope']).catch((err: { code: number; stderr: string }) => err);
    expect((badFlag as { stderr: string }).stderr).toContain('NAME=PATH');
  });
});
