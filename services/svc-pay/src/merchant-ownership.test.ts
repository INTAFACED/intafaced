import { describe, expect, it } from 'vitest';
import { setIsolationDenialSink, type IsolationDenial } from './isolation-log.js';
import { assertMerchantAreaAccess, assertMerchantOwnership } from './merchant-ownership.js';
import { PayError } from './payment-service.js';
import { SubMerchantError, type PermissionArea } from './submerchants.js';

/**
 * PayFac area residual on the gateway surface (README): money paths used to
 * authorize with ownership alone. These pins prove self still wins, a parent
 * without a grant is refused by area name, and a grant / root path succeeds.
 */

const ROOT = '11111111-1111-4111-8111-111111111111';
const LEAF = '22222222-2222-4222-8222-222222222222';
const ROOT_USER = 'user-root';
const LEAF_USER = 'user-leaf';
const STRANGER = 'user-stranger';

function payStub(opts?: { rootUser?: string; leafUser?: string; noActor?: boolean }) {
  const rootUser = opts?.rootUser ?? ROOT_USER;
  const leafUser = opts?.leafUser ?? LEAF_USER;
  const merchants = {
    [ROOT]: { id: ROOT, userId: rootUser },
    [LEAF]: { id: LEAF, userId: leafUser },
  };
  return {
    async getMerchant(id: string) {
      const m = merchants[id as keyof typeof merchants];
      if (!m) throw new PayError('not found', 'pay.merchant_not_found');
      return m as never;
    },
    async getMerchantByUserId(userId: string) {
      if (opts?.noActor) return null;
      if (userId === rootUser) return { id: ROOT } as never;
      if (userId === leafUser) return { id: LEAF } as never;
      return null;
    },
  };
}

function fence(held: Partial<Record<string, PermissionArea[]>>) {
  return {
    async assertHolds(actor: string, subject: string, area: PermissionArea) {
      if (actor === subject) return;
      // Root holds everything over descendants (mirrors SubMerchantService.holds).
      if (actor === ROOT && subject === LEAF) return;
      const areas = held[`${actor}->${subject}`] ?? [];
      if (areas.includes(area)) return;
      throw new SubMerchantError(`no ${area}`, 'pay.submerchant_permission_denied', { area });
    },
  };
}

function midFence() {
  // Intermediate ancestor with only DEFAULT grants — no payment.refund.
  const MID = '33333333-3333-4333-8333-333333333333';
  return {
    mid: MID,
    fence: {
      async assertHolds(actor: string, subject: string, area: PermissionArea) {
        if (actor === subject) return;
        if (actor === ROOT) return; // root of tree
        if (actor === MID && subject === LEAF) {
          if (area === 'merchant.profile' || area === 'submerchant') return;
          throw new SubMerchantError(`no ${area}`, 'pay.submerchant_permission_denied', { area });
        }
        throw new SubMerchantError('out', 'pay.submerchant_out_of_scope');
      },
    },
  };
}

describe('assertMerchantOwnership (self only)', () => {
  it('allows the owner', async () => {
    await expect(assertMerchantOwnership(payStub() as never, LEAF_USER, LEAF)).resolves.toBeUndefined();
  });

  it('refuses a stranger exactly like a merchant that does not exist (no existence oracle)', async () => {
    await expect(assertMerchantOwnership(payStub() as never, STRANGER, LEAF)).rejects.toMatchObject({
      code: 'pay.merchant_not_found',
      message: `Merchant ${LEAF} not found`,
    });
    const GHOST = '99999999-9999-4999-8999-999999999999';
    await expect(assertMerchantOwnership(payStub() as never, STRANGER, GHOST)).rejects.toMatchObject({
      code: 'pay.merchant_not_found',
      message: `Merchant ${GHOST} not found`,
    });
  });

  it('tells operators which case it was (log only), never the caller', async () => {
    const seen: IsolationDenial[] = [];
    setIsolationDenialSink((d) => seen.push(d));
    try {
      await assertMerchantOwnership(payStub() as never, STRANGER, LEAF).catch(() => undefined);
      await assertMerchantOwnership(payStub() as never, STRANGER, '99999999-9999-4999-8999-999999999999').catch(() => undefined);
    } finally {
      setIsolationDenialSink(null);
    }
    expect(seen.map((d) => d.reason)).toEqual(['not_owner', 'absent']);
  });

  it('a throwing log sink cannot change the answer', async () => {
    setIsolationDenialSink(() => {
      throw new Error('logger down');
    });
    try {
      await expect(assertMerchantOwnership(payStub() as never, STRANGER, LEAF)).rejects.toMatchObject({ code: 'pay.merchant_not_found' });
    } finally {
      setIsolationDenialSink(null);
    }
  });
});

