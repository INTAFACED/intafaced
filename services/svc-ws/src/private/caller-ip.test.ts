import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { apiKeyIpAllowed, callerIpFromUpgrade, normalizeIp, publicCallerIp } from './caller-ip.js';

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

  it('uses the TCP peer and ignores a client-supplied forwarded hop', () => {
    expect(callerIpFromUpgrade(req({ forwarded: '203.0.113.10, 198.51.100.1', remote: '10.0.0.1' }))).toBe('10.0.0.1');
    expect(callerIpFromUpgrade(req({ real: '203.0.113.10', remote: '10.0.0.1' }))).toBe('10.0.0.1');
    expect(callerIpFromUpgrade(req({ remote: '203.0.113.10' }))).toBe('203.0.113.10');
    expect(callerIpFromUpgrade(req({ forwarded: '203.0.113.10', remote: '::ffff:198.51.100.9' }))).toBe('198.51.100.9');
    expect(callerIpFromUpgrade(req({}))).toBeNull();
  });

  it('behind a stated proxy, reads the caller from its forwarded hop and nothing else (#11027)', () => {
    const front = ['127.0.0.1'];
    // Two testers through the front on loopback: two addresses, so two per-IP budgets.
    expect(publicCallerIp(req({ forwarded: '203.0.113.10', remote: '127.0.0.1' }), front)).toBe('203.0.113.10');
    expect(publicCallerIp(req({ forwarded: '198.51.100.7', remote: '127.0.0.1' }), front)).toBe('198.51.100.7');
    // The beta's two loopback hops (front, then the stack's Customer server) are both skipped.
    expect(publicCallerIp(req({ forwarded: '203.0.113.10, 127.0.0.1', remote: '127.0.0.1' }), front)).toBe('203.0.113.10');
    // A forged hop left of the real one is never reached: the first untrusted address from the right is the caller.
    expect(publicCallerIp(req({ forwarded: '192.0.2.1, 203.0.113.10', remote: '127.0.0.1' }), front)).toBe('203.0.113.10');
    // A peer not on the list is the caller, whatever it sends.
    expect(publicCallerIp(req({ forwarded: '203.0.113.10', remote: '10.0.0.1' }), front)).toBe('10.0.0.1');
    // No list: the TCP peer, as before.
    expect(publicCallerIp(req({ forwarded: '203.0.113.10', remote: '127.0.0.1' }), [])).toBe('127.0.0.1');
    // A broken header falls back to the proxy's own address, never to a new one.
    expect(publicCallerIp(req({ forwarded: 'not-an-ip', remote: '127.0.0.1' }), front)).toBe('127.0.0.1');
    expect(publicCallerIp(req({ remote: '::ffff:127.0.0.1' }), front)).toBe('127.0.0.1');
  });
});
