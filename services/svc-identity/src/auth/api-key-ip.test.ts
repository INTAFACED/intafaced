import { describe, expect, it } from 'vitest';
import { apiKeyIpAllowed, normalizeIp } from './api-key-ip.js';

describe('apiKeyIpAllowed', () => {
  it('allows any / missing IP when the allowlist is empty', () => {
    expect(apiKeyIpAllowed([], undefined)).toBe(true);
    expect(apiKeyIpAllowed([], null)).toBe(true);
    expect(apiKeyIpAllowed([], '')).toBe(true);
    expect(apiKeyIpAllowed([], '203.0.113.10')).toBe(true);
    expect(apiKeyIpAllowed([], '2001:db8::1')).toBe(true);
  });

  it('refuses missing or blank IP when the allowlist is set', () => {
    expect(apiKeyIpAllowed(['203.0.113.10'], undefined)).toBe(false);
    expect(apiKeyIpAllowed(['203.0.113.10'], null)).toBe(false);
    expect(apiKeyIpAllowed(['203.0.113.10'], '')).toBe(false);
    expect(apiKeyIpAllowed(['203.0.113.10'], '   ')).toBe(false);
  });

  it('matches IPv4 and IPv6 exactly after trim; rejects a non-listed address', () => {
    const list = ['203.0.113.10', '2001:db8::1'];
    expect(apiKeyIpAllowed(list, '203.0.113.10')).toBe(true);
    expect(apiKeyIpAllowed(list, '  203.0.113.10  ')).toBe(true);
    expect(apiKeyIpAllowed(list, '2001:db8::1')).toBe(true);
    expect(apiKeyIpAllowed(list, ' 2001:db8::1 ')).toBe(true);
    expect(apiKeyIpAllowed(list, '198.51.100.9')).toBe(false);
    expect(apiKeyIpAllowed(list, '2001:db8::2')).toBe(false);
  });

  it('never matches invalid list entries (CIDR, hostname, junk)', () => {
    expect(apiKeyIpAllowed(['10.0.0.0/8'], '10.0.0.1')).toBe(false);
    expect(apiKeyIpAllowed(['not-an-ip'], 'not-an-ip')).toBe(false);
    expect(apiKeyIpAllowed(['app.example.com'], 'app.example.com')).toBe(false);
    expect(apiKeyIpAllowed(['203.0.113.10', '10.0.0.0/8'], '203.0.113.10')).toBe(true);
    expect(apiKeyIpAllowed(['203.0.113.10', '10.0.0.0/8'], '10.0.0.1')).toBe(false);
  });
});

describe('normalizeIp', () => {
  it('accepts IPv4 and IPv6 literals after trim', () => {
    expect(normalizeIp('203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeIp('  192.0.2.1  ')).toBe('192.0.2.1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('::1')).toBe('::1');
  });

  it('rejects blank, CIDR, hostname, and junk', () => {
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp('   ')).toBeNull();
    expect(normalizeIp('10.0.0.0/8')).toBeNull();
    expect(normalizeIp('2001:db8::/32')).toBeNull();
    expect(normalizeIp('app.example.com')).toBeNull();
    expect(normalizeIp('not-an-ip')).toBeNull();
  });
});
