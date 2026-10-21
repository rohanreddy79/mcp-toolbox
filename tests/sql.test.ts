import { describe, expect, it } from 'vitest';
import { ToolboxError } from '../src/errors.js';
import { assertReadOnlyQuery, tokenizeSql } from '../src/safety/sql.js';

function rejection(sql: string): ToolboxError {
  try {
    assertReadOnlyQuery(sql);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolboxError);
    return err as ToolboxError;
  }
  throw new Error(`expected "${sql}" to be rejected`);
}

describe('tokenizeSql', () => {
  it('skips comments and keeps strings and quoted identifiers opaque', () => {
    const tokens = tokenizeSql(`SELECT "delete", 'DROP TABLE x' -- INSERT\n/* UPDATE */ FROM [t] WHERE a = :p AND b = ?`);
    expect(tokens.map((t) => t.kind)).toEqual([
      'word', 'identifier', 'punct', 'string', 'word', 'identifier', 'word', 'word', 'punct', 'parameter', 'word', 'word', 'punct', 'parameter',
    ]);
    expect(tokens[0]).toMatchObject({ kind: 'word', value: 'SELECT', offset: 0 });
  });

  it('upper-cases keywords and handles doubled-quote escapes', () => {
    const tokens = tokenizeSql(`select 'it''s' from "we""ird"`);
    expect(tokens.map((t) => t.value)).toEqual(['SELECT', `'it''s'`, 'FROM', `"we""ird"`]);
  });
});

describe('assertReadOnlyQuery accepts', () => {
  it.each([
    'SELECT 1',
    'select * from users where name = \'DROP TABLE users\'',
    'WITH recent AS (SELECT * FROM orders) SELECT count(*) FROM recent',
    'SELECT 1;',
    'SELECT 1 -- DELETE FROM users',
    'SELECT /* PRAGMA */ 1',
    'SELECT "delete", [update] FROM t',
    "SELECT replace(name, 'a', 'b') FROM t",
    'SELECT * FROM t WHERE id = ? AND name = :name',
    '  \n SELECT 1  \n',
  ])('%s', (sql) => {
    expect(() => assertReadOnlyQuery(sql)).not.toThrow();
  });

  it('strips exactly one trailing semicolon', () => {
    expect(assertReadOnlyQuery('SELECT 1 ;  ')).toBe('SELECT 1');
    expect(assertReadOnlyQuery('SELECT 1')).toBe('SELECT 1');
  });
});

describe('assertReadOnlyQuery rejects', () => {
  it.each([
    ['DROP TABLE users', /only SELECT or WITH/],
    ['SELECT 1; DELETE FROM users', /multiple statements/],
    ['SELECT 1;;', /multiple statements/],
    ['PRAGMA table_info(users)', /only SELECT or WITH/],
    ["INSERT INTO users VALUES (1, 'x')", /only SELECT or WITH/],
    ['WITH x AS (SELECT 1) DELETE FROM users', /keyword DELETE/],
    ['WITH x AS (SELECT 1) UPDATE users SET a = 1', /keyword UPDATE/],
    ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', /keyword INSERT/],
    ['WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x', /REPLACE INTO/],
    ["ATTACH DATABASE '/tmp/x.db' AS other", /only SELECT or WITH/],
    ['VACUUM', /only SELECT or WITH/],
    ['EXPLAIN SELECT 1', /only SELECT or WITH/],
    ['CREATE TABLE t (a)', /only SELECT or WITH/],
    ['SELECT 1 FROM t WHERE DROP = 1', /keyword DROP/],
    ['', /empty/],
    ['   ', /empty/],
    ['-- just a comment', /only comments/],
    ["SELECT 'unterminated", /unterminated string/],
    ['SELECT "unterminated', /unterminated quoted identifier/],
    ['SELECT /* unterminated', /unterminated block comment/],
  ])('%s', (sql, message) => {
    const err = rejection(sql);
    expect(err.code).toBe('SQL_REJECTED');
    expect(err.message).toMatch(message);
  });
});
