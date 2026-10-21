#!/usr/bin/env node
/**
 * CLI entry point. Logs only to stderr because stdout is the stdio protocol channel.
 *
 *   mcp-toolbox [--config toolbox.config.json] [--root DIR]... [--db NAME=PATH]... [--allow-host HOST]...
 *               [--max-bytes N] [--max-rows N] [--write-enabled] [--audit-log FILE]
 *               [--http] [--port 3333] [--host 127.0.0.1]
 */
import { access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig, type ConfigFileInput, type ToolboxConfig } from './config.js';
import { isToolboxError } from './errors.js';
import { createToolboxServer, SERVER_NAME, SERVER_VERSION, type ToolboxServer } from './server.js';
import { serveHttp } from './transports/http.js';
import { serveStdio } from './transports/stdio.js';

const DEFAULT_CONFIG_FILE = 'toolbox.config.json';
const DEFAULT_PORT = 3333;
const DEFAULT_HOST = '127.0.0.1';

const USAGE = `Usage: ${SERVER_NAME} [options]

Transport (stdio is the default):
  --http                 serve Streamable HTTP instead of stdio
  --port <n>             HTTP port (default ${DEFAULT_PORT})
  --host <addr>          HTTP bind address (default ${DEFAULT_HOST})

Configuration (flags are merged on top of the config file):
  -c, --config <file>    JSON config (default: ./${DEFAULT_CONFIG_FILE} when it exists)
  --root <dir>           allow a filesystem root (repeatable)
  --db <name=path>       expose a SQLite file under <name> (repeatable)
  --allow-host <host>    allow http_fetch to <host> or *.<domain> (repeatable)
  --max-bytes <n>        cap for file reads, writes and fetched bodies
  --max-rows <n>         cap for sqlite_query rows
  --write-enabled        enable fs_write (off by default)
  --audit-log <file>     append one JSON line per call to <file>

  -h, --help             show this help
  -v, --version          print the version
`;

export interface ParsedCli {
  configPath: string | undefined;
  overrides: ConfigFileInput;
  http: boolean;
  port: number;
  host: string;
}

function parseInteger(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer (got "${value}")`);
  return n;
}

export function parseCli(argv: string[]): ParsedCli | 'help' | 'version' {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      config: { type: 'string', short: 'c' },
      root: { type: 'string', multiple: true },
      db: { type: 'string', multiple: true },
      'allow-host': { type: 'string', multiple: true },
      'max-bytes': { type: 'string' },
      'max-rows': { type: 'string' },
      'write-enabled': { type: 'boolean' },
      'audit-log': { type: 'string' },
      http: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) return 'help';
  if (values.version) return 'version';

  const databases: Record<string, string> = {};
  for (const spec of values.db ?? []) {
    const eq = spec.indexOf('=');
    if (eq <= 0) throw new Error(`--db expects NAME=PATH (got "${spec}")`);
    databases[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  const overrides: ConfigFileInput = {};
  if (values.root?.length) overrides.roots = values.root;
  if (Object.keys(databases).length > 0) overrides.databases = databases;
  if (values['allow-host']?.length) overrides.allowedHosts = values['allow-host'];
  const maxBytes = parseInteger('--max-bytes', values['max-bytes']);
  if (maxBytes !== undefined) overrides.maxBytes = maxBytes;
  const maxRows = parseInteger('--max-rows', values['max-rows']);
  if (maxRows !== undefined) overrides.maxRows = maxRows;
  if (values['write-enabled']) overrides.writeEnabled = true;
  if (values['audit-log'] !== undefined) overrides.auditLog = values['audit-log'];

  return {
    configPath: values.config,
    overrides,
    http: values.http ?? false,
    port: parseInteger('--port', values.port) ?? DEFAULT_PORT,
    host: values.host ?? DEFAULT_HOST,
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function describeConfig(config: ToolboxConfig): string {
  return [
    `roots: ${config.roots.join(', ') || 'none'}`,
    `databases: ${Object.keys(config.databases).join(', ') || 'none'}`,
    `allowedHosts: ${config.allowedHosts.join(', ') || 'none'}`,
    `writeEnabled: ${config.writeEnabled}`,
    `auditLog: ${config.auditLog ?? 'off'}`,
  ].join(' | ');
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseCli(argv);
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed === 'version') {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }

  const configPath = parsed.configPath ?? ((await fileExists(DEFAULT_CONFIG_FILE)) ? DEFAULT_CONFIG_FILE : undefined);
  const config = await loadConfig({ configPath, overrides: parsed.overrides });
  const log = (message: string): void => {
    process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
  };
  log(`${SERVER_VERSION} | ${describeConfig(config)}`);
  const factory = (): ToolboxServer => createToolboxServer(config);

  if (parsed.http) {
    const running = await serveHttp(factory, { host: parsed.host, port: parsed.port, log });
    log(`listening on ${running.url}`);
    const shutdown = (): void => {
      log('shutting down');
      running.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  const toolbox = await serveStdio(factory);
  log('serving over stdio');
  toolbox.server.server.onclose = () => {
    toolbox.context.databases.closeAll();
    toolbox.context.audit.flush().then(() => process.exit(0), () => process.exit(1));
  };
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = isToolboxError(err) ? err.toString() : err instanceof Error ? err.message : String(err);
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
  process.exit(1);
});
