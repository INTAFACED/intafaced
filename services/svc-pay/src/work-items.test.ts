import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { ownsAll, workItemsOutputSchema } from '@intafaced/contracts/home-work-items';
import { createWorkItemsRouter, payoutWaitingItems, type PayoutWaitingSource, type WaitingPayout } from './work-items.js';

/** `workItems.list` through the real router: who gets an answer, whose rows, and the item each waiting payout makes. */
const SECRET = 'a-work-items-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const S1 = '33333333-3333-4333-8333-333333333333';
const S2 = '44444444-4444-4444-8444-444444444444';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });

function signed(scopes: string[], withdrawn: string[] = [], extra: Record<string, unknown> = {}, broken = false) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...extra,
  } as Principal);
  const ctx = edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-work-items',
  });
  return {
    ...ctx,
    ownerPayGrant: {
      assertStillGranted: async (_principal: unknown, scope: string) => {
        if (broken) throw new Error('merchant lookup failed');
        if (withdrawn.includes(scope)) throw new TRPCError({ code: 'FORBIDDEN', message: 'pay.owner_grant_withdrawn' });
      },
    },
  };
}

const ROWS: WaitingPayout[] = [
  { settlementId: S1, net: '97.500000000000000000', assetId: 'USDT', failureCode: null },
  { settlementId: S2, net: '0.01', assetId: 'BTC', failureCode: 'rail.refused' },
];

function source(rows = ROWS) {
  const asked: string[] = [];
  const src: PayoutWaitingSource = {
    waiting: async (userId) => {
      asked.push(userId);
      return rows;
    },
  };
  return { src, asked };
}

describe('payoutWaitingItems', () => {
  it('makes one action item per payout, linked to its own payout page, with a plain decimal amount', () => {
    const items = payoutWaitingItems(ROWS, true);
    expect(items[0]).toEqual({
      id: `payout_waiting:${S1}`,
      kind: 'payout_waiting',
      source: 'pay',
      severity: 'action',
      titleKey: 'pay.payout_waiting',
      link: `/pay/payouts/${S1}`,
      amount: { value: '97.5', asset: 'USDT' },
    });
    expect(items[1]).toMatchObject({ amount: { value: '0.01', asset: 'BTC' }, reasonCode: 'rail.refused' });
    const out = workItemsOutputSchema.parse({ items });
    expect(ownsAll('pay', out)).toBe(true);
  });

  it('is info, not action, for a session that cannot send a payout, and sends no reason that is not a code', () => {
    const items = payoutWaitingItems([{ ...ROWS[1]!, failureCode: 'Rail said no!' }], false);
    expect(items[0]!.severity).toBe('info');
    expect(items[0]).not.toHaveProperty('reasonCode');
    workItemsOutputSchema.parse({ items });
  });
});

describe('workItems.list', () => {
  it('answers the signed-in owner with their own waiting payouts', async () => {
    const { src, asked } = source();
    const out = await createWorkItemsRouter(src)
      .createCaller(signed(['pay:read']))
      .workItems.list();
    expect(out.items.map((item) => item.id)).toEqual([`payout_waiting:${S1}`, `payout_waiting:${S2}`]);
    expect(asked).toEqual([USER]);
  });

  it('accepts the onboarding scope too, as every own-merchant read does', async () => {
    const { src } = source();
    expect(
      (
        await createWorkItemsRouter(src)
          .createCaller(signed(['pay:onboard']))
          .workItems.list()
      ).items,
    ).toHaveLength(2);
  });

  it('is empty, not an error, for a session with no pay scope, and does not read', async () => {
    const { src, asked } = source();
    expect(
      await createWorkItemsRouter(src)
        .createCaller(signed(['trade:read', 'bank:read']))
        .workItems.list(),
    ).toEqual({ items: [] });
    expect(asked).toEqual([]);
  });

  it('is empty when the owner grant has been withdrawn for every pay scope the session holds', async () => {
    const { src, asked } = source();
    const caller = createWorkItemsRouter(src).createCaller(signed(['pay:onboard', 'pay:read'], ['pay:onboard', 'pay:read']));
    expect(await caller.workItems.list()).toEqual({ items: [] });
    expect(asked).toEqual([]);
    const partly = createWorkItemsRouter(src).createCaller(signed(['pay:onboard', 'pay:read'], ['pay:onboard']));
    expect((await partly.workItems.list()).items).toHaveLength(2);
  });

  it('is empty for a sandbox key, which does not see live payouts', async () => {
    const { src, asked } = source();
    const caller = createWorkItemsRouter(src).createCaller(signed(['pay:read'], [], { key_env: 'sandbox' }));
    expect(await caller.workItems.list()).toEqual({ items: [] });
    expect(asked).toEqual([]);
  });

  it('is empty, and does not read, for a KYC tier the jurisdiction matrix keeps out of pay', async () => {
    for (const tier of ['none', 'basic']) {
      const { src, asked } = source();
      const caller = createWorkItemsRouter(src).createCaller(signed(['pay:read'], [], { tier }));
      expect(await caller.workItems.list()).toEqual({ items: [] });
      expect(asked).toEqual([]);
    }
  });

  it('is empty, and does not read, for an onboarding session still short of its second factor', async () => {
    const { src, asked } = source();
    const caller = createWorkItemsRouter(src).createCaller(signed(['pay:onboard'], [], { mfa: false }));
    expect(await caller.workItems.list()).toEqual({ items: [] });
    expect(asked).toEqual([]);
  });

  it('fails, rather than answering empty, when the owner grant cannot be checked', async () => {
    const { src } = source();
    await expect(
      createWorkItemsRouter(src)
        .createCaller(signed(['pay:read'], [], {}, true))
        .workItems.list(),
    ).rejects.toBeDefined();
  });

  it('is empty when nothing waits', async () => {
    const { src } = source([]);
    expect(
      await createWorkItemsRouter(src)
        .createCaller(signed(['pay:read']))
        .workItems.list(),
    ).toEqual({ items: [] });
  });

  it('refuses a caller with no principal', async () => {
    const { src } = source();
    const anonymous = edgeContext({ headers: {}, id: 'req-anon' });
    await expect(createWorkItemsRouter(src).createCaller(anonymous).workItems.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('does not answer a read that fails as an empty list', async () => {
    const failing: PayoutWaitingSource = {
      waiting: async () => {
        throw new Error('database unavailable');
      },
    };
    await expect(
      createWorkItemsRouter(failing)
        .createCaller(signed(['pay:read']))
        .workItems.list(),
    ).rejects.toBeDefined();
  });
});
