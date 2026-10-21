/**
 * Append-only JSON Lines audit log: one line per tool call, resource read or prompt render.
 * Writes are serialised through a promise chain so lines never interleave, and argument values are
 * summarised (long strings truncated) so the log stays readable and never stores whole file bodies.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { truncate } from './util/text.js';

export type AuditKind = 'tool' | 'resource' | 'prompt';

export interface AuditEntry {
  ts: string;
  kind: AuditKind;
  name: string;
  args: unknown;
  ok: boolean;
  error?: string;
  ms: number;
}

const MAX_STRING = 160;
const MAX_ITEMS = 20;
const MAX_DEPTH = 3;

export function summarizeArgs(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return truncate(value, MAX_STRING);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => summarizeArgs(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `… ${value.length - MAX_ITEMS} more`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = summarizeArgs(v, depth + 1);
  return out;
}

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private directoryReady = false;
  readonly entries: AuditEntry[] = [];

  /**
   * @param filePath JSONL file to append to; when undefined, entries are only kept in memory.
   * @param onError  Called when a write fails; the server keeps running because auditing must not
   *                 take the tools down, but the failure is surfaced on stderr.
   * @param keepInMemory Retain entries on the instance (tests use this; disabled for long-running servers).
   */
  constructor(
    private readonly filePath: string | undefined,
    private readonly onError: (err: unknown) => void = (err) => console.error('[mcp-toolbox] audit write failed:', err),
    private readonly keepInMemory = false,
  ) {}

  record(entry: Omit<AuditEntry, 'ts' | 'args'> & { args: unknown }): void {
    const line: AuditEntry = { ts: new Date().toISOString(), ...entry, args: summarizeArgs(entry.args) };
    if (this.keepInMemory) this.entries.push(line);
    if (this.filePath === undefined) return;
    const file = this.filePath;
    this.queue = this.queue
      .then(async () => {
        if (!this.directoryReady) {
          await mkdir(path.dirname(file), { recursive: true });
          this.directoryReady = true;
        }
        await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
      })
      .catch(this.onError);
  }

  /** Resolves once every queued line has been written. */
  flush(): Promise<void> {
    return this.queue;
  }
}
