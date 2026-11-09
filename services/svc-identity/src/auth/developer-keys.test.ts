import { describe, expect, it } from 'vitest';
import { checkCreate, DeveloperKeyError, parseApiKeyCapByTier, parsePortfolioKeyCap } from './developer-keys.js';

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

describe('portfolio-scoped and organisation keys (J-developer-15 #2)', () => {
  const now = new Date('2026-10-23T00:00:00.000Z');
  const session = ['identity:read', 'trade:read'];
  const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('refuses an organisation key that names no account, before anything is read', () => {
    const refusal = (() => {
      try {
        checkCreate({ name: 'org-bot', scopes: ['trade:read'], orgId: ORG }, session, now);
      } catch (err) {
        return err;
      }
    })();
    expect(refusal).toBeInstanceOf(DeveloperKeyError);
    expect((refusal as DeveloperKeyError).code).toBe('identity.key_account_required');
  });

  it('keeps the account and org on the checked request and in its fingerprint, and leaves an account-less request hashed as before', () => {
    const plain = checkCreate({ name: 'bot', scopes: ['trade:read'] }, session, now);
    const bound = checkCreate({ name: 'bot', scopes: ['trade:read'], accountId: ACC.toUpperCase() }, session, now);
    const org = checkCreate({ name: 'bot', scopes: ['trade:read'], accountId: ACC, orgId: ORG }, session, now);
    expect(bound).toMatchObject({ accountId: ACC, orgId: null });
    expect(org).toMatchObject({ accountId: ACC, orgId: ORG });
    expect(new Set([plain.fingerprint, bound.fingerprint, org.fingerprint]).size).toBe(3);
    expect(plain).toMatchObject({ accountId: null, orgId: null });
  });

  it('reads the owner cap per sub-account, and blank stays blank (never a default)', () => {
    expect(parsePortfolioKeyCap(undefined)).toBeNull();
    expect(parsePortfolioKeyCap(' ')).toBeNull();
    expect(parsePortfolioKeyCap('2')).toBe(2);
    expect(parsePortfolioKeyCap('0')).toBe(0);
    for (const bad of ['-1', 'two', '2.5', '99999']) expect(() => parsePortfolioKeyCap(bad)).toThrow();
  });
});

describe('agent keys (J-developer-15 #5): tagged and restricted at create', () => {
  const now = new Date('2026-10-23T00:00:00.000Z');
  const session = ['identity:read', 'identity:write', 'trade:read', 'pay:write'];
  const refusalOf = (input: Parameters<typeof checkCreate>[0]) => {
    try {
      checkCreate(input, session, now);
    } catch (err) {
      return err as DeveloperKeyError;
    }
    return null;
  };

  it('refuses a refund, payout, withdrawal or settings permission on an agent key, naming the agent restriction', () => {
    for (const scope of ['identity:write', 'pay:write', 'pay:payout', 'pay:refund', 'trade:withdraw']) {
      const refusal = refusalOf({ name: 'agent-1', scopes: ['trade:read', scope], kind: 'agent' });
      expect(refusal, scope).toBeInstanceOf(DeveloperKeyError);
      expect(refusal?.code, scope).toBe('identity.agent_scope_forbidden');
    }
  });

  it('lets an agent key hold a read permission, tags it, and fingerprints it apart from the same personal key', () => {
    const agent = checkCreate({ name: 'agent-1', scopes: ['trade:read'], kind: 'agent' }, session, now);
    const personal = checkCreate({ name: 'agent-1', scopes: ['trade:read'] }, session, now);
    expect(agent.kind).toBe('agent');
    expect(personal.kind).toBe('personal');
    expect(agent.fingerprint).not.toBe(personal.fingerprint);
    // A personal key keeps the settings permission the agent key may not hold.
    expect(checkCreate({ name: 'mine', scopes: ['identity:write'] }, session, now).scopes).toEqual(['identity:write']);
  });
});
