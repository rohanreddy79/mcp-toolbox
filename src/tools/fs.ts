/**
 * Filesystem tools. Every path goes through safety/paths.ts first; directory walks never follow
 * symlinks (they are reported as entries), so a walk cannot leave its root even through a link.
 */
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolboxError } from '../errors.js';
import { resolveExisting, resolveForWrite, toRelative, type ResolvedPath } from '../safety/paths.js';
import { registerToolboxTool, type ServerContext } from '../tooling.js';
import { compileGlob, matchesAnyGlob, type CompiledGlob } from '../util/glob.js';
import { looksBinary } from '../util/text.js';

export interface FsEntry {
  root: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

export interface WalkOptions {
  maxDepth: number;
  ignore: readonly string[];
}

const BINARY_SAMPLE_BYTES = 8192;
const SEARCH_MAX_DEPTH = 64;

/**
 * Depth-first, name-sorted walk. `onEntry` returns false to stop early. Unreadable subdirectories are
 * skipped rather than aborting the whole listing; the top-level directory itself must be readable.
 */
export async function walk(
  dirAbs: string,
  root: string,
  opts: WalkOptions,
  onEntry: (entry: FsEntry) => Promise<boolean> | boolean,
): Promise<void> {
  const visit = async (dir: string, depth: number): Promise<boolean> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 1) throw err;
      return true;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (opts.ignore.includes(dirent.name)) continue;
      const abs = path.join(dir, dirent.name);
      const rel = toRelative(abs, root);
      let entry: FsEntry;
      if (dirent.isSymbolicLink()) entry = { root, path: rel, type: 'symlink' };
      else if (dirent.isDirectory()) entry = { root, path: rel, type: 'dir' };
      else if (dirent.isFile()) entry = { root, path: rel, type: 'file', size: (await stat(abs)).size };
      else entry = { root, path: rel, type: 'other' };
      if (!(await onEntry(entry))) return false;
      if (entry.type === 'dir' && depth < opts.maxDepth && !(await visit(abs, depth + 1))) return false;
    }
    return true;
  };
  await visit(dirAbs, 1);
}

export interface ListResult {
  entries: FsEntry[];
  truncated: boolean;
}

export async function listDirectory(resolved: ResolvedPath, opts: WalkOptions & { maxEntries: number }): Promise<ListResult> {
  const info = await stat(resolved.absolute);
  if (!info.isDirectory()) throw new ToolboxError('NOT_A_DIRECTORY', `"${resolved.relative || '.'}" is not a directory`);
  const entries: FsEntry[] = [];
  let truncated = false;
  await walk(resolved.absolute, resolved.root, opts, (entry) => {
    if (entries.length >= opts.maxEntries) {
      truncated = true;
      return false;
    }
    entries.push(entry);
    return true;
  });
  return { entries, truncated };
}

async function assertTextFile(resolved: ResolvedPath): Promise<void> {
  const handle = await open(resolved.absolute, 'r');
  try {
    const buffer = new Uint8Array(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SAMPLE_BYTES, 0);
    if (looksBinary(buffer.subarray(0, bytesRead))) {
      throw new ToolboxError('BINARY_FILE', `"${resolved.relative}" looks binary (NUL byte in the first ${BINARY_SAMPLE_BYTES} bytes)`);
    }
  } finally {
    await handle.close();
  }
}

