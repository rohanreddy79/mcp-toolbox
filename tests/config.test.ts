import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeConfig, loadConfig, mergeConfig } from '../src/config.js';
import { ToolboxError } from '../src/errors.js';

let base: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'toolbox-config-')));
  await mkdir(path.join(base, 'data'));
  await writeFile(path.join(base, 'data', 'x.db'), '');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('mergeConfig', () => {
  it('applies defaults', () => {
    const cfg = mergeConfig({}, '/cfg', undefined, '/cwd');
    expect(cfg).toEqual({
      roots: [],
      databases: {},
      allowedHosts: [],
      maxBytes: 1_048_576,
      maxRows: 500,
      writeEnabled: false,
      auditLog: undefined,
      fetchTimeoutMs: 10_000,
      ignore: ['.git', 'node_modules'],
    });
  });

  it('resolves file paths against the config directory and CLI paths against cwd', () => {
    const cfg = mergeConfig(
      { roots: ['./data'], databases: { a: 'data/a.db' }, auditLog: 'audit.jsonl' },
      '/cfg',
      { roots: ['extra'], databases: { b: 'b.db' } },
      '/cwd',
    );
    expect(cfg.roots).toEqual(['/cfg/data', '/cwd/extra']);
    expect(cfg.databases).toEqual({ a: '/cfg/data/a.db', b: '/cwd/b.db' });
    expect(cfg.auditLog).toBe('/cfg/audit.jsonl');
  });

  it('appends lists, overrides scalars and lets the CLI only turn writes on', () => {
    const cfg = mergeConfig(
      { allowedHosts: ['a.com'], maxBytes: 10, writeEnabled: true },
      '/cfg',
      { allowedHosts: ['b.com'], maxBytes: 20, writeEnabled: false, auditLog: 'cli.jsonl' },
      '/cwd',
    );
    expect(cfg.allowedHosts).toEqual(['a.com', 'b.com']);
    expect(cfg.maxBytes).toBe(20);
    expect(cfg.writeEnabled).toBe(true);
    expect(cfg.auditLog).toBe('/cwd/cli.jsonl');
  });

  it('rejects unknown keys, bad database names and bad types', () => {
    expect(() => mergeConfig({ rootz: [] }, '/c', undefined, '/w')).toThrow(ToolboxError);
    expect(() => mergeConfig({ databases: { 'bad name': 'x.db' } }, '/c', undefined, '/w')).toThrow(/databases\.bad name/);
    expect(() => mergeConfig({ maxBytes: '10' }, '/c', undefined, '/w')).toThrow(/maxBytes/);
    expect(() => mergeConfig({}, '/c', { maxRows: 1_000_000 }, '/w')).toThrow(/command line: maxRows/);
  });
});

describe('finalizeConfig / loadConfig', () => {
  it('fails fast on a missing root or database', async () => {
    const good = mergeConfig({ roots: ['data'], databases: { x: 'data/x.db' } }, base, undefined, base);
    await expect(finalizeConfig(good)).resolves.toMatchObject({ roots: [path.join(base, 'data')] });
    await expect(finalizeConfig({ ...good, roots: [path.join(base, 'nope')] })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(finalizeConfig({ ...good, databases: { y: path.join(base, 'nope.db') } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(finalizeConfig({ ...good, roots: [path.join(base, 'data', 'x.db')] })).rejects.toThrow(/not a directory/);
  });

  it('loads a JSON file and merges CLI overrides', async () => {
    const file = path.join(base, 'toolbox.config.json');
    await writeFile(file, JSON.stringify({ roots: ['data'], databases: { x: 'data/x.db' }, allowedHosts: ['example.com'] }));
    const cfg = await loadConfig({ configPath: file, overrides: { allowedHosts: ['*.test'], writeEnabled: true }, cwd: base });
    expect(cfg.roots).toEqual([path.join(base, 'data')]);
    expect(cfg.databases).toEqual({ x: path.join(base, 'data', 'x.db') });
    expect(cfg.allowedHosts).toEqual(['example.com', '*.test']);
    expect(cfg.writeEnabled).toBe(true);
  });

  it('reports unreadable or malformed files as CONFIG_INVALID', async () => {
    await expect(loadConfig({ configPath: path.join(base, 'missing.json') })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    const bad = path.join(base, 'bad.json');
    await writeFile(bad, '{ not json');
    await expect(loadConfig({ configPath: bad })).rejects.toThrow(/not valid JSON/);
  });
});
