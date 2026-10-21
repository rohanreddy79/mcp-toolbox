/**
 * `http_fetch`: GET only, host allowlist re-checked on every redirect hop (redirects are followed
 * manually so a permitted host cannot bounce the request to a forbidden one), total timeout, and a
 * streaming byte cap that cancels the body instead of buffering past the limit.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolboxError } from '../errors.js';
import { assertUrlAllowed } from '../safety/hosts.js';
import { htmlToText } from '../safety/html.js';
import { registerToolboxTool, type ServerContext } from '../tooling.js';
import { isHtmlContentType, isTextContentType, looksBinary } from '../util/text.js';

export const USER_AGENT = 'mcp-toolbox/0.1 (+https://github.com/rohanreddy79/mcp-toolbox)';
const MAX_REDIRECTS = 5;

export interface FetchOptions {
  allowedHosts: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  /** Return HTML as-is instead of converting it to readable text. */
  raw?: boolean;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  redirects: number;
  text: string;
}

function classifyFetchError(err: unknown, url: URL): ToolboxError {
  const error = err as Error & { cause?: { message?: string; code?: string } };
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return new ToolboxError('TIMEOUT', `request to ${url.host} timed out`, { cause: err });
  }
  const detail = error.cause?.code ?? error.cause?.message ?? error.message;
  return new ToolboxError('FETCH_FAILED', `request to ${url.host} failed: ${detail}`, { cause: err });
}

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);

async function readCapped(response: Response, maxBytes: number, url: URL): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ToolboxError('SIZE_CAP', `response from ${url.host} exceeds the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ToolboxError) throw err;
    throw classifyFetchError(err, url);
  }
  return Buffer.concat(chunks);
}

function decodeBody(bytes: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function fetchText(input: string, opts: FetchOptions): Promise<FetchResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = assertUrlAllowed(input, opts.allowedHosts);
  let redirects = 0;
  let response: Response;
  for (;;) {
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5', 'user-agent': USER_AGENT },
      });
    } catch (err) {
      throw classifyFetchError(err, url);
    }
    if (!isRedirect(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (location === null) throw new ToolboxError('FETCH_FAILED', `${url.host} answered ${response.status} without a Location header`);
    redirects += 1;
    if (redirects > MAX_REDIRECTS) throw new ToolboxError('FETCH_FAILED', `more than ${MAX_REDIRECTS} redirects`);
    url = assertUrlAllowed(new URL(location, url).toString(), opts.allowedHosts);
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await response.body?.cancel();
    throw new ToolboxError('SIZE_CAP', `response from ${url.host} declares ${declared} bytes, above the ${opts.maxBytes}-byte cap`);
  }
  const bytes = await readCapped(response, opts.maxBytes, url);
  if (!isTextContentType(contentType) && looksBinary(bytes.subarray(0, 8192))) {
    throw new ToolboxError('BINARY_CONTENT', `response from ${url.host} is binary (${contentType})`);
  }
  const decoded = decodeBody(bytes, contentType);
  const text = isHtmlContentType(contentType) && !opts.raw ? htmlToText(decoded) : decoded;
  return { url: url.toString(), status: response.status, contentType, bytes: bytes.byteLength, redirects, text };
}

export function registerHttpTools(server: McpServer, ctx: ServerContext): void {
  const { config } = ctx;
  const hosts = config.allowedHosts.join(', ') || 'none (every request is rejected)';
  registerToolboxTool(
    server,
    ctx,
    'http_fetch',
    {
      title: 'Fetch a URL',
      description:
        `HTTP GET of a URL whose host is allowlisted (${hosts}). HTML is converted to readable text unless raw=true. ` +
        `Redirects are followed only to allowlisted hosts. Cap ${config.maxBytes} bytes, timeout ${config.fetchTimeoutMs} ms.`,
      inputSchema: {
        url: z.string().min(1).max(4096).describe('Absolute http(s) URL'),
        raw: z.boolean().optional().describe('Return HTML source instead of extracted text'),
        maxBytes: z.number().int().positive().max(config.maxBytes).optional(),
        timeoutMs: z.number().int().positive().max(config.fetchTimeoutMs).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const result = await fetchText(args.url, {
        allowedHosts: config.allowedHosts,
        maxBytes: args.maxBytes ?? config.maxBytes,
        timeoutMs: args.timeoutMs ?? config.fetchTimeoutMs,
        raw: args.raw ?? false,
      });
      const hops = result.redirects > 0 ? `, ${result.redirects} redirect(s)` : '';
      return `HTTP ${result.status} ${result.contentType} (${result.bytes} bytes${hops}) ${result.url}\n\n${result.text}`;
    },
  );
}
