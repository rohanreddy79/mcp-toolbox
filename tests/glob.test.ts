import { describe, expect, it } from 'vitest';
import { compileGlob, globMatches } from '../src/util/glob.js';

const match = (glob: string, file: string): boolean => globMatches(compileGlob(glob), file);

describe('glob', () => {
  it('matches basename-only patterns at any depth', () => {
    expect(match('*.md', 'README.md')).toBe(true);
    expect(match('*.md', 'docs/a/b.md')).toBe(true);
    expect(match('*.md', 'docs/a/b.mdx')).toBe(false);
    expect(match('?.txt', 'a.txt')).toBe(true);
    expect(match('?.txt', 'ab.txt')).toBe(false);
  });

  it('matches path patterns against the relative path', () => {
    expect(match('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(match('src/**/*.ts', 'src/c.ts')).toBe(true);
    expect(match('src/*.ts', 'src/a/c.ts')).toBe(false);
    expect(match('docs/**', 'docs/x/y.md')).toBe(true);
    expect(match('docs/**', 'other/y.md')).toBe(false);
  });

  it('supports alternation and classes, and escapes regex metacharacters', () => {
    expect(match('*.{ts,js}', 'a.js')).toBe(true);
    expect(match('*.{ts,js}', 'a.tsx')).toBe(false);
    expect(match('[ab].txt', 'b.txt')).toBe(true);
    expect(match('file.txt', 'fileXtxt')).toBe(false);
    expect(match('a+b.txt', 'a+b.txt')).toBe(true);
  });
});
