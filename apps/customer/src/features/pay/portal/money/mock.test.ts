import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPortalMock } from '../portal.mock.mjs';
import { effectiveRateSchema } from './fee-rate-schema';

/**
 * The money pages' stand-in answers the destination, payout and fee-rate procedures the way the real service does, and
 * its answers add up. TEST data only.
 */
const NOW = Date.parse('2026-10-17T09:00:00.000Z');
const DAY = 86_400_000;
const MERCHANT = '11111111-1111-4111-8111-111111111111';

// The stand-in seeds records relative to `now` but checks expiry with the wall clock, so run the wall clock from NOW.
beforeAll(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'], shouldAdvanceTime: true });
});
afterAll(() => {
  vi.useRealTimers();
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Mock = ReturnType<typeof createPortalMock>;

async function ask(
  mock: Mock,
  procedure: string,
  input: Record<string, unknown> = {},
): Promise<{ status: number; data: Any; code?: string }> {
  let out: { status: number; body: string } = { status: 500, body: '' };
  await mock.handle({
    request: () => ({ url: () => `http://stand-in.test/api/pay/trpc/${procedure}`, method: () => 'POST', postDataJSON: () => input }),
    fulfill: async (r: { status?: number; body: string }) => {
      out = { status: r.status ?? 200, body: r.body };
    },
  });
  const json = JSON.parse(out.body);
  return { status: out.status, data: json.result?.data, code: json.error?.data?.cause?.code };
}
const ok = async (mock: Mock, procedure: string, input: Record<string, unknown> = {}) => {
  const r = await ask(mock, procedure, input);
  if (r.status >= 400) throw new Error(`${procedure}: ${r.status} ${r.code}`);
  return r.data;
};

describe('payout destinations in the stand-in', () => {
  it('marks one default at a time, and removing the default does not promote another', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const list = async () => (await ok(mock, 'merchant.payoutDestinations.list', { merchantId: MERCHANT, limit: 50 })).items as Any[];
    expect((await list()).map((d) => d.defaultFlag)).toEqual(['unset', 'unset']);
    const [wallet, bank] = await list();
    await ok(mock, 'merchant.payoutDestinations.setDefault', { merchantId: MERCHANT, destinationId: wallet.id });
    await ok(mock, 'merchant.payoutDestinations.setDefault', { merchantId: MERCHANT, destinationId: bank.id });
    expect((await list()).map((d) => d.defaultFlag)).toEqual(['unset', 'default']);
    const gone = await ok(mock, 'merchant.payoutDestinations.remove', { merchantId: MERCHANT, destinationId: bank.id });
    expect(gone).toEqual({ removed: true });
    const after = await list();
    expect(after).toHaveLength(1);
    expect(after[0].defaultFlag).toBe('unset');
  });
  it('refuses to remove a destination a payout is waiting on, and a destination that is not there', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const [wallet] = (await ok(mock, 'merchant.payoutDestinations.list', { merchantId: MERCHANT, limit: 50 })).items as Any[];
    // two payouts are waiting for approval to the wallet
    const refused = await ask(mock, 'merchant.payoutDestinations.remove', { merchantId: MERCHANT, destinationId: wallet.id });
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('pay.payout_destination_in_flight');
    const missing = await ask(mock, 'merchant.payoutDestinations.remove', {
      merchantId: MERCHANT,
      destinationId: 'dd999999-0000-4000-8000-000000000999',
    });
    expect(missing.code).toBe('pay.payout_destination_not_found');
    const missingDefault = await ask(mock, 'merchant.payoutDestinations.setDefault', {
      merchantId: MERCHANT,
      destinationId: 'dd999999-0000-4000-8000-000000000999',
    });
    expect(missingDefault.code).toBe('pay.payout_destination_not_found');
  });
  it('sends a US dollar payout to the bank account, never to a crypto address', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const approvals = (await ok(mock, 'merchantControl.approvals.list', { merchantId: MERCHANT, limit: 50 })).items as Any[];
    for (const a of approvals) expect(a.railId, `${a.assetCode} approval`).toBe(a.assetCode === 'USD' ? 'card-sandbox' : 'crypto-native');
  });
});

