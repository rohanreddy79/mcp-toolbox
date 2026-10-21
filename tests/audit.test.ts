import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, summarizeArgs } from '../src/audit.js';

let base: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'toolbox-audit-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('summarizeArgs', () => {
  it('truncates long strings and arrays and bounds depth', () => {
    const long = 'x'.repeat(500);
    const out = summarizeArgs({ sql: long, list: Array.from({ length: 30 }, (_, i) => i), deep: { a: { b: { c: 1 } } } }) as Record<string, unknown>;
    expect((out['sql'] as string).length).toBeLessThan(200);
    expect(out['sql']).toContain('340 more chars');
    expect((out['list'] as unknown[]).length).toBe(21);
    expect(out['deep']).toEqual({ a: { b: '[nested]' } });
  });
});

describe('AuditLog', () => {
  it('appends one JSON line per entry, in order, creating the directory', async () => {
    const file = path.join(base, 'nested', 'audit.jsonl');
    const log = new AuditLog(file, undefined, true);
    log.record({ kind: 'tool', name: 'fs_read', args: { path: 'a.txt' }, ok: true, ms: 1.5 });
    log.record({ kind: 'tool', name: 'fs_write', args: { path: 'b.txt' }, ok: false, error: '[WRITE_DISABLED] off', ms: 0.2 });
    await log.flush();
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l['name'])).toEqual(['fs_read', 'fs_write']);
    expect(lines[1]).toMatchObject({ kind: 'tool', ok: false, error: '[WRITE_DISABLED] off', args: { path: 'b.txt' } });
    expect(typeof lines[0]?.['ts']).toBe('string');
    expect(log.entries).toHaveLength(2);
  });

  it('keeps running and reports when the file cannot be written', async () => {
    const errors: unknown[] = [];
    const log = new AuditLog(path.join(base, 'nested', 'audit.jsonl', 'impossible.jsonl'), (e) => errors.push(e));
    log.record({ kind: 'tool', name: 'x', args: {}, ok: true, ms: 0 });
    await log.flush();
    expect(errors).toHaveLength(1);
  });
});
