import { describe, expect, it } from 'vitest';
import { checkCreate, parseApiKeyCapByTier } from './developer-keys.js';

describe('IDENTITY_API_KEYS_MAX_BY_TIER', () => {
  it('is null while blank, so every create refuses identity.key_cap_unset', () => {
    expect(parseApiKeyCapByTier(undefined)).toBeNull();
    expect(parseApiKeyCapByTier('  ')).toBeNull();
  });

  it('reads one cap per verification level and leaves the rest unset', () => {
    const caps = parseApiKeyCapByTier('basic=3, full = 5,institutional=0');
    expect([...caps!]).toEqual([
      ['basic', 3],
      ['full', 5],
      ['institutional', 0],
    ]);
    expect(caps!.get('none')).toBeUndefined();
  });

  it.each(['basic', 'basic=', 'gold=3', 'basic=3,basic=4', 'basic=-1', 'basic=3;full=4', 'basic=99999'])(
    'refuses to start on %j',
    (raw) => {
      expect(() => parseApiKeyCapByTier(raw)).toThrow(/IDENTITY_API_KEYS_MAX_BY_TIER/);
    },
  );
});

describe('checkCreate', () => {
  const now = new Date('2026-10-23T00:00:00.000Z');
  const session = ['identity:read', 'trade:read', 'trade:write'];

  it('trims the name, drops repeated scopes and addresses, and fingerprints what was asked regardless of order', () => {
    const a = checkCreate(
      { name: ' bot-1 ', scopes: ['trade:write', 'trade:read', 'trade:read'], ips: ['203.0.113.7', '::1', '::1'] },
      session,
      now,
    );
    const b = checkCreate({ name: 'bot-1', scopes: ['trade:read', 'trade:write'], ips: ['::1', ' 203.0.113.7'] }, session, now);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ name: 'bot-1', scopes: ['trade:read', 'trade:write'], ips: ['203.0.113.7', '::1'], expiresAt: null });
  });

  it('refuses a name with a control character or longer than 64 characters', () => {
    for (const name of ['bot\u0000', 'a'.repeat(65), 'bot‮1']) {
      expect(() => checkCreate({ name, scopes: ['trade:read'] }, session, now)).toThrow(
        expect.objectContaining({ code: 'identity.key_name_invalid' }),
      );
    }
  });

  it('refuses an end date that is now or past', () => {
    expect(() => checkCreate({ name: 'b', scopes: ['trade:read'], expiresAt: now.toISOString() }, session, now)).toThrow(
      expect.objectContaining({ code: 'identity.key_expiry_invalid' }),
    );
  });
});