describe('a payout in the stand-in', () => {
  const owner = () => createPortalMock('active', { now: NOW });
  const WAITING = 'bb000003-0000-4000-8000-000000000003';
  it('will not send above the approval limit without a decided approval, then uses it up', async () => {
    const mock = owner();
    const refused = await ask(mock, 'settlement.payout', { settlementId: WAITING, railId: 'crypto-native' });
    expect(refused.code).toBe('pay.approval_required');
    const approvals = (await ok(mock, 'merchantControl.approvals.list', { merchantId: MERCHANT, limit: 50, status: 'pending' }))
      .items as Any[];
    const waiting = approvals.find((a) => a.settlementId === WAITING);
    await ok(mock, 'merchantControl.approvals.decide', {
      approvalId: waiting.approvalId,
      decision: 'approve',
      expectedPayloadHash: waiting.payloadHash,
      reason: 'Checked',
    });
    // asking again returns the approved request instead of making a second one
    const again = await ok(mock, 'merchantControl.approvals.request', {
      merchantId: MERCHANT,
      settlementId: WAITING,
      railId: 'crypto-native',
    });
    expect(again.status).toBe('approved');
    expect(again.approvalId).toBe(waiting.approvalId);
    const before = Date.now();
    const sent = await ok(mock, 'settlement.payout', { settlementId: WAITING, railId: 'crypto-native' });
    expect(sent.status).toBe('paid_out');
    // stamped when it was sent, with where it went
    expect(Date.parse(sent.sentAt)).toBeGreaterThanOrEqual(before);
    const lifecycle = await ok(mock, 'settlement.lifecycle', { settlementId: WAITING });
    expect(lifecycle.destination).toEqual({ railId: 'crypto-native', kind: 'crypto', destinationMasked: '0x7a3f…4421' });
    const used = (await ok(mock, 'merchantControl.approvals.list', { merchantId: MERCHANT, limit: 50 })).items.find(
      (a: Any) => a.approvalId === waiting.approvalId,
    );
    expect(used.status).toBe('consumed');
    // and the wallet now shows as used just now
    const wallet = (await ok(mock, 'merchant.payoutDestinations.list', { merchantId: MERCHANT, limit: 50 })).items[0];
    expect(Date.parse(wallet.lastUsedAt)).toBeGreaterThanOrEqual(before);
  });
  it('tells the failed payout’s story in order: asked, approved, sent, refused', async () => {
    const mock = owner();
    const failed = 'bb000005-0000-4000-8000-000000000005';
    const lifecycle = await ok(mock, 'settlement.lifecycle', { settlementId: failed });
    expect(lifecycle.events.map((e: Any) => e.kind)).toEqual([
      'settlement.opened',
      'settlement.posted',
      'approval.requested',
      'approval.approved',
      'rail.sent',
      'rail.refused',
    ]);
    const times = lifecycle.events.map((e: Any) => e.at);
    expect(times).toEqual([...times].sort());
    expect(lifecycle.events.at(-1).failure.message).toBe('The payment network declined this payout.');
    expect(lifecycle.destination.railId).toBe('card-sandbox');
  });
});

describe('the tier ladder in the stand-in', () => {
  it('lists every published tier once and marks the merchant’s own by id', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const ladder = await ok(mock, 'merchantControl.tiers.list', { merchantId: MERCHANT });
    expect(ladder.status).toBe('configured');
    const ids = ladder.tiers.map((t: Any) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(ladder.ownTierId);
    expect(ladder.tiers.length).toBeGreaterThan(1);
    expect(ladder.tiers.every((t: Any) => /test/i.test(t.name))).toBe(true);
    expect((await ok(createPortalMock('quiet', { now: NOW }), 'merchantControl.tiers.list', { merchantId: MERCHANT })).status).toBe(
      'not_configured',
    );
  });
});

describe('the effective fee rate in the stand-in', () => {
  const window = {
    merchantId: MERCHANT,
    bucket: 'day',
    limit: 1,
    from: new Date(NOW - 29 * DAY).toISOString(),
    to: new Date(NOW + DAY).toISOString(),
  };
  it('is fees divided by gross per asset, rounded down, from the same payments the fees page lists', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const page = await ok(mock, 'merchantAnalytics.fees', { ...window, limit: 200 });
    expect(page.rates.length).toBeGreaterThan(0);
    for (const rate of page.rates) {
      expect(effectiveRateSchema.safeParse(rate).success, JSON.stringify(rate)).toBe(true);
      const rows = page.items.filter((i: Any) => i.assetCode === rate.assetCode);
      const sum = (key: 'gross' | 'fees') => rows.reduce((t: bigint, r: Any) => t + BigInt(Math.round(Number(r[key]) * 1e6)), 0n);
      // the rate in millionths: fees ÷ gross, rounded down
      const expected = (sum('fees') * 1_000_000n) / sum('gross');
      const [whole = '0', fraction = ''] = String(rate.rate).split('.');
      expect(BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toBe(expected);
      // no payment's 1.5% + 0.30 can make the rate come out below the 1.5% price
      expect(Number(rate.rate)).toBeGreaterThanOrEqual(0.015);
    }
  });
  it('is empty when there are no payments, and a one-row page still carries the rates', async () => {
    expect((await ok(createPortalMock('quiet', { now: NOW }), 'merchantAnalytics.fees', window)).rates).toEqual([]);
    expect((await ok(createPortalMock('active', { now: NOW }), 'merchantAnalytics.fees', window)).rates.length).toBeGreaterThan(0);
  });
});
