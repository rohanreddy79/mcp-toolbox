/**
 * Configuration: a JSON file (`toolbox.config.json`) merged with CLI overrides, validated with zod,
 * then resolved to absolute realpaths. Relative paths in the file are relative to the file's
 * directory; relative paths from CLI flags are relative to the working directory. Roots and database
 * files must exist at load time so misconfiguration fails fast instead of at the first tool call.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ToolboxError } from './errors.js';

export const DATABASE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export const ConfigFileSchema = z
  .object({
    roots: z.array(z.string().min(1)).default([]),
    databases: z.record(z.string().regex(DATABASE_NAME, 'database names are [A-Za-z0-9_-]'), z.string().min(1)).default({}),
    allowedHosts: z.array(z.string().min(1)).default([]),
    maxBytes: z.number().int().positive().default(1_048_576),
    maxRows: z.number().int().positive().max(10_000).default(500),
    writeEnabled: z.boolean().default(false),
    auditLog: z.string().min(1).optional(),
    fetchTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
    ignore: z.array(z.string().min(1)).default(['.git', 'node_modules']),
  })
  .strict();

export type ConfigFileInput = z.input<typeof ConfigFileSchema>;

/** Fully resolved runtime configuration. Paths are absolute; roots are realpaths. */
export interface ToolboxConfig {
  roots: string[];
  databases: Record<string, string>;
  allowedHosts: string[];
  maxBytes: number;
  maxRows: number;
  writeEnabled: boolean;
  auditLog: string | undefined;
  fetchTimeoutMs: number;
  ignore: string[];
}

export interface LoadConfigOptions {
  /** JSON config file. Optional: a server can be configured entirely from `overrides`. */
  configPath?: string;
  /** CLI-level values. Lists are appended to the file's lists; scalars replace them. */
  overrides?: ConfigFileInput;
  /** Base directory for relative paths in `overrides` (defaults to `process.cwd()`). */
  cwd?: string;
}

function invalid(message: string, cause?: unknown): ToolboxError {
  return new ToolboxError('CONFIG_INVALID', message, { cause });
}

function parseConfigObject(raw: unknown, source: string): z.output<typeof ConfigFileSchema> {
  const result = ConfigFileSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
  throw invalid(`${source}: ${issues}`);
}

/**
 * Pure merge step: parses both inputs, resolves every path against its own base directory and applies
 * the list-append / scalar-override rule. No filesystem access, so it is unit-testable in isolation.
 */
export function mergeConfig(
  fileRaw: unknown,
  fileDir: string,
  overridesRaw: ConfigFileInput | undefined,
  cwd: string,
): ToolboxConfig {
  const file = parseConfigObject(fileRaw ?? {}, 'config file');
  const over = parseConfigObject(overridesRaw ?? {}, 'command line');
  const resolveFile = (p: string): string => path.resolve(fileDir, p);
  const resolveCli = (p: string): string => path.resolve(cwd, p);

  const databases: Record<string, string> = {};
  for (const [name, p] of Object.entries(file.databases)) databases[name] = resolveFile(p);
  for (const [name, p] of Object.entries(over.databases)) databases[name] = resolveCli(p);

  const overridesGiven = overridesRaw ?? {};
  const pick = <K extends keyof z.output<typeof ConfigFileSchema>>(key: K): z.output<typeof ConfigFileSchema>[K] =>
    key in overridesGiven && overridesGiven[key] !== undefined ? over[key] : file[key];

  const auditRaw = overridesGiven.auditLog ?? file.auditLog;
  const auditLog =
    auditRaw === undefined ? undefined : overridesGiven.auditLog !== undefined ? resolveCli(auditRaw) : resolveFile(auditRaw);

  return {
    roots: [...file.roots.map(resolveFile), ...over.roots.map(resolveCli)],
    databases,
    allowedHosts: [...file.allowedHosts, ...over.allowedHosts],
    maxBytes: pick('maxBytes'),
    maxRows: pick('maxRows'),
    writeEnabled: file.writeEnabled || over.writeEnabled,
    auditLog,
    fetchTimeoutMs: pick('fetchTimeoutMs'),
    ignore: 'ignore' in overridesGiven && overridesGiven.ignore !== undefined ? over.ignore : file.ignore,
  };
}

/** Checks that roots are directories and databases are files, and canonicalises roots to realpaths. */
export async function finalizeConfig(config: ToolboxConfig): Promise<ToolboxConfig> {
  const roots: string[] = [];
  for (const root of config.roots) {
    let real: string;
    try {
      real = await realpath(root);
    } catch (err) {
      throw invalid(`root "${root}" does not exist`, err);
    }
    if (!(await stat(real)).isDirectory()) throw invalid(`root "${root}" is not a directory`);
    if (!roots.includes(real)) roots.push(real);
  }
  for (const [name, file] of Object.entries(config.databases)) {
    try {
      if (!(await stat(file)).isFile()) throw invalid(`database "${name}" (${file}) is not a file`);
    } catch (err) {
      if (err instanceof ToolboxError) throw err;
      throw invalid(`database "${name}" (${file}) does not exist`, err);
    }
  }
  return { ...config, roots };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ToolboxConfig> {
  const cwd = options.cwd ?? process.cwd();
  let fileRaw: unknown = {};
  let fileDir = cwd;
  if (options.configPath !== undefined) {
    const abs = path.resolve(cwd, options.configPath);
    fileDir = path.dirname(abs);
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch (err) {
      throw invalid(`cannot read config file ${abs}`, err);
    }
    try {
      fileRaw = JSON.parse(text) as unknown;
    } catch (err) {
      throw invalid(`config file ${abs} is not valid JSON: ${(err as Error).message}`, err);
    }
  }
  return finalizeConfig(mergeConfig(fileRaw, fileDir, options.overrides, cwd));
}
