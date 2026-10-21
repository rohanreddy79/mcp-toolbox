/**
 * Tiny HTML-to-text converter for `http_fetch`. Regex based on purpose: it has no dependencies, it
 * only needs to produce something an LLM can read, and it never executes or re-emits markup.
 * Known gap: whitespace inside <pre> is collapsed like everywhere else.
 */
const DROP_WITH_CONTENT = ['script', 'style', 'noscript', 'template', 'head', 'iframe', 'object', 'svg', 'canvas'];

const BLOCK_TAGS =
  'p|div|li|ul|ol|h[1-6]|tr|table|thead|tbody|tfoot|section|article|header|footer|nav|aside|main|pre|blockquote|dl|dt|dd|form|fieldset|figure|figcaption|address|details|summary|hr';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  times: '×',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const codePoint = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff || surrogate) return match;
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function collapseWhitespace(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function htmlToText(html: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP_WITH_CONTENT) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Block boundaries become newlines (so paragraphs end up separated by a blank line); list items
  // open with a bullet and close silently so a list stays tight.
  s = s.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), (tag) => {
    if (/^<li\b/i.test(tag)) return '\n- ';
    if (/^<\/li\b/i.test(tag)) return '';
    return '\n';
  });
  s = s.replace(/<\/?(?:td|th)\b[^>]*>/gi, '\t');
  s = s.replace(/<[^>]+>/g, ' ');
  const body = collapseWhitespace(decodeEntities(s));
  const title = titleMatch ? collapseWhitespace(decodeEntities(titleMatch[1] ?? '')).replace(/\n+/g, ' ') : '';
  return title ? `${title}\n\n${body}` : body;
}
