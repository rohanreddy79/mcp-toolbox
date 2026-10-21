import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolboxError } from '../src/errors.js';
import { isInside, resolveExisting, resolveForWrite } from '../src/safety/paths.js';

let base: string;
let root: string;
let second: string;
let outside: string;

async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolboxError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolboxError);
    expect((err as ToolboxError).code).toBe(code);
    return err as ToolboxError;
  }
  throw new Error(`expected rejection with ${code}`);
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'toolbox-paths-')));
  root = path.join(base, 'root');
  second = path.join(base, 'second');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await mkdir(second, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'a');
  await writeFile(path.join(root, 'sub', 'b.txt'), 'b');
  await writeFile(path.join(second, 'only-in-second.txt'), 's');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape'));
  await symlink(outside, path.join(root, 'escape-dir'));
  await symlink(path.join(root, 'a.txt'), path.join(root, 'inside-link'));
  await symlink(path.join(outside, 'nope.txt'), path.join(root, 'dangling'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('isInside', () => {
  it('is a lexical prefix check on path segments', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b/..x', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
    expect(isInside('/etc/passwd', '/a/b')).toBe(false);
  });
});

describe('resolveExisting', () => {
  it('resolves root-relative and absolute paths inside the root', async () => {
    await expect(resolveExisting([root], 'a.txt')).resolves.toEqual({ absolute: path.join(root, 'a.txt'), root, relative: 'a.txt' });
    await expect(resolveExisting([root], './sub/../sub/b.txt')).resolves.toMatchObject({ relative: 'sub/b.txt' });
    await expect(resolveExisting([root], path.join(root, 'sub', 'b.txt'))).resolves.toMatchObject({ relative: 'sub/b.txt' });
    await expect(resolveExisting([root], '.')).resolves.toMatchObject({ absolute: root, relative: '' });
  });

  it('rejects ../ traversal before touching the disk', async () => {
    const err = await expectCode(resolveExisting([root], '../../etc/passwd'), 'PATH_OUTSIDE_ROOT');
    expect(err.message).toContain('../../etc/passwd');
  });

  it('rejects absolute paths outside every root', async () => {
    await expectCode(resolveExisting([root], '/etc/passwd'), 'PATH_OUTSIDE_ROOT');
    await expectCode(resolveExisting([root], path.join(outside, 'secret.txt')), 'PATH_OUTSIDE_ROOT');
  });

  it('rejects symlinks whose target is outside the root', async () => {
    await expectCode(resolveExisting([root], 'escape'), 'PATH_OUTSIDE_ROOT');
    await expectCode(resolveExisting([root], 'escape-dir/secret.txt'), 'PATH_OUTSIDE_ROOT');
  });

  it('accepts symlinks that stay inside the root', async () => {
    await expect(resolveExisting([root], 'inside-link')).resolves.toMatchObject({ absolute: path.join(root, 'a.txt') });
  });

  it('reports missing files and invalid input', async () => {
    await expectCode(resolveExisting([root], 'missing.txt'), 'NOT_FOUND');
    await expectCode(resolveExisting([root], 'dangling'), 'NOT_FOUND');
    await expectCode(resolveExisting([root], 'a\0.txt'), 'PATH_INVALID');
    await expectCode(resolveExisting([root], ''), 'PATH_INVALID');
  });

  it('tries roots in order for relative paths', async () => {
    await expect(resolveExisting([root, second], 'only-in-second.txt')).resolves.toMatchObject({ root: second });
    await expect(resolveExisting([root, second], 'a.txt')).resolves.toMatchObject({ root });
  });
});

describe('resolveForWrite', () => {
  it('accepts new files whose parent exists inside the root', async () => {
    await expect(resolveForWrite([root], 'new.txt')).resolves.toEqual({ absolute: path.join(root, 'new.txt'), root, relative: 'new.txt' });
    await expect(resolveForWrite([root], 'sub/new.txt')).resolves.toMatchObject({ relative: 'sub/new.txt' });
  });

  it('accepts existing regular files, including through inside symlinks', async () => {
    await expect(resolveForWrite([root], 'a.txt')).resolves.toMatchObject({ absolute: path.join(root, 'a.txt') });
    await expect(resolveForWrite([root], 'inside-link')).resolves.toMatchObject({ absolute: path.join(root, 'a.txt') });
  });

  it('rejects escapes: traversal, symlinked parent, dangling symlink, outside target', async () => {
    await expectCode(resolveForWrite([root], '../evil.txt'), 'PATH_OUTSIDE_ROOT');
    await expectCode(resolveForWrite([root], 'escape-dir/new.txt'), 'PATH_OUTSIDE_ROOT');
    await expectCode(resolveForWrite([root], 'dangling'), 'PATH_OUTSIDE_ROOT');
    await expectCode(resolveForWrite([root], 'escape'), 'PATH_OUTSIDE_ROOT');
  });

  it('rejects directories and missing parents', async () => {
    await expectCode(resolveForWrite([root], 'sub'), 'NOT_A_FILE');
    await expectCode(resolveForWrite([root], 'nodir/new.txt'), 'NOT_FOUND');
  });
});
