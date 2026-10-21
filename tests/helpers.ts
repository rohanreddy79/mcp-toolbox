/** Shared fixture: a temp root with text/binary/large files and escape symlinks, plus a seeded SQLite DB. */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { finalizeConfig, mergeConfig, type ConfigFileInput, type ToolboxConfig } from '../src/config.js';

export interface Fixture {
  base: string;
  root: string;
  outside: string;
  dbPath: string;
  config: ToolboxConfig;
  cleanup(): Promise<void>;
}

export const MAX_BYTES = 4096;

export async function createFixture(overrides: Partial<ConfigFileInput> = {}): Promise<Fixture> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'toolbox-it-')));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await mkdir(path.join(root, 'sub', 'deeper'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'notes', 'todo.md'), '# Todo\n- buy milk\n- call Bob\n');
  await writeFile(path.join(root, 'notes', 'readme.md'), '# Readme\nNothing to see.\n');
  await writeFile(path.join(root, 'sub', 'deeper', 'data.json'), '{"milk": true}\n');
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'milk\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await writeFile(path.join(root, 'big.txt'), Array.from({ length: 400 }, (_, i) => `line ${i + 1} of the big file`).join('\n'));
  await writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape'));
  await symlink(outside, path.join(root, 'escape-dir'));

  const dbPath = path.join(base, 'demo.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, photo BLOB);
    CREATE UNIQUE INDEX people_name_idx ON people(name);
    CREATE VIEW adults AS SELECT id, name FROM people WHERE age >= 18;
    INSERT INTO people (name, age, photo) VALUES ('Ada', 36, X'0001'), ('Bob', 17, NULL), ('Cy', 50, NULL);
  `);
  db.close();

  const config = await finalizeConfig(
    mergeConfig(
      { roots: [root], databases: { demo: dbPath }, allowedHosts: ['127.0.0.1'], maxBytes: MAX_BYTES, maxRows: 2, ...overrides },
      base,
      undefined,
      base,
    ),
  );
  return { base, root, outside, dbPath, config, cleanup: () => rm(base, { recursive: true, force: true }) };
}

export function resultText(result: unknown): string {
  const r = result as CallToolResult;
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

export function resultJson<T = unknown>(result: unknown): T {
  return JSON.parse(resultText(result)) as T;
}

export function isError(result: unknown): boolean {
  return (result as CallToolResult).isError === true;
}
