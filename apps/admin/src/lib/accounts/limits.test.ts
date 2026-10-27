import { describe, expect, it } from 'vitest';
import { accountLimitResultSchema } from '@intafaced/contracts';
import { aboveCeiling, allowanceAssets, allowanceRefusal, ceilingFor, limitsReply } from './limits';
import { readLimitClearForm, readLimitSetForm } from './limits-forms';

const founder = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const user = '1c7a8b4f-2d3e-4f60-9b0c-1d2e3f4a5b6c';
const form = {
  userId: user.toUpperCase(),
  rail: 'withdrawal',
  assetId: 'USDT',
  perTx: null,
  rolling24h: '3000',
  expiresAt: '2026-10-25T14:00:00+02:00',
  reason: 'Customer is moving house this week',
  basis: { version: '2', after: null },
};
const after = '2d8b9c5a-3e4f-4a71-8c1d-2e3f4a5b6c7d';

describe('limit override forms', () => {
  it('a set carries a business key of founder, account, rail, asset, reading, figures, end instant and reason', () => {
    const set = readLimitSetForm(form, founder)!;
    expect(set).toMatchObject({
      userId: user,
      perTx: null,
      rolling24h: '3000',
      expiresAt: '2026-10-25T12:00:00.000Z',
      expectedVersion: '2',
    });
    // The same change asked again is the same request; any other figure, end time, version or founder is a new one.
    expect(readLimitSetForm({ ...form, expiresAt: '2026-10-25T12:00:00.000Z' }, founder)!.requestId).toBe(set.requestId);
    // A stored attempt (a refusal too) adds a history entry, so the next try is a new reading and a new request.
    for (const patch of [
      { rolling24h: '3001' },
      { perTx: '10' },
      { basis: { version: '3', after: null } },
      { basis: { version: '2', after } },
      { expiresAt: '2026-10-25T12:00:01Z' },
      { reason: 'Customer is moving house next week' },
    ])
      expect(readLimitSetForm({ ...form, ...patch }, founder)!.requestId).not.toBe(set.requestId);
    expect(readLimitSetForm(form, user)!.requestId).not.toBe(set.requestId);
  });

  it('refuses what identity would refuse, before anything is sent', () => {
    for (const patch of [
      { perTx: null, rolling24h: null },
      { rolling24h: '0' },
      { rolling24h: 3000 },
      { rail: 'deposit' },
      { assetId: 'usdt' },
      { expiresAt: 'tomorrow' },
      { reason: 'too short' },
      { basis: { version: '-1', after: null } },
      { basis: { version: '2' } },
      { basis: { version: '2', after: 'x' } },
    ])
      expect(readLimitSetForm({ ...form, ...patch }, founder)).toBeNull();
    expect(readLimitSetForm({ ...form, approvalId: 'x' }, founder)).toBeNull();
  });

  it('a clear is keyed by founder, account, rail, asset, the reading and the reason', () => {
    const base = { userId: user, rail: 'withdrawal', assetId: 'USDT', reason: form.reason, basis: { version: '2', after: null } };
    const clear = readLimitClearForm(base, founder)!;
    expect(clear).toMatchObject({ userId: user, expectedVersion: '2' });
    expect(readLimitClearForm({ ...base }, founder)!.requestId).toBe(clear.requestId);
    expect(readLimitClearForm({ ...base, basis: { version: '2', after } }, founder)!.requestId).not.toBe(clear.requestId);
    expect(readLimitClearForm({ ...base, reason: 'Customer finished the move early' }, founder)!.requestId).not.toBe(clear.requestId);
    expect(readLimitClearForm({ userId: user, rail: 'withdrawal', assetId: 'USDT', reason: form.reason }, founder)).toBeNull();
  });
});

describe('limit override words', () => {
  it('compares figures with the ceiling exactly', () => {
    expect(aboveCeiling({ perTx: null, rolling24h: '5000' }, '5000')).toBe(false);
    expect(aboveCeiling({ perTx: null, rolling24h: '5000.000000000000000001' }, '5000')).toBe(true);
    expect(aboveCeiling({ perTx: '5001', rolling24h: null }, '5000')).toBe(true);
    expect(ceilingFor({ configured: false, code: 'identity.limit_ceiling_unset' }, 'withdrawal', 'USDT')).toBeNull();
    expect(
      ceilingFor(
        { configured: true, maxLifetimeHours: '48', ceilings: [{ rail: 'withdrawal', assetId: 'USDT', ceiling: '5000' }] },
        'withdrawal',
        'BTC',
      ),
    ).toBeNull();
  });

  it('only a changed override reads as done; each refusal names its code', () => {
    const common = {
      auditId: founder,
      requestId: founder,
      userId: user,
      action: 'set',
      rail: 'withdrawal',
      assetId: 'USDT',
      reason: form.reason,
      occurredAt: '2026-10-24T12:00:00.000Z',
    } as const;
    const refused = accountLimitResultSchema.parse({
      ...common,
      outcome: 'refused',
      changed: false,
      actorUserId: founder,
      code: 'identity.limit_requires_approver',
      current: null,
      ceiling: '5000',
    });
    expect(limitsReply(refused)).toEqual({ ok: false, text: expect.stringContaining('identity.limit_requires_approver') });
    const conflict = accountLimitResultSchema.parse({
      ...common,
      outcome: 'conflict',
      changed: false,
      actorUserId: founder,
      code: 'restriction.version_conflict',
      current: null,
    });
    expect(limitsReply(conflict).ok).toBe(false);
  });
});

describe('what svc-pay applies', () => {
  it('names svc-pay’s own refusal in words, and an unknown or missing code as it is', () => {
    expect(allowanceRefusal('pay.guard_withdrawal_limit_unset')).toContain('has not set a withdrawal limit');
    expect(allowanceRefusal('pay.guard_withdrawal_override_unwired')).toContain('pay.guard_withdrawal_override_unwired');
    expect(allowanceRefusal('pay.something_new')).toBe(
      'svc-pay did not answer with this customer’s withdrawal allowance (pay.something_new).',
    );
    expect(allowanceRefusal(null)).toBe('svc-pay did not answer with this customer’s withdrawal allowance.');
  });

  it('lists the assets svc-pay has a base limit set for, once each and sorted; a cleared one is left out', () => {
    const limit = { perTx: '50', rolling24h: '100' };
    expect(
      allowanceAssets([
        { tier: 'full', assetId: 'USDT', limit },
        { tier: 'basic', assetId: 'USDC', limit },
        { tier: 'basic', assetId: 'USDT', limit },
        { tier: 'none', assetId: 'BTC', limit: null },
      ]),
    ).toEqual(['USDC', 'USDT']);
    expect(allowanceAssets([])).toEqual([]);
    expect(allowanceAssets({ rows: [] })).toBeNull();
    expect(allowanceAssets([{ assetId: 7, limit }])).toBeNull();
  });
});
