import { describe, expect, it } from 'vitest';
import { KIND_KEYS, subaccountsIn } from './subaccount-guards';
import { subaccountCopy } from './subaccount-copy';

const row = {
  id: '3f2b8c1e-9a4d-4c8e-8f0a-1b2c3d4e5f60',
  label: 'strategy',
  purpose: null,
  revoked: false,
  frozen: false,
  kind: 'standard' as const,
  nickname: null,
  createdAt: '2026-10-20T10:00:00.000Z',
};

describe('subaccount kind, nickname and frozen', () => {
  it('reads the list the service returns', () => {
    const rows = subaccountsIn(10).parse([{ ...row, kind: 'spot', nickname: 'Alpha123', frozen: true }]);
    expect(rows[0]).toMatchObject({ kind: 'spot', nickname: 'Alpha123', frozen: true });
  });

  it('refuses a row without the new fields or with an unknown kind', () => {
    const { kind: _kind, ...withoutKind } = row;
    expect(subaccountsIn(10).safeParse([withoutKind]).success).toBe(false);
    expect(subaccountsIn(10).safeParse([{ ...row, kind: 'margin' }]).success).toBe(false);
  });

  it('words every kind', () => {
    for (const key of Object.values(KIND_KEYS)) expect(subaccountCopy.t(key as 'kindStandard').length).toBeGreaterThan(2);
  });
});
