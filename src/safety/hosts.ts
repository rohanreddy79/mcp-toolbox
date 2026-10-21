/**
 * Host allowlist for `http_fetch`. Entries are exact hostnames (`api.example.com`) or wildcard
 * subdomain patterns (`*.example.com`, which does not match the apex). Matching is on the hostname
 * only; ports and paths are unrestricted. An empty allowlist allows nothing.
 */
import { ToolboxError } from '../errors.js';

export function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

export function isHostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const host = normalizeHostname(hostname);
  if (host === '') return false;
  return allowlist.some((entry) => {
    const pattern = normalizeHostname(entry);
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

/** Parses `input` and enforces scheme, no embedded credentials, and the host allowlist. */
export function assertUrlAllowed(input: string, allowlist: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ToolboxError('URL_INVALID', `not a valid absolute URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolboxError('URL_INVALID', `only http and https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ToolboxError('URL_INVALID', 'URLs with embedded credentials are not allowed');
  }
  if (!isHostAllowed(url.hostname, allowlist)) {
    throw new ToolboxError('HOST_NOT_ALLOWED', `host "${url.hostname}" is not in allowedHosts`);
  }
  return url;
}
