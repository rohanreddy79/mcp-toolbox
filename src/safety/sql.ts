/**
 * Read-only SQL gate for `sqlite_query`.
 *
 * The database handle is already opened read-only, but we still refuse anything that is not a single
 * SELECT/WITH statement so surprising statements never reach SQLite at all. The check is token based:
 * string literals, quoted identifiers and comments are skipped, so `SELECT 'DROP'` passes while
 * `SELECT 1; DROP TABLE t` and `WITH x AS (...) DELETE FROM t` are rejected.
 */
import { ToolboxError } from '../errors.js';

export type SqlTokenKind = 'word' | 'string' | 'identifier' | 'number' | 'parameter' | 'punct';

export interface SqlToken {
  kind: SqlTokenKind;
  /** Keywords are upper-cased; everything else is the raw source slice. */
  value: string;
  offset: number;
}

/** Keywords that can never appear in a read-only query, matched as whole tokens. */
export const BLOCKED_KEYWORDS: ReadonlySet<string> = new Set([
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'REINDEX',
]);

const ALLOWED_FIRST: ReadonlySet<string> = new Set(['SELECT', 'WITH']);

function reject(reason: string): ToolboxError {
  return new ToolboxError('SQL_REJECTED', reason);
}

const isWordStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Returns the index just past the closing quote, honouring doubled-quote escapes (`''`, `""`). */
function scanQuoted(sql: string, start: number, quote: string, what: string): number {
  let i = start + 1;
  for (;;) {
    const idx = sql.indexOf(quote, i);
    if (idx === -1) throw reject(`unterminated ${what}`);
    if (sql[idx + 1] === quote) {
      i = idx + 2;
      continue;
    }
    return idx + 1;
  }
}

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw reject('unterminated block comment');
      i = end + 2;
    } else if (c === "'") {
      const end = scanQuoted(sql, i, "'", 'string literal');
      tokens.push({ kind: 'string', value: sql.slice(i, end), offset: i });
      i = end;
    } else if (c === '"' || c === '`') {
      const end = scanQuoted(sql, i, c, 'quoted identifier');
      tokens.push({ kind: 'identifier', value: sql.slice(i, end), offset: i });
      i = end;
    } else if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) throw reject('unterminated [identifier]');
      tokens.push({ kind: 'identifier', value: sql.slice(i, end + 1), offset: i });
      i = end + 1;
    } else if (c === '?' || c === ':' || c === '@' || c === '$') {
      let j = i + 1;
      while (j < n && isWordChar(sql[j]!)) j += 1;
      tokens.push({ kind: 'parameter', value: sql.slice(i, j), offset: i });
      i = j;
    } else if (isDigit(c) || (c === '.' && isDigit(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j]!)) j += 1;
      tokens.push({ kind: 'number', value: sql.slice(i, j), offset: i });
      i = j;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j]!)) j += 1;
      tokens.push({ kind: 'word', value: sql.slice(i, j).toUpperCase(), offset: i });
      i = j;
    } else {
      tokens.push({ kind: 'punct', value: c, offset: i });
      i += 1;
    }
  }
  return tokens;
}

/**
 * Validates that `sql` is a single read-only statement and returns it with any trailing semicolon
 * removed. Throws `ToolboxError('SQL_REJECTED')` otherwise.
 */
export function assertReadOnlyQuery(sql: string): string {
  if (typeof sql !== 'string' || sql.trim() === '') throw reject('statement is empty');
  const tokens = tokenizeSql(sql);
  if (tokens.length === 0) throw reject('statement contains only comments or whitespace');

  let body = tokens;
  let cleaned = sql.trim();
  const last = tokens[tokens.length - 1]!;
  if (last.kind === 'punct' && last.value === ';') {
    body = tokens.slice(0, -1);
    cleaned = sql.slice(0, last.offset).trim();
  }

  const chained = body.find((t) => t.kind === 'punct' && t.value === ';');
  if (chained) {
    throw reject(`multiple statements are not allowed (";" at offset ${chained.offset})`);
  }

  const first = body[0];
  if (!first || first.kind !== 'word' || !ALLOWED_FIRST.has(first.value)) {
    const got = first ? first.value : '';
    throw reject(`only SELECT or WITH statements are allowed (statement starts with "${got}")`);
  }

  for (let i = 0; i < body.length; i += 1) {
    const token = body[i]!;
    if (token.kind !== 'word') continue;
    if (BLOCKED_KEYWORDS.has(token.value)) {
      throw reject(`keyword ${token.value} is not allowed in a read-only query`);
    }
    // REPLACE is also a scalar function, so only the `REPLACE INTO` statement form is blocked.
    if (token.value === 'REPLACE' && body[i + 1]?.kind === 'word' && body[i + 1]?.value === 'INTO') {
      throw reject('REPLACE INTO is not allowed in a read-only query');
    }
  }
  return cleaned;
}
