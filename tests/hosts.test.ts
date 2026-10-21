import { describe, expect, it } from 'vitest';
import { ToolboxError } from '../src/errors.js';
import { assertUrlAllowed, isHostAllowed } from '../src/safety/hosts.js';

describe('isHostAllowed', () => {
  it('matches exact hosts case-insensitively and ignores a trailing dot', () => {
    expect(isHostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(isHostAllowed('API.Example.COM.', ['api.example.com'])).toBe(true);
    expect(isHostAllowed('example.com', ['api.example.com'])).toBe(false);
  });

  it('wildcards match subdomains at any depth but never the apex', () => {
    expect(isHostAllowed('a.example.com', ['*.example.com'])).toBe(true);
    expect(isHostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(isHostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('notexample.com', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('example.com.evil.io', ['*.example.com'])).toBe(false);
  });

  it('allows nothing when the allowlist is empty', () => {
    expect(isHostAllowed('localhost', [])).toBe(false);
    expect(isHostAllowed('', ['*.example.com'])).toBe(false);
  });
});

describe('assertUrlAllowed', () => {
  const code = (input: string, allow: string[]): string => {
    try {
      assertUrlAllowed(input, allow);
    } catch (err) {
      return (err as ToolboxError).code;
    }
    return 'ok';
  };

  it('accepts http(s) URLs on allowed hosts, including IPv6 literals', () => {
    expect(assertUrlAllowed('http://127.0.0.1:8080/x?y=1', ['127.0.0.1']).pathname).toBe('/x');
    expect(assertUrlAllowed('http://[::1]:8080/', ['::1']).hostname).toBe('[::1]');
    expect(code('https://docs.example.com/a', ['*.example.com'])).toBe('ok');
  });

  it('rejects other schemes, credentials, unknown hosts and garbage', () => {
    expect(code('ftp://example.com/', ['example.com'])).toBe('URL_INVALID');
    expect(code('file:///etc/passwd', ['example.com'])).toBe('URL_INVALID');
    expect(code('http://user:pw@example.com/', ['example.com'])).toBe('URL_INVALID');
    expect(code('http://evil.com/', ['example.com'])).toBe('HOST_NOT_ALLOWED');
    expect(code('not a url', ['example.com'])).toBe('URL_INVALID');
  });
});