describe('assertMerchantAreaAccess — self and stranger', () => {
  it('self holds every area without a fence', async () => {
    await expect(assertMerchantAreaAccess(payStub(), LEAF_USER, LEAF, 'settlement.payout', null)).resolves.toBeUndefined();
  });

  it('stranger without a fence is refused as not-found (merchant_not_found)', async () => {
    await expect(assertMerchantAreaAccess(payStub(), STRANGER, LEAF, 'payment', null)).rejects.toMatchObject({
      code: 'pay.merchant_not_found',
    });
  });

  it('anonymous principal is refused as not-found', async () => {
    await expect(assertMerchantAreaAccess(payStub(), undefined, LEAF, 'payment', fence({}))).rejects.toMatchObject({
      code: 'pay.merchant_not_found',
    });
  });
});

describe('assertMerchantAreaAccess — PayFac tree', () => {
  it('root may act on leaf money paths (implicit root hold)', async () => {
    await expect(assertMerchantAreaAccess(payStub(), ROOT_USER, LEAF, 'payment.refund', fence({}))).resolves.toBeUndefined();
  });

  it('parent without payment.refund is refused by area name', async () => {
    const { mid, fence: trees } = midFence();
    const pay = {
      async getMerchant(id: string) {
        if (id === LEAF) return { id: LEAF, userId: LEAF_USER } as never;
        throw new PayError('nf', 'pay.merchant_not_found');
      },
      async getMerchantByUserId(userId: string) {
        if (userId === 'user-mid') return { id: mid } as never;
        return null;
      },
    };
    await expect(assertMerchantAreaAccess(pay, 'user-mid', LEAF, 'payment.refund', trees)).rejects.toMatchObject({
      code: 'pay.submerchant_permission_denied',
    });
  });

  it('parent with an explicit grant may refund', async () => {
    const MID = '33333333-3333-4333-8333-333333333333';
    const trees = {
      async assertHolds(actor: string, subject: string, area: PermissionArea) {
        if (actor === MID && subject === LEAF && area === 'payment.refund') return;
        throw new SubMerchantError('no', 'pay.submerchant_permission_denied', { area });
      },
    };
    const pay = {
      async getMerchant(id: string) {
        if (id === LEAF) return { id: LEAF, userId: LEAF_USER } as never;
        throw new PayError('nf', 'pay.merchant_not_found');
      },
      async getMerchantByUserId(userId: string) {
        if (userId === 'user-mid') return { id: MID } as never;
        return null;
      },
    };
    await expect(assertMerchantAreaAccess(pay, 'user-mid', LEAF, 'payment.refund', trees)).resolves.toBeUndefined();
  });

  it('out-of-scope sibling looks like a stranger (merchant_not_found)', async () => {
    const trees = {
      async assertHolds() {
        throw new SubMerchantError('out', 'pay.submerchant_out_of_scope');
      },
    };
    await expect(assertMerchantAreaAccess(payStub(), ROOT_USER, LEAF, 'payment', trees)).rejects.toMatchObject({
      code: 'pay.merchant_not_found',
    });
  });

  it('principal with no merchant node is refused as not-found', async () => {
    await expect(assertMerchantAreaAccess(payStub({ noActor: true }), STRANGER, LEAF, 'payment', fence({}))).rejects.toMatchObject({
      code: 'pay.merchant_not_found',
    });
  });
});