export interface ReadOptions {
  maxBytes: number;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

export interface ReadResult {
  path: string;
  root: string;
  bytes: number;
  text: string;
  startLine?: number;
  endLine?: number;
}

export async function readTextFile(resolved: ResolvedPath, opts: ReadOptions): Promise<ReadResult> {
  const info = await stat(resolved.absolute);
  if (!info.isFile()) throw new ToolboxError('NOT_A_FILE', `"${resolved.relative}" is not a regular file`);
  await assertTextFile(resolved);

  if (opts.startLine === undefined && opts.endLine === undefined) {
    if (info.size > opts.maxBytes) {
      throw new ToolboxError(
        'SIZE_CAP',
        `"${resolved.relative}" is ${info.size} bytes, above the ${opts.maxBytes}-byte cap; pass startLine/endLine to read a slice`,
      );
    }
    const text = await readFile(resolved.absolute, 'utf8');
    return { path: resolved.relative, root: resolved.root, bytes: info.size, text };
  }

  const start = opts.startLine ?? 1;
  const end = opts.endLine ?? Number.POSITIVE_INFINITY;
  if (start < 1 || end < start) throw new ToolboxError('INVALID_ARGUMENT', 'startLine must be >= 1 and endLine >= startLine');

  // Stream so that a slice of a file far above the cap is still readable.
  const reader = readline.createInterface({ input: createReadStream(resolved.absolute, { encoding: 'utf8' }), crlfDelay: Infinity });
  const lines: string[] = [];
  let lineNo = 0;
  let bytes = 0;
  let capped = false;
  for await (const line of reader) {
    lineNo += 1;
    if (lineNo < start) continue;
    if (lineNo > end) break;
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (bytes > opts.maxBytes) {
      capped = true;
      break;
    }
    lines.push(line);
  }
  if (capped) throw new ToolboxError('SIZE_CAP', `the requested line range exceeds the ${opts.maxBytes}-byte cap; narrow it`);
  return { path: resolved.relative, root: resolved.root, bytes, text: lines.join('\n'), startLine: start, endLine: start + lines.length - 1 };
}

export interface SearchOptions {
  pattern: string;
  ignoreCase: boolean;
  include: readonly string[];
  exclude: readonly string[];
  maxMatches: number;
  contextLines: number;
  maxBytes: number;
  ignore: readonly string[];
}

export interface SearchMatch {
  root: string;
  path: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface SearchResult {
  matches: SearchMatch[];
  filesScanned: number;
  filesSkipped: number;
  truncated: boolean;
}

function compileSearchRegExp(pattern: string, ignoreCase: boolean): RegExp {
  if (pattern.length > 512) throw new ToolboxError('INVALID_ARGUMENT', 'pattern is longer than 512 characters');
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new ToolboxError('INVALID_ARGUMENT', `invalid regular expression: ${(err as Error).message}`, { cause: err });
  }
}

export async function searchFiles(dirs: readonly ResolvedPath[], opts: SearchOptions): Promise<SearchResult> {
  const regexp = compileSearchRegExp(opts.pattern, opts.ignoreCase);
  const include: CompiledGlob[] = opts.include.map(compileGlob);
  const exclude: CompiledGlob[] = opts.exclude.map(compileGlob);
  const result: SearchResult = { matches: [], filesScanned: 0, filesSkipped: 0, truncated: false };

  const scanFile = async (entry: FsEntry): Promise<boolean> => {
    if (entry.type !== 'file') return true;
    if (include.length > 0 && !matchesAnyGlob(include, entry.path)) return true;
    if (exclude.length > 0 && matchesAnyGlob(exclude, entry.path)) return true;
    if ((entry.size ?? 0) > opts.maxBytes) {
      result.filesSkipped += 1;
      return true;
    }
    const buffer = await readFile(path.join(entry.root, entry.path));
    if (looksBinary(buffer.subarray(0, BINARY_SAMPLE_BYTES))) {
      result.filesSkipped += 1;
      return true;
    }
    result.filesScanned += 1;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!regexp.test(lines[i]!)) continue;
      if (result.matches.length >= opts.maxMatches) {
        result.truncated = true;
        return false;
      }
      result.matches.push({
        root: entry.root,
        path: entry.path,
        line: i + 1,
        text: lines[i]!,
        before: lines.slice(Math.max(0, i - opts.contextLines), i),
        after: lines.slice(i + 1, i + 1 + opts.contextLines),
      });
    }
    return true;
  };

  for (const dir of dirs) {
    const info = await stat(dir.absolute);
    if (info.isFile()) {
      await scanFile({ root: dir.root, path: dir.relative, type: 'file', size: info.size });
      continue;
    }
    await walk(dir.absolute, dir.root, { maxDepth: SEARCH_MAX_DEPTH, ignore: opts.ignore }, scanFile);
    if (result.truncated) break;
  }
  return result;
}

