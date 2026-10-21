/**
 * Minimal glob matcher for `fs_search` include/exclude filters. Supports `*` (within one segment),
 * `**` (any depth), `?`, `{a,b}` alternation and `[...]` classes. Patterns without a `/` are matched
 * against the file name at any depth (ripgrep's `-g` convention); patterns with a `/` are matched
 * against the root-relative posix path.
 */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function globBody(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        let j = i + 2;
        if (glob[j] === '/') {
          out += '(?:.*/)?';
          j += 1;
        } else {
          out += '.*';
        }
        i = j;
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        out += escapeRegExp(c);
        i += 1;
      } else {
        const alternatives = glob.slice(i + 1, end).split(',').map(globBody);
        out += `(?:${alternatives.join('|')})`;
        i = end + 1;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) {
        out += escapeRegExp(c);
        i += 1;
      } else {
        out += glob.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      out += escapeRegExp(c);
      i += 1;
    }
  }
  return out;
}

export interface CompiledGlob {
  source: string;
  regexp: RegExp;
  /** When true the pattern is tested against the base name instead of the full relative path. */
  basenameOnly: boolean;
}

export function compileGlob(glob: string): CompiledGlob {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  return {
    source: glob,
    regexp: new RegExp(`^${globBody(normalized)}$`),
    basenameOnly: !normalized.includes('/'),
  };
}

export function globMatches(compiled: CompiledGlob, relativePath: string): boolean {
  const subject = compiled.basenameOnly ? relativePath.slice(relativePath.lastIndexOf('/') + 1) : relativePath;
  return compiled.regexp.test(subject);
}

export function matchesAnyGlob(patterns: readonly CompiledGlob[], relativePath: string): boolean {
  return patterns.some((p) => globMatches(p, relativePath));
}
