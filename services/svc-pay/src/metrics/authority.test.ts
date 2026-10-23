import { describe, expect, it } from 'vitest';
import type { MerchantRole } from '../merchant-ops/roles.js';
import type { PayService } from '../payment-service.js';
import { createMerchantMetricsAuthority } from './authority.js';

const MERCHANT = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-1';
const merchant = { id: MERCHANT, userId: OWNER, parentMerchantId: null } as never;
const pay = {
  getMerchant: async (id: string) => (id === MERCHANT ? merchant : null),
  getMerchantByUserId: async (userId: string) => (userId === OWNER ? merchant : null),
} as unknown as Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>;

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
};

describe('metrics read authority: a team member reads the business it works for (J-merchant-01 #4)', () => {
  const roles = new Map<string, MerchantRole>([
    ['finance-1', 'finance'],
    ['viewer-1', 'viewer'],
  ]);
  const authority = createMerchantMetricsAuthority(pay, null, async (userId, merchantId) =>
    merchantId === MERCHANT ? (roles.get(userId) ?? null) : null,
  );

  it('lets the owner and an active member read', async () => {
    expect(await refusal(authority.assertCanRead(OWNER, MERCHANT))).toBe('ok');
    expect(await refusal(authority.assertCanRead('finance-1', MERCHANT))).toBe('ok');
    expect(await refusal(authority.assertCanRead('viewer-1', MERCHANT))).toBe('ok');
  });

  it('answers a stranger, a member asking about another merchant and an anonymous caller the same not-found', async () => {
    const stranger = await refusal(authority.assertCanRead('stranger', MERCHANT));
    expect(stranger).toBe('pay.merchant_not_found');
    expect(await refusal(authority.assertCanRead('finance-1', '22222222-2222-4222-8222-222222222222'))).toBe(stranger);
    expect(await refusal(authority.assertCanRead(undefined, MERCHANT))).toBe(stranger);
  });

  it('without the team lookup, keeps the owner-only answer', async () => {
    const ownerOnly = createMerchantMetricsAuthority(pay, null);
    expect(await refusal(ownerOnly.assertCanRead('finance-1', MERCHANT))).toBe('pay.merchant_not_found');
  });
});
