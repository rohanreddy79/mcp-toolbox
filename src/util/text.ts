/** Small text helpers shared by the tools: binary sniffing, truncation and a MIME guess. */

/** A NUL byte in the sample is treated as proof of binary content; UTF-16 files are a known casualty. */
export function looksBinary(sample: Uint8Array): boolean {
  return sample.includes(0);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length - max} more chars)`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  go: 'text/x-go',
  rs: 'text/x-rust',
  sql: 'application/sql',
  sh: 'text/x-shellscript',
  css: 'text/css',
};

export function guessMimeType(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return 'text/plain';
  return MIME_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? 'text/plain';
}

/** Treat a Content-Type as text if it is text/* or a structured text format. */
export function isTextContentType(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('text/')) return true;
  return (
    /^application\/(json|xml|javascript|ecmascript|yaml|toml|sql|x-ndjson|x-www-form-urlencoded|xhtml\+xml)$/.test(type) ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

export function isHtmlContentType(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'text/html' || type === 'application/xhtml+xml';
}
