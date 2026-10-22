import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { apiKeyIpAllowed, callerIpFromUpgrade, normalizeIp } from './caller-ip.js';

describe('normalizeIp', () => {
  it('accepts exact IPv4 and IPv6 after trim; rejects junk and blanks', () => {
    expect(normalizeIp(' 203.0.113.10 ')).toBe('203.0.113.10');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp('  ')).toBeNull();
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('203.0.113.10/32')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

describe('apiKeyIpAllowed', () => {
  it('empty list stays open; missing IP with a bound list fails closed', () => {
    expect(apiKeyIpAllowed([], null)).toBe(true);
    expect(apiKeyIpAllowed([], '203.0.113.10')).toBe(true);
    expect(apiKeyIpAllowed(['203.0.113.10'], null)).toBe(false);
    expect(apiKeyIpAllowed(['203.0.113.10'], '')).toBe(false);
    expect(apiKeyIpAllowed(['203.0.113.10'], '198.51.100.7')).toBe(false);
    expect(apiKeyIpAllowed(['203.0.113.10'], '203.0.113.10')).toBe(true);
    expect(apiKeyIpAllowed([' 203.0.113.10 '], '203.0.113.10')).toBe(true);
    expect(apiKeyIpAllowed(['2001:db8::1'], '2001:db8::1')).toBe(true);
    expect(apiKeyIpAllowed(['not-cidr', '203.0.113.10'], '203.0.113.10')).toBe(true);
  });
});

describe('callerIpFromUpgrade', () => {
  function req(opts: { forwarded?: string; real?: string; remote?: string }): IncomingMessage {
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: opts.remote });
    const headers: Record<string, string> = {};
    if (opts.forwarded !== undefined) headers['x-forwarded-for'] = opts.forwarded;
    if (opts.real !== undefined) headers['x-real-ip'] = opts.real;
    return { headers, socket } as IncomingMessage;
  }

  it('uses first forwarded hop, then x-real-ip, then the TCP peer', () => {
    expect(callerIpFromUpgrade(req({ forwarded: '203.0.113.10, 198.51.100.1', remote: '10.0.0.1' }))).toBe('203.0.113.10');
    expect(callerIpFromUpgrade(req({ real: '203.0.113.10', remote: '10.0.0.1' }))).toBe('203.0.113.10');
    expect(callerIpFromUpgrade(req({ remote: '203.0.113.10' }))).toBe('203.0.113.10');
    expect(callerIpFromUpgrade(req({ forwarded: 'not-an-ip', remote: '203.0.113.10' }))).toBe('203.0.113.10');
    expect(callerIpFromUpgrade(req({}))).toBeNull();
  });
});
