/**
 * Path containment for the filesystem tools and the `file://` resource.
 *
 * Two layers: a lexical check (normalise, then require the path to sit under a configured root, which
 * rejects `..` and foreign absolute paths before touching the disk) followed by a physical check
 * (`realpath`, which rejects symlinks that point outside a root). Roots themselves are realpaths.
 */
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolboxError } from '../errors.js';

export interface ResolvedPath {
  /** Physical absolute path (symlinks resolved) that is guaranteed to be inside `root`. */
  absolute: string;
  /** The configured root (itself a realpath) that contains `absolute`. */
  root: string;
  /** Posix-style path of `absolute` relative to `root` (`''` for the root itself). */
  relative: string;
}

/** True when `candidate` is `root` or lies beneath it, judged lexically on normalised paths. */
export function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
}

export function toRelative(absolute: string, root: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function assertValidRequest(requested: string): string {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new ToolboxError('PATH_INVALID', 'path must be a non-empty string');
  }
  if (requested.includes('\0')) throw new ToolboxError('PATH_INVALID', 'path contains a NUL byte');
  return requested;
}

function outside(requested: string, detail = ''): ToolboxError {
  const suffix = detail ? ` (${detail})` : '';
  return new ToolboxError('PATH_OUTSIDE_ROOT', `"${requested}" is outside every allowed root${suffix}`);
}

interface Candidate {
  root: string;
  candidate: string;
}

/** Absolute requests are checked against every root; relative ones are joined to each root in order. */
function lexicalCandidates(roots: readonly string[], requested: string): Candidate[] {
  if (path.isAbsolute(requested)) {
    const normalized = path.resolve(requested);
    return roots.filter((root) => isInside(normalized, root)).map((root) => ({ root, candidate: normalized }));
  }
  return roots
    .map((root) => ({ root, candidate: path.resolve(root, requested) }))
    .filter(({ root, candidate }) => isInside(candidate, root));
}

async function tryRealpath(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new ToolboxError('NOT_FOUND', `cannot resolve "${p}": ${code ?? String(err)}`, { cause: err });
  }
}

function containingRoot(roots: readonly string[], real: string): string | undefined {
  return roots.find((root) => isInside(real, root));
}

/** Resolves a path that must already exist. Follows symlinks and insists the target is inside a root. */
export async function resolveExisting(roots: readonly string[], requested: string): Promise<ResolvedPath> {
  const req = assertValidRequest(requested);
  const candidates = lexicalCandidates(roots, req);
  if (candidates.length === 0) throw outside(req);

  for (const { candidate } of candidates) {
    const real = await tryRealpath(candidate);
    if (real === undefined) continue;
    const root = containingRoot(roots, real);
    if (!root) throw outside(req, 'it resolves through a symlink to a location outside the roots');
    return { absolute: real, root, relative: toRelative(real, root) };
  }
  throw new ToolboxError('NOT_FOUND', `"${req}" does not exist under any allowed root`);
}

/**
 * Resolves a path for writing. If the target exists it must be a regular file inside a root; otherwise
 * its parent directory must exist inside a root and the target must not be a (dangling) symlink.
 */
export async function resolveForWrite(roots: readonly string[], requested: string): Promise<ResolvedPath> {
  const req = assertValidRequest(requested);
  const candidates = lexicalCandidates(roots, req);
  if (candidates.length === 0) throw outside(req);

  for (const { candidate } of candidates) {
    const real = await tryRealpath(candidate);
    if (real === undefined) continue;
    const root = containingRoot(roots, real);
    if (!root) throw outside(req, 'it resolves through a symlink to a location outside the roots');
    const info = await stat(real);
    if (!info.isFile()) throw new ToolboxError('NOT_A_FILE', `"${req}" exists and is not a regular file`);
    return { absolute: real, root, relative: toRelative(real, root) };
  }

  for (const { candidate } of candidates) {
    const parentReal = await tryRealpath(path.dirname(candidate));
    if (parentReal === undefined) continue;
    const root = containingRoot(roots, parentReal);
    if (!root) throw outside(req, 'its parent directory resolves outside the roots');
    const absolute = path.join(parentReal, path.basename(candidate));
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw outside(req, 'refusing to write through a symlink');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return { absolute, root, relative: toRelative(absolute, root) };
  }
  throw new ToolboxError('NOT_FOUND', `parent directory of "${req}" does not exist under any allowed root`);
}
