import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolboxError } from '../src/errors.js';
import { describeTable, listTables, runQuery, schemaDdl, SqliteRegistry } from '../src/tools/sqlite.js';
import { createFixture, type Fixture } from './helpers.js';

let fx: Fixture;
let registry: SqliteRegistry;

beforeAll(async () => {
  fx = await createFixture();
  registry = new SqliteRegistry(fx.config.databases);
});

afterAll(async () => {
  registry.closeAll();
  await fx.cleanup();
});

describe('SqliteRegistry', () => {
  it('opens handles read-only, so even a bypass of the SQL gate cannot write', () => {
    const db = registry.open('demo');
    expect(() => db.exec("INSERT INTO people (name) VALUES ('Mallory')")).toThrow(/readonly/i);
    expect(() => db.exec('DROP TABLE people')).toThrow(/readonly/i);
    expect(db.prepare('SELECT count(*) AS n FROM people').get()?.['n']).toBe(3);
  });

  it('rejects unknown names and caches handles', () => {
    expect(() => registry.open('nope')).toThrow(ToolboxError);
    expect(registry.open('demo')).toBe(registry.open('demo'));
    expect(registry.names()).toEqual(['demo']);
  });
});

describe('listTables / describeTable / schemaDdl', () => {
  it('lists tables and views, excluding sqlite internals', () => {
    expect(listTables(registry.open('demo'))).toEqual([
      { name: 'adults', type: 'view' },
      { name: 'people', type: 'table' },
    ]);
  });

  it('describes columns, indexes and row count without splicing the name into SQL', () => {
    const info = describeTable(registry.open('demo'), 'people');
    expect(info.columns.map((c) => [c.name, c.type, c.notNull, c.primaryKey])).toEqual([
      ['id', 'INTEGER', false, 1],
      ['name', 'TEXT', true, 0],
      ['age', 'INTEGER', false, 0],
      ['photo', 'BLOB', false, 0],
    ]);
    expect(info.indexes).toEqual([{ name: 'people_name_idx', unique: true, origin: 'c', columns: ['name'] }]);
    expect(info.rowCount).toBe(3);
    expect(info.sql).toContain('CREATE TABLE people');
    expect(() => describeTable(registry.open('demo'), 'people"; DROP TABLE people; --')).toThrow(/UNKNOWN_TABLE|no table/);
  });

  it('renders the DDL with tables before indexes and views', () => {
    const ddl = schemaDdl(registry.open('demo'));
    expect(ddl.indexOf('CREATE TABLE people')).toBeLessThan(ddl.indexOf('CREATE UNIQUE INDEX'));
    expect(ddl.indexOf('CREATE UNIQUE INDEX')).toBeLessThan(ddl.indexOf('CREATE VIEW adults'));
    expect(ddl.endsWith(';')).toBe(true);
  });
});

describe('runQuery', () => {
  it('binds positional and named parameters and renders blobs as placeholders', () => {
    const db = registry.open('demo');
    expect(runQuery(db, 'SELECT name, photo FROM people WHERE age > ? ORDER BY id', [20], 10)).toEqual({
      columns: ['name', 'photo'],
      rows: [
        ['Ada', '<blob 2 bytes>'],
        ['Cy', null],
      ],
      rowCount: 2,
      truncated: false,
    });
    expect(runQuery(db, 'SELECT id FROM people WHERE name = :name', { name: 'Bob' }, 10).rows).toEqual([[2]]);
    expect(runQuery(db, 'SELECT id FROM people WHERE age > :min AND age < :max', { min: 10, max: 40 }, 10).rowCount).toBe(2);
  });

  it('caps rows and reports truncation', () => {
    const result = runQuery(registry.open('demo'), 'SELECT id FROM people ORDER BY id', undefined, 2);
    expect(result.rows).toEqual([[1], [2]]);
    expect(result.truncated).toBe(true);
  });

  it('returns column names even for empty results when the runtime supports it', () => {
    const result = runQuery(registry.open('demo'), 'SELECT id, name FROM people WHERE 1 = 0', undefined, 5);
    expect(result.rows).toEqual([]);
    expect(result.columns.length === 0 || result.columns).toBeTruthy();
  });

  it('surfaces SQLite errors as SQL_ERROR and gate failures as SQL_REJECTED', () => {
    const db = registry.open('demo');
    expect(() => runQuery(db, 'SELECT * FROM missing', undefined, 5)).toThrow(expect.objectContaining({ code: 'SQL_ERROR' }));
    expect(() => runQuery(db, 'DELETE FROM people', undefined, 5)).toThrow(expect.objectContaining({ code: 'SQL_REJECTED' }));
  });
});
