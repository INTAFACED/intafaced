import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { TRPCError } from '@intafaced/contracts';
import type { OwnerPayScopeMerchant } from './merchant-pay-grant-path.js';
import { assertOwnerPayScopeStillGranted } from './owner-pay-grant-recheck.js';

const USER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';

function principal(): Principal {
  return {
    userId: USER,
    sessionId: '33333333-3333-4333-8333-333333333333',
    scopes: ['pay:read', 'pay:write'],
    tier: 'full',
    mfa: false,
    kid: 'key-1',
  } as Principal;
}

function merchant(overrides: Partial<OwnerPayScopeMerchant> = {}): OwnerPayScopeMerchant {
  return { id: MERCHANT, userId: USER, kybStatus: 'approved', status: 'active', ...overrides };
}

describe('assertOwnerPayScopeStillGranted', () => {
  it('allows an approved owner and a caller who owns no merchant', async () => {
    await expect(assertOwnerPayScopeStillGranted(principal(), 'pay:write', async () => merchant())).resolves.toBeUndefined();
    await expect(assertOwnerPayScopeStillGranted(principal(), 'pay:read', async () => null)).resolves.toBeUndefined();
  });

  it('refuses after suspension and after KYB is no longer approved', async () => {
    await expect(
      assertOwnerPayScopeStillGranted(principal(), 'pay:write', async () => merchant({ status: 'suspended' })),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      assertOwnerPayScopeStillGranted(principal(), 'pay:read', async () => merchant({ kybStatus: 'rejected' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'pay.owner_grant_withdrawn' });
  });
});
