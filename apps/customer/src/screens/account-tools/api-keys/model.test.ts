import { describe, expect, it } from 'vitest';
import { classifyCreateFailure, createKey, isValidIp, nameError, parseAllowList, permissionsOf, scopesFor, type Permission } from './model';
import type { ApiClient } from '../../../shared/api';

describe('permissions', () => {
  it('Read is read-only, Trade adds write and keeps read, and withdraw can never be asked for', () => {
    expect(scopesFor(new Set<Permission>(['read']))).toEqual(['trade:read']);
    expect(scopesFor(new Set<Permission>(['trade']))).toEqual(['trade:read', 'trade:write']);
    expect(scopesFor(new Set<Permission>(['read', 'trade']))).toEqual(['trade:read', 'trade:write']);
    for (const set of [new Set<Permission>(['read']), new Set<Permission>(['trade'])])
      expect(scopesFor(set).join()).not.toMatch(/withdraw|payout|card|admin/);
  });
  it('reads a key back into Read, Trade and other access', () => {
    expect(permissionsOf(['trade:read'])).toEqual({ read: true, trade: false, other: false });
    expect(permissionsOf(['trade:read', 'trade:write'])).toEqual({ read: true, trade: true, other: false });
    expect(permissionsOf(['pay:read'])).toEqual({ read: false, trade: false, other: true });
  });
});

describe('names', () => {
  it('needs one to 64 characters', () => {
    expect(nameError('  ')).toBe('empty');
    expect(nameError('Bot')).toBeNull();
    expect(nameError('x'.repeat(64))).toBeNull();
    expect(nameError('x'.repeat(65))).toBe('long');
  });
});

describe('IP allow-list', () => {
  it('accepts exact IPv4 and IPv6 addresses', () => {
    for (const ok of ['203.0.113.7', '0.0.0.0', '255.255.255.255', '2001:db8::1', '::1']) expect(isValidIp(ok), ok).toBe(true);
  });
  it('refuses ranges, names and out-of-range numbers', () => {
    for (const bad of ['203.0.113.0/24', '256.1.1.1', '1.2.3', 'example.com', '1.2.3.4.5', 'g::1', '01.2.3.4', ''])
      expect(isValidIp(bad), bad).toBe(false);
  });
  it('splits on commas, spaces and lines, drops repeats, and lists the bad ones', () => {
    expect(parseAllowList('203.0.113.7, 203.0.113.8\n203.0.113.7  nope\n2001:DB8::1')).toEqual({
      ips: ['203.0.113.7', '203.0.113.8', '2001:db8::1'],
      invalid: ['nope'],
    });
    expect(parseAllowList('  \n')).toEqual({ ips: [], invalid: [] });
  });
  it('sends IPv6 in the lower-case compressed form the service compares against', () => {
    expect(parseAllowList('2001:0DB8:0000:0000:0000:0000:0000:0001, 2001:db8::1').ips).toEqual(['2001:db8::1']);
    expect(parseAllowList('::1').ips).toEqual(['::1']);
  });
});

describe('why a create was refused', () => {
  const fail = (message: string, reason: 'error' | 'uncertain' | 'unauthorized' = 'error', code?: string) => ({
    ok: false as const,
    reason,
    message,
    ...(code ? { code } : {}),
  });
  it('tells a missing passkey from an unconfirmed one', () => {
    expect(classifyCreateFailure(fail('No enrolled passkey'))).toBe('passkey-missing');
    expect(classifyCreateFailure(fail('passkey verify is unavailable'))).toBe('passkey-unconfirmed');
    expect(classifyCreateFailure(fail('x', 'error', 'auth.passkey_verify_unavailable'))).toBe('passkey-unconfirmed');
  });
  it('spots a bad address, a lost answer and a signed-out session', () => {
    expect(classifyCreateFailure(fail('Invalid IP in allowlist'))).toBe('bad-ip');
    expect(classifyCreateFailure(fail('whatever', 'uncertain'))).toBe('uncertain');
    expect(classifyCreateFailure(fail('whatever', 'unauthorized'))).toBe('signed-out');
    expect(classifyCreateFailure(fail('Cannot grant scopes'))).toBe('other');
  });
});

describe('createKey', () => {
  function recorder() {
    const calls: Array<{ procedure: string; input: unknown }> = [];
    const api = {
      mutate: async (_module: string, procedure: string, input: unknown) => {
        calls.push({ procedure, input });
        return { ok: true as const, data: { id: 'k', key: 'fake-secret', prefix: 'fake', mode: 'live' as const } };
      },
    } as unknown as ApiClient;
    return { api, calls };
  }
  it('uses the plain create when no address is listed, and trims the name', async () => {
    const { api, calls } = recorder();
    await createKey(api, { name: '  Bot  ', permissions: new Set<Permission>(['read']), ips: [] });
    expect(calls).toEqual([{ procedure: 'apiKeys.create', input: { name: 'Bot', scopes: ['trade:read'] } }]);
  });
  it('binds the addresses at creation when some are listed', async () => {
    const { api, calls } = recorder();
    await createKey(api, { name: 'Bot', permissions: new Set<Permission>(['trade']), ips: ['203.0.113.7'] });
    expect(calls).toEqual([
      {
        procedure: 'mintApiKeyWithIpAllowlist',
        input: { name: 'Bot', scopes: ['trade:read', 'trade:write'], ips: ['203.0.113.7'] },
      },
    ]);
  });
});
