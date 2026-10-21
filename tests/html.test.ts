import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../src/safety/html.js';

describe('htmlToText', () => {
  it('drops scripts, styles, comments and head but keeps the title', () => {
    const html = `<!doctype html><html><head><title>Hello &amp; World</title><style>p{color:red}</style></head>
      <body><!-- hidden --><script>alert('x')</script><p>First<br>line</p><div>Second</div></body></html>`;
    expect(htmlToText(html)).toBe('Hello & World\n\nFirst\nline\n\nSecond');
  });

  it('turns lists and headings into lines', () => {
    const html = '<h1>Title</h1><ul><li>one</li><li>two &gt; three</li></ul><table><tr><td>a</td><td>b</td></tr></table>';
    expect(htmlToText(html)).toBe('Title\n\n- one\n- two > three\n\na b');
  });

  it('decodes entities only after tags are stripped so encoded markup stays text', () => {
    expect(htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe('<script>alert(1)</script>');
  });

  it('collapses whitespace runs and blank-line runs', () => {
    expect(htmlToText('<p>  a   b </p>\n\n\n\n<p>c</p>')).toBe('a b\n\nc');
  });
});

describe('decodeEntities', () => {
  it('handles named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeEntities('&amp;&#65;&#x42;&nbsp;&bogus;&#xD800;')).toBe('&AB &bogus;&#xD800;');
  });
});