export async function writeTextFile(resolved: ResolvedPath, content: string, maxBytes: number): Promise<{ path: string; root: string; bytes: number }> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxBytes) throw new ToolboxError('SIZE_CAP', `content is ${bytes} bytes, above the ${maxBytes}-byte cap`);
  await writeFile(resolved.absolute, content, 'utf8');
  return { path: resolved.relative, root: resolved.root, bytes };
}

const pathArg = z.string().min(1).describe('Root-relative path (e.g. "notes/todo.md") or an absolute path inside a root');

export function registerFsTools(server: McpServer, ctx: ServerContext): void {
  const { config } = ctx;

  registerToolboxTool(
    server,
    ctx,
    'fs_list',
    {
      title: 'List files',
      description: `Lists a directory recursively (default depth 2). Omit path to list every allowed root. Ignores ${config.ignore.join(', ')}.`,
      inputSchema: {
        path: pathArg.optional(),
        depth: z.number().int().min(1).max(8).optional().describe('Recursion depth, default 2'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const targets = args.path === undefined ? config.roots.map((r) => ({ absolute: r, root: r, relative: '' })) : [await resolveExisting(config.roots, args.path)];
      const listings = [];
      for (const target of targets) {
        const { entries, truncated } = await listDirectory(target, { maxDepth: args.depth ?? 2, ignore: config.ignore, maxEntries: 2000 });
        listings.push({ root: target.root, path: target.relative || '.', entries, truncated });
      }
      return { json: listings.length === 1 ? listings[0] : listings };
    },
  );

  registerToolboxTool(
    server,
    ctx,
    'fs_read',
    {
      title: 'Read a text file',
      description: `Reads a UTF-8 text file (binary files are refused, cap ${config.maxBytes} bytes). Use startLine/endLine (1-based, inclusive) to read a slice of a large file.`,
      inputSchema: {
        path: pathArg,
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const resolved = await resolveExisting(config.roots, args.path);
      const result = await readTextFile(resolved, { maxBytes: config.maxBytes, startLine: args.startLine, endLine: args.endLine });
      if (result.startLine === undefined) return result.text;
      return `[${result.path}: lines ${result.startLine}-${result.endLine}]\n${result.text}`;
    },
  );

  registerToolboxTool(
    server,
    ctx,
    'fs_search',
    {
      title: 'Search file contents',
      description: 'Regex search over text files under a directory (default: every root), with glob include/exclude filters and optional context lines.',
      inputSchema: {
        pattern: z.string().min(1).max(512).describe('JavaScript regular expression, matched per line'),
        path: pathArg.optional(),
        include: z.array(z.string().min(1)).optional().describe('Globs such as "*.md" or "src/**/*.ts"'),
        exclude: z.array(z.string().min(1)).optional(),
        maxMatches: z.number().int().min(1).max(1000).optional().describe('Default 100'),
        contextLines: z.number().int().min(0).max(10).optional().describe('Lines of context before and after each match, default 0'),
        ignoreCase: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const dirs = args.path === undefined ? config.roots.map((r) => ({ absolute: r, root: r, relative: '' })) : [await resolveExisting(config.roots, args.path)];
      const result = await searchFiles(dirs, {
        pattern: args.pattern,
        ignoreCase: args.ignoreCase ?? false,
        include: args.include ?? [],
        exclude: args.exclude ?? [],
        maxMatches: args.maxMatches ?? 100,
        contextLines: args.contextLines ?? 0,
        maxBytes: config.maxBytes,
        ignore: config.ignore,
      });
      return { json: result };
    },
  );

  registerToolboxTool(
    server,
    ctx,
    'fs_write',
    {
      title: 'Write a text file',
      description: config.writeEnabled
        ? `Creates or overwrites a UTF-8 text file inside an allowed root (cap ${config.maxBytes} bytes). The parent directory must exist.`
        : 'Disabled: the server was started without writeEnabled, so every call is rejected with [WRITE_DISABLED].',
      inputSchema: { path: pathArg, content: z.string().max(config.maxBytes) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      if (!config.writeEnabled) {
        throw new ToolboxError('WRITE_DISABLED', 'writes are disabled; start the server with --write-enabled or "writeEnabled": true');
      }
      const resolved = await resolveForWrite(config.roots, args.path);
      return { json: await writeTextFile(resolved, args.content, config.maxBytes) };
    },
  );
}
