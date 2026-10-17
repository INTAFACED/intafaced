import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { createApiClient } from '../../../../shared/api';
import { createBusinessPayApi, createPayMutationGuard, type BusinessPayApi } from '../../pay-api';
import { addressOf, expiryIso, LinksView, settleDeactivate } from './Links';
import { linkRowSchema } from './schemas';
import { PAY_CHECKOUT_PATH } from './checkout-address';

// TEST data only: no real merchant, link or token.
const userId = '11111111-1111-4111-8111-111111111111';
const merchantId = '22222222-2222-4222-8222-222222222222';
const linkId = '33333333-3333-4333-8333-333333333333';
const row = {
  id: linkId,
  prefix: 'TEST-prefix',
  label: 'TEST older link',
  amount: null,
  currency: null,
  active: true,
  expiresAt: '2099-10-16T00:00:00Z',
  maxUses: null,
  uses: 0,
  createdAt: '2026-01-16T00:00:00Z',
};
const merchantReply = {
  result: { data: { id: merchantId, userId, mode: 'gateway', status: 'active', kybStatus: 'approved', kybRef: 'verified', feeBps: null } },
};

describe('payment link expiry is the merchant’s own clock', () => {
  it('converts a datetime-local value to the exact UTC moment', () => {
    const local = '2026-10-17T18:30';
    expect(expiryIso(local)).toBe(new Date(2026, 9, 17, 18, 30).toISOString());
    // The old code appended "Z", which read the local time as UTC.
    expect(expiryIso(local)).not.toBe('2026-10-17T18:30:00Z');
  });
  it('hands an unreadable value back as typed, so the form’s own check refuses it', () => {
    expect(expiryIso('not a time')).toBe('not a time');
  });
});

describe('checkout address', () => {
  it('uses the address the service sent, exactly', () => {
    expect(addressOf({ checkoutUrl: '/api/pay/checkout?token=abc' })).toBe(
      `${globalThis.location?.origin ?? ''}/api/pay/checkout?token=abc`,
    );
    expect(addressOf({ checkoutUrl: 'https://pay.test.invalid/api/pay/checkout?token=abc' })).toBe(
      'https://pay.test.invalid/api/pay/checkout?token=abc',
    );
  });
  it('builds a token fallback on the same path the service serves (PAY_PUBLIC_BASE_PATH default /api/pay)', () => {
    expect(PAY_CHECKOUT_PATH).toBe('/api/pay/checkout');
    expect(addressOf({ token: 'a b' })).toBe(`${globalThis.location?.origin ?? ''}/api/pay/checkout?token=a%20b`);
  });
});

describe('one odd checkout address does not fail the list', () => {
  it('keeps the row, and shows no address for an unusable one', () => {
    const odd = linkRowSchema.parse({ ...row, checkoutUrl: 'javascript:alert(1)' });
    expect(odd.id).toBe(linkId);
    expect(addressOf(odd)).toBeNull();
    expect(addressOf(linkRowSchema.parse({ ...row, checkoutUrl: '/api/pay/checkout?token=x' }))).toContain('/api/pay/checkout?token=x');
  });
});

describe('a link outside the newest 200', () => {
  it('opens by its own id instead of saying it is missing', () => {
    const pay = { access: () => null, authority: null } as unknown as BusinessPayApi;
    const out = renderToString(
      <LinksView
        resource={{ status: 'ready', data: [] }}
        retry={() => {}}
        loadedAt="2026-10-16T00:00:00Z"
        limit={200}
        more={() => {}}
        pay={pay}
        merchantId={merchantId}
        linkId={linkId}
      />,
    );
    expect(out).not.toContain('Link not in the records shown');
  });
});

describe('a deactivate whose answer was lost', () => {
  const uncertain = { ok: false as const, reason: 'uncertain' as const, code: 'pay.operation_unresolved', message: 'TEST timeout' };
  async function build(active: boolean, readStatus = 200) {
    const reads: string[] = [];
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    const api = createApiClient({
      fetch: async (url) => {
        const href = String(url);
        if (href.includes('merchant.me')) return new Response(JSON.stringify(merchantReply));
        if (href.includes('merchant.getLink')) {
          reads.push(decodeURIComponent(href));
          return readStatus === 200
            ? new Response(JSON.stringify({ result: { data: { ...row, active } } }))
            : new Response('{}', { status: readStatus });
        }
        throw new Error(href);
      },
    });
    const pay = createBusinessPayApi(
      api,
      userId,
      { verified: true, companyId: 'c', companyName: 'C', merchantId, userId, scopes: ['pay:read', 'pay:write'] },
      createPayMutationGuard(storage),
    );
    const lockId = `${userId}:link-deactivate:${linkId}`;
    await pay.guard.run(lockId, async () => uncertain, 'attempt');
    return { pay, reads, lockId, values };
  }
  it('clears the held attempt when the link reads inactive: the first request worked', async () => {
    const f = await build(false);
    expect(f.pay.guard.status(f.lockId)).toBe('uncertain');
    expect(await settleDeactivate(f.pay, merchantId, linkId)).toBe('inactive');
    expect(f.reads[0]).toContain(linkId);
    expect(f.pay.guard.status(f.lockId)).toBeNull();
    expect(f.values.size).toBe(0);
  });
  it('clears the held attempt when the link is still active, so the owner can send it again', async () => {
    const f = await build(true);
    expect(await settleDeactivate(f.pay, merchantId, linkId)).toBe('active');
    expect(f.pay.guard.status(f.lockId)).toBeNull();
  });
  it('changes nothing when the link cannot be read (a 404 is not "nothing was changed")', async () => {
    const f = await build(true, 404);
    expect(await settleDeactivate(f.pay, merchantId, linkId)).toBe('failed');
    expect(f.pay.guard.status(f.lockId)).toBe('uncertain');
  });
  it('reports failure when nothing is held', async () => {
    const f = await build(true);
    await f.pay.guard.resolve(f.lockId, f.pay.guard.original(f.lockId)!.raw);
    expect(await settleDeactivate(f.pay, merchantId, linkId)).toBe('failed');
    expect(f.reads).toHaveLength(0);
  });
});
