import { describe, expect, it } from 'vitest';
import { identityLimitPayloadHash, limitAbove, parseLimitPolicy } from './account-limits.js';

const UNSET = { configured: false, code: 'identity.limit_ceiling_unset' };

describe('IDENTITY_LIMIT_OVERRIDE_POLICY', () => {
  it('reads the longest lifetime and each ceiling', () => {
    expect(parseLimitPolicy('{"maxLifetimeHours":"720","ceilings":{"withdrawal":{"USDT":"5000","BTC":"0.5"}}}')).toEqual({
      configured: true,
      maxLifetimeHours: '720',
      ceilings: [
        { rail: 'withdrawal', assetId: 'USDT', ceiling: '5000' },
        { rail: 'withdrawal', assetId: 'BTC', ceiling: '0.5' },
      ],
    });
  });

  it.each([
    ['unset', undefined],
    ['blank', '  '],
    ['not JSON', '{'],
    ['no lifetime', '{"ceilings":{"withdrawal":{"USDT":"5000"}}}'],
    ['a numeric lifetime', '{"maxLifetimeHours":720,"ceilings":{"withdrawal":{"USDT":"5000"}}}'],
    ['a zero lifetime', '{"maxLifetimeHours":"0","ceilings":{"withdrawal":{"USDT":"5000"}}}'],
    ['a lifetime over a year', '{"maxLifetimeHours":"9000","ceilings":{"withdrawal":{"USDT":"5000"}}}'],
    ['no ceilings', '{"maxLifetimeHours":"720","ceilings":{}}'],
    ['an unknown rail', '{"maxLifetimeHours":"720","ceilings":{"deposit":{"USDT":"5000"}}}'],
    ['a lower-case asset', '{"maxLifetimeHours":"720","ceilings":{"withdrawal":{"usdt":"5000"}}}'],
    ['a zero ceiling', '{"maxLifetimeHours":"720","ceilings":{"withdrawal":{"USDT":"0"}}}'],
    ['a negative ceiling', '{"maxLifetimeHours":"720","ceilings":{"withdrawal":{"USDT":"-1"}}}'],
    ['a numeric ceiling', '{"maxLifetimeHours":"720","ceilings":{"withdrawal":{"USDT":5000}}}'],
    ['an extra key', '{"maxLifetimeHours":"720","ceilings":{"withdrawal":{"USDT":"5000"}},"default":"1"}'],
  ])('%s is unset, never a default', (_, raw) => {
    expect(parseLimitPolicy(raw)).toEqual(UNSET);
  });
});

describe('limit figures', () => {
  it('compares decimal strings exactly, without a float', () => {
    expect(limitAbove('5000', '5000')).toBe(false);
    expect(limitAbove('5000.0', '5000')).toBe(false);
    expect(limitAbove('5000.000000000000000001', '5000')).toBe(true);
    expect(limitAbove('4999.999999999999999999', '5000')).toBe(false);
    expect(limitAbove('99999999999999999999', '5000')).toBe(true);
  });

  it('binds the approval to the account, rail, asset, both figures, the expiry instant and the reason', () => {
    const base = {
      userId: '11111111-1111-4111-8111-111111111111',
      rail: 'withdrawal',
      assetId: 'USDT',
      perTx: null,
      rolling24h: '8000',
      expiresAt: '2026-10-25T12:00:00.000Z',
      reason: 'Customer is moving house this week',
    };
    const hash = identityLimitPayloadHash(base);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // The same instant in another offset, an upper-case id and outer spaces in the reason are the same payload.
    expect(
      identityLimitPayloadHash({
        ...base,
        userId: base.userId.toUpperCase(),
        expiresAt: '2026-10-25T14:00:00+02:00',
        reason: ` ${base.reason} `,
      }),
    ).toBe(hash);
    for (const patch of [
      { perTx: '8000' },
      { rolling24h: '8001' },
      { assetId: 'BTC' },
      { expiresAt: '2026-10-25T12:00:01.000Z' },
      { reason: 'Another reason given here' },
    ])
      expect(identityLimitPayloadHash({ ...base, ...patch })).not.toBe(hash);
  });
});
