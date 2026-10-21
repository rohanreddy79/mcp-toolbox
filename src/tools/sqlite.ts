/**
 * SQLite tools over the built-in `node:sqlite` (nothing native to compile). Every handle is opened
 * read-only; the statement-shape gate in safety/sql.ts is the second layer. The metadata lookups we
 * run ourselves go through the `pragma_*` table-valued functions with bound parameters, so a table
 * name supplied by the model is never spliced into SQL text.
 */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DATABASE_NAME } from '../config.js';
import { ToolboxError } from '../errors.js';
import { assertReadOnlyQuery } from '../safety/sql.js';
import { registerToolboxTool, type ServerContext } from '../tooling.js';

export class SqliteRegistry {
  private readonly handles = new Map<string, DatabaseSync>();

  constructor(private readonly databases: Record<string, string>) {}

  names(): string[] {
    return Object.keys(this.databases).sort();
  }

  /** Opens lazily and caches; the handle is read-only for the lifetime of the server. */
  open(name: string): DatabaseSync {
    const cached = this.handles.get(name);
    if (cached) return cached;
    const file = this.databases[name];
    if (file === undefined) {
      const known = this.names().join(', ') || 'none';
      throw new ToolboxError('UNKNOWN_DATABASE', `unknown database "${name}" (configured: ${known})`);
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true, enableDoubleQuotedStringLiterals: false });
    } catch (err) {
      throw new ToolboxError('SQL_ERROR', `cannot open database "${name}": ${(err as Error).message}`, { cause: err });
    }
    this.handles.set(name, db);
    return db;
  }

  closeAll(): void {
    for (const db of this.handles.values()) db.close();
    this.handles.clear();
  }
}

export interface TableRef {
  name: string;
  type: 'table' | 'view';
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: number;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
}

export interface TableDescription {
  name: string;
  type: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  rowCount: number;
  sql: string | null;
}

export type SqlParam = string | number | boolean | null;
export type SqlParams = SqlParam[] | Record<string, SqlParam>;

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlError(action: string, err: unknown): ToolboxError {
  return new ToolboxError('SQL_ERROR', `${action}: ${(err as Error).message}`, { cause: err });
}

export function listTables(db: DatabaseSync): TableRef[] {
  const rows = db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return rows.map((r) => ({ name: String(r['name']), type: r['type'] as TableRef['type'] }));
}

export function describeTable(db: DatabaseSync, table: string): TableDescription {
  const row = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(table);
  if (!row) throw new ToolboxError('UNKNOWN_TABLE', `no table or view named "${table}"`);
  const name = String(row['name']);

  const columns = db
    .prepare('SELECT name, type, "notnull" AS "notNull", dflt_value AS defaultValue, pk FROM pragma_table_info(?)')
    .all(name)
    .map((c) => ({
      name: String(c['name']),
      type: String(c['type'] ?? ''),
      notNull: c['notNull'] === 1,
      defaultValue: c['defaultValue'] === null || c['defaultValue'] === undefined ? null : String(c['defaultValue']),
      primaryKey: Number(c['pk']),
    }));

  const indexes = db
    .prepare('SELECT name, "unique" AS isUnique, origin FROM pragma_index_list(?)')
    .all(name)
    .map((ix) => ({
      name: String(ix['name']),
      unique: ix['isUnique'] === 1,
      origin: String(ix['origin']),
      columns: db
        .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(String(ix['name']))
        .map((c) => (c['name'] === null ? '<expression>' : String(c['name']))),
    }));

  const count = db.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(name)}`).get();
  return {
    name,
    type: String(row['type']),
    columns,
    indexes,
    rowCount: Number(count?.['n'] ?? 0),
    sql: row['sql'] === null ? null : String(row['sql']),
  };
}

function toBinding(value: SqlParam): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function toJsonValue(value: SQLOutputValue): unknown {
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  return value;
}

/** Column names straight from the statement when the runtime offers `columns()` (Node >= 22.16). */
function statementColumns(stmt: StatementSync): string[] | undefined {
  const withColumns = stmt as unknown as { columns?: () => Array<{ name: string }> };
  return typeof withColumns.columns === 'function' ? withColumns.columns().map((c) => c.name) : undefined;
}

export function runQuery(db: DatabaseSync, sql: string, params: SqlParams | undefined, maxRows: number): QueryResult {
  const cleaned = assertReadOnlyQuery(sql);
  let stmt: StatementSync;
  try {
    stmt = db.prepare(cleaned);
  } catch (err) {
    throw sqlError('cannot prepare statement', err);
  }

  let columns = statementColumns(stmt) ?? [];
  const rows: unknown[][] = [];
  let truncated = false;
  try {
    const iterator =
      params === undefined
        ? stmt.iterate()
        : Array.isArray(params)
          ? stmt.iterate(...params.map(toBinding))
          : stmt.iterate(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, toBinding(v)])));
    for (const row of iterator) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      if (columns.length === 0) columns = Object.keys(row);
      rows.push(columns.map((c) => toJsonValue(row[c] ?? null)));
    }
  } catch (err) {
    throw sqlError('query failed', err);
  }
  return { columns, rows, rowCount: rows.length, truncated };
}

/** Full DDL of the database, tables first, as one `;`-separated script. */
export function schemaDdl(db: DatabaseSync): string {
  const rows = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name",
    )
    .all();
  return rows.map((r) => `${String(r['sql'])};`).join('\n\n');
}

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function registerSqliteTools(server: McpServer, ctx: ServerContext): void {
  const configured = ctx.databases.names().join(', ') || 'none configured';
  const database = z.string().regex(DATABASE_NAME).describe(`Configured database name (${configured})`);

  registerToolboxTool(
    server,
    ctx,
    'sqlite_list_tables',
    {
      title: 'List SQLite tables',
      description: 'Lists the tables and views of a configured SQLite database.',
      inputSchema: { database },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => ({ json: { database: args.database, tables: listTables(ctx.databases.open(args.database)) } }),
  );

  registerToolboxTool(
    server,
    ctx,
    'sqlite_describe_table',
    {
      title: 'Describe a SQLite table',
      description: 'Columns (name, type, nullability, default, primary key), indexes, row count and DDL of one table or view.',
      inputSchema: { database, table: z.string().min(1).max(256).describe('Table or view name') },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => ({ json: describeTable(ctx.databases.open(args.database), args.table) }),
  );

  registerToolboxTool(
    server,
    ctx,
    'sqlite_query',
    {
      title: 'Run a read-only SQL query',
      description:
        'Runs a single SELECT or WITH statement against a read-only SQLite handle. Supports positional (?) and ' +
        `named (:name) parameters. Returns at most maxRows rows (default ${ctx.config.maxRows}). ` +
        'Statements that write, chain with ";" or use PRAGMA/ATTACH are rejected.',
      inputSchema: {
        database,
        sql: z.string().min(1).max(20_000).describe('A single SELECT or WITH statement'),
        params: z
          .union([z.array(scalar), z.record(z.string(), scalar)])
          .optional()
          .describe('Positional array for ? placeholders or object for :name placeholders'),
        maxRows: z.number().int().positive().max(ctx.config.maxRows).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => ({
      json: runQuery(ctx.databases.open(args.database), args.sql, args.params, args.maxRows ?? ctx.config.maxRows),
    }),
  );
}
