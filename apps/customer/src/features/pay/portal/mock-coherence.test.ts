import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPortalMock } from './portal.mock.mjs';

/**
 * The stand-in is one set of facts, so a page can never contradict another. These tests ask the stand-in the way the
 * pages do (through its procedures) and check the answers add up: the fee rule, settlements, refunds, customers, the
 * statement, destinations and the activity feed. They fail the day one page's numbers drift from another's.
 */
const NOW = Date.parse('2026-10-17T09:00:00.000Z');
const DAY = 86_400_000;
const MERCHANT = '11111111-1111-4111-8111-111111111111';

// The stand-in seeds its records relative to `now` (an approval expires 22 hours after it) but checks expiry and
// stamps new records with the wall clock. Run the wall clock from NOW too, or the seeded approvals expire a day
// after NOW and the approve-then-send case fails on every later date.
beforeAll(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'], shouldAdvanceTime: true });
});
afterAll(() => {
  vi.useRealTimers();
});

type Mock = ReturnType<typeof createPortalMock>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function call(mock: Mock, procedure: string, input: Record<string, unknown> = {}): Promise<Any> {
  let out: { status: number; body: string } = { status: 500, body: '' };
  const route = {
    request: () => ({ url: () => `http://stand-in.test/api/pay/trpc/${procedure}`, method: () => 'POST', postDataJSON: () => input }),
    fulfill: async (r: { status?: number; body: string }) => {
      out = { status: r.status ?? 200, body: r.body };
    },
  };
  await mock.handle(route);
  const json = JSON.parse(out.body);
  if (out.status >= 400) throw new Error(`${procedure}: ${out.status} ${out.body}`);
  return json.result.data;
}
/** Every page of a cursor list. */
async function all(mock: Mock, procedure: string, input: Record<string, unknown> = {}): Promise<Any[]> {
  const rows: Any[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(mock, procedure, { ...input, limit: 200, ...(cursor ? { cursor } : {}) });
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}
/** Decimal arithmetic on 6 places without floats: the test's own, so it does not share a bug with the stand-in. */
const micro = (v: string) => {
  const [w, f = ''] = v.split('.');
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, '0').slice(0, 6));
};
const total = (values: string[]) => values.reduce((t, v) => t + micro(v), 0n);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Back to a decimal string with at least two places, like the stand-in writes amounts. */
const fromMicro = (v: bigint) => {
  const fraction = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${v / 1_000_000n}.${fraction}`;
};
const thirtyDays = { from: new Date(NOW - 30 * DAY).toISOString(), to: new Date(NOW + 1).toISOString() };
/** Midnight UTC of NOW's day. The pages say "days are UTC days": Today starts here, 7 days is six before it, 30 days is 29. */
const MIDNIGHT = Math.floor(NOW / DAY) * DAY;
const sinceMidnight = (days: number) => MIDNIGHT - (days - 1) * DAY;
/** The whole UTC days the Analytics page asks for ("30d" = today and the 29 before, end exclusive). */
const utcDays = (days: number) => ({ from: new Date(sinceMidnight(days)).toISOString(), to: new Date(MIDNIGHT + DAY).toISOString() });
const TAKEN = ['captured', 'settled', 'refunded', 'disputed'];

describe('the stand-in is one set of facts', () => {
  const mock = createPortalMock('active', { now: NOW });
  const world = mock.world as Any;

  it('takes 1.5% plus 0.30 on every payment, rounded up to the asset’s smallest unit', async () => {
    const payments = await all(mock, 'payment.list', {});
    expect(payments.length).toBeGreaterThan(100);
    const taken = payments.filter((p) => ['captured', 'settled', 'refunded', 'disputed'].includes(p.status));
    expect(taken.length).toBeGreaterThan(50);
    for (const p of taken) {
      const places = p.assetId === 'USD' ? 4n : 0n; // USD rounds up to a cent, USDT to the sixth place
      const unit = 10n ** places;
      const bps = ceilDiv(ceilDiv(micro(p.amount) * 150n, 10_000n), unit) * unit;
      expect(micro(p.pricingSnapshot.fee), `${p.id} ${p.amount} ${p.assetId}`).toBe(bps + micro('0.30'));
    }
    // the example the audit flagged: 47.13 paid, fee 1.00695, never 1.20
    const forty = payments.find((p) => p.amount === '47.13')!;
    expect(forty.pricingSnapshot.fee).toBe('1.00695');
    // a payment that took no money carries no fee
    for (const p of payments.filter((x) => ['created', 'authorized', 'failed'].includes(x.status))) expect(p.pricingSnapshot).toBeNull();
  });

  it('settles exactly the payments it says it settled: gross, fees and net are their sums', async () => {
    const settlements = await call(mock, 'settlement.list', { limit: 50 }).then((r) => r.items as Any[]);
    expect(settlements.length).toBe(6);
    for (const s of settlements) {
      const lines = await all(mock, 'settlement.lines', { settlementId: s.id });
      const members = lines.map((l) => world.paymentById(l.paymentId));
      expect(members.length).toBeGreaterThan(0);
      for (const m of members) {
        expect(m.status).toBe('settled');
        expect(m.assetId).toBe(s.assetId);
        expect(m.settlementId).toBe(s.id);
      }
      expect(micro(s.gross)).toBe(total(members.map((m) => m.amount)));
      expect(micro(s.fees)).toBe(total(members.map((m) => m.pricingSnapshot.fee)));
      expect(micro(s.net)).toBe(micro(s.gross) - micro(s.fees));
    }
    // no payment is in two settlements
    const ids = settlements.flatMap((s) => world.settlementById(s.id).members as string[]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows the same refunds on the refund list, the payment, Home and the fees page', async () => {
    const refunds = await all(mock, 'payment.refunds.list', {});
    const real = refunds.filter((r) => r.status === 'posted' || r.status === 'settled');
    const payments = await all(mock, 'payment.list', {});
    const refundedPayments = payments.filter((p) => p.status === 'refunded');
    expect(refundedPayments.length).toBeGreaterThan(0);
    for (const p of refundedPayments) {
      const row = real.find((r) => r.paymentId === p.id);
      expect(row, `a refund for ${p.id}`).toBeDefined();
      expect(micro(row.amount)).toBe(micro(p.refundedAmount));
    }
    // a refund that was turned back leaves its payment un-refunded
    for (const r of refunds.filter((x) => x.status === 'reversed'))
      expect(payments.find((p) => p.id === r.paymentId).refundedAmount).toBe('0');
    const snapshot = await call(mock, 'merchantMetrics.snapshot', {
      merchantId: MERCHANT,
      window: { kind: 'preset', preset: 'rolling_30d' },
    });
    const fees = await call(mock, 'merchantAnalytics.fees', { merchantId: MERCHANT, bucket: 'day', ...utcDays(30) });
    for (const asset of ['USDT', 'USD']) {
      const fromList = total(
        payments.filter((p) => p.assetId === asset && Date.parse(p.createdAt) >= sinceMidnight(30)).map((p) => p.refundedAmount),
      );
      const home = snapshot.refunded.find((r: Any) => r.assetCode === asset)?.amount ?? '0';
      const page = total((fees.items as Any[]).filter((i) => i.assetCode === asset).map((i) => i.refunded));
      expect(micro(home), `Home refunded ${asset}`).toBe(fromList);
      expect(page, `Fees page refunded ${asset}`).toBe(fromList);
    }
  });

  it('adds Home’s totals up from the payments list', async () => {
    const payments = await all(mock, 'payment.list', {});
    for (const [preset, days] of [
      ['today', 1],
      ['rolling_7d', 7],
      ['rolling_30d', 30],
    ] as const) {
      const snapshot = await call(mock, 'merchantMetrics.snapshot', { merchantId: MERCHANT, window: { kind: 'preset', preset } });
      // whole UTC days, so "today" is since midnight and "30 days" is today and the 29 before
      const inside = payments.filter((p) => Date.parse(p.createdAt) >= sinceMidnight(days));
      expect(snapshot.paymentCount, preset).toBe(inside.length);
      expect(
        snapshot.statusMix.reduce((t: number, r: Any) => t + r.count, 0),
        preset,
      ).toBe(inside.length);
      for (const row of snapshot.captured) {
        const mine = inside.filter(
          (p) => p.assetId === row.assetCode && ['captured', 'settled', 'refunded', 'disputed'].includes(p.status),
        );
        expect(micro(row.amount), `${preset} ${row.assetCode}`).toBe(total(mine.map((p) => p.capturedAmount)));
      }
      for (const row of snapshot.feeRevenue) {
        const mine = inside.filter((p) => p.assetId === row.assetCode && p.pricingSnapshot);
        expect(micro(row.amount), `${preset} fee ${row.assetCode}`).toBe(total(mine.map((p) => p.pricingSnapshot.fee)));
      }
    }
  });

  it('gives a customer a lifetime that is never less than the last 30 days', async () => {
    const customers = await all(mock, 'merchantOps.customers.list', {});
    expect(customers.length).toBe(30);
    for (const c of customers.slice(0, 10)) {
      const series = await call(mock, 'merchantOps.customers.series', { customerRef: c.customerRef, ...thirtyDays });
      for (const t of c.totals) {
        const recent = total(series.items.filter((i: Any) => i.assetCode === t.assetId).map((i: Any) => i.volume));
        expect(micro(t.capturedAmount), `${c.customerRef} ${t.assetId}`).toBeGreaterThanOrEqual(recent);
      }
      const theirs = (await all(mock, 'payment.list', { search: c.customerRef })).length;
      expect(c.paymentCount, c.customerRef).toBe(theirs);
      const detail = await call(mock, 'merchantOps.customers.get', { customerRef: c.customerRef });
      for (const p of detail.recentPayments) expect(world.paymentById(p.paymentId).customerRef).toBe(c.customerRef);
    }
  });

  it('puts no payout in the statement that was not paid out, and ties out to the balances', async () => {
    const statement = await all(mock, 'merchant.statement.list', {
      merchantId: MERCHANT,
      assetId: 'USDT',
      ...thirtyDays,
      from: new Date(NOW - 60 * DAY).toISOString(),
    });
    const payouts = statement.filter((l) => l.kind === 'payout');
    const settlements = (await call(mock, 'settlement.list', { limit: 50 })).items as Any[];
    const paidOut = settlements.filter((s) => s.status === 'paid_out' && s.assetId === 'USDT');
    expect(payouts.length).toBe(paidOut.length);
    for (const line of payouts) expect(paidOut.map((s) => s.id)).toContain(line.settlementId);
    // a settlement still waiting for approval, or failed, is not a ledger event
    const waiting = (await all(mock, 'merchantControl.approvals.list', { status: 'pending' })).map((a) => a.settlementId);
    for (const line of payouts) expect(waiting).not.toContain(line.settlementId);
    const page = await call(mock, 'merchant.statement.list', {
      merchantId: MERCHANT,
      assetId: 'USDT',
      from: new Date(NOW - 60 * DAY).toISOString(),
      to: new Date(NOW + 1).toISOString(),
      limit: 200,
    });
    const snapshot = await call(mock, 'merchantMetrics.snapshot', { merchantId: MERCHANT, window: { kind: 'preset', preset: 'today' } });
    const usdt = page.tieOut.accounts.find((a: Any) => a.assetId === 'USDT');
    expect(usdt.clearing.matches).toBe(true);
    expect(usdt.proceeds.matches).toBe(true);
    const home = snapshot.balances.find((b: Any) => b.assetCode === 'USDT');
    expect(micro(usdt.clearing.ledger)).toBe(micro(home.clearing));
    expect(micro(usdt.proceeds.ledger)).toBe(micro(home.available));
    // no account ever goes below zero along the way
    for (const line of statement) {
      if (line.runningClearing !== null) expect(micro(line.runningClearing)).toBeGreaterThanOrEqual(0n);
      if (line.runningProceeds !== null) expect(micro(line.runningProceeds)).toBeGreaterThanOrEqual(0n);
    }
  });

  it('names one set of payout destinations everywhere', async () => {
    const destinations = await all(mock, 'merchant.payoutDestinations.list', { merchantId: MERCHANT });
    expect(destinations.length).toBeGreaterThan(0);
    const key = (d: Any) => `${d.railId}|${d.kind ?? d.destinationKind}|${d.destinationMasked}`;
    const known = new Set(destinations.map(key));
    const onboarding = await call(mock, 'merchant.onboarding.progress', { merchantId: MERCHANT });
    for (const d of onboarding.destination.destinations) expect(known, `onboarding ${key(d)}`).toContain(key(d));
    const approvals = await all(mock, 'merchantControl.approvals.list', {});
    for (const a of approvals) expect(known, `approval ${a.approvalId}`).toContain(key(a));
    const settlements = (await call(mock, 'settlement.list', { limit: 50 })).items as Any[];
    const paid = settlements.find((s) => s.status === 'paid_out')!;
    const lifecycle = await call(mock, 'settlement.lifecycle', { settlementId: paid.id });
    expect(known).toContain(key(lifecycle.destination));
  });

  it('makes every approval the size of the settlement it is for', async () => {
    const approvals = await all(mock, 'merchantControl.approvals.list', {});
    expect(approvals.length).toBeGreaterThan(3);
    for (const a of approvals) {
      const s = (await call(mock, 'settlement.get', { settlementId: a.settlementId })) as Any;
      expect(a.amount).toBe(s.net);
      expect(a.assetCode).toBe(s.assetId);
    }
    // one posted settlement is left for a person to pay out right now
    const pending = new Set(approvals.filter((a) => a.status === 'pending').map((a) => a.settlementId));
    const posted = (await call(mock, 'settlement.list', { limit: 50, status: 'posted' })).items as Any[];
    expect(posted.filter((s) => !pending.has(s.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps disputes in step with the payments they are about', async () => {
    const disputes = await all(mock, 'merchantOps.disputes.list', {});
    const summary = await call(mock, 'merchantOps.disputes.summary', {});
    expect(summary.total).toBe(disputes.length);
    const open = disputes.filter((d) => d.status === 'open' || d.status === 'contested');
    const atRisk = summary.amountAtRisk.reduce((t: bigint, r: Any) => t + micro(r.amount), 0n);
    expect(atRisk).toBe(total(open.map((d) => d.amount)));
    for (const d of disputes) {
      const p = world.paymentById(d.paymentId);
      expect(p.amount).toBe(d.amount);
      expect(p.assetId).toBe(d.assetId);
    }
    // an answer that is still owed has a deadline
    for (const d of disputes.filter((x) => x.status === 'open')) expect(d.responseDueAt).not.toBeNull();
    // a payment marked disputed has a dispute
    const payments = await all(mock, 'payment.list', { status: 'disputed' });
    expect(payments.length).toBe(open.length);
  });

  it('shows a subscription’s billing cycles whenever it shows its billing runs', async () => {
    const subs = await all(mock, 'subscription.list', {});
    for (const s of subs) {
      const runs = await call(mock, 'subscription.listExecutions', { subscriptionId: s.id });
      const cycles = await call(mock, 'subscription.cycles', { subscriptionId: s.id });
      expect(runs.length).toBeGreaterThan(0);
      expect(cycles.cycles.map((c: Any) => c.occurrence)).toEqual(runs.map((r: Any) => r.occurrence));
      for (const r of runs.filter((x: Any) => x.paymentId)) expect(world.paymentById(r.paymentId).amount).toBe(r.amount);
    }
  });

  it('counts a payment link’s uses from the payments that came through it', async () => {
    const links = await all(mock, 'merchant.listLinks', { merchantId: MERCHANT });
    for (const link of links) {
      const through = await all(mock, 'payment.list', { linkId: link.id });
      expect(through.filter((p) => ['captured', 'settled', 'refunded', 'disputed'].includes(p.status)).length, link.label).toBe(link.uses);
      if (link.maxUses !== null) expect(link.uses).toBeLessThanOrEqual(link.maxUses);
      expect(link.checkoutUrl).toContain(link.prefix);
    }
  });

  it('shows team, payment, dispute and export events in the activity feed, and honours its filters', async () => {
    const feed = await all(mock, 'merchantOps.activity.list', {});
    const types = new Set(feed.map((r) => r.objectType));
    for (const t of ['team', 'payment', 'dispute', 'export', 'kyb', 'approval']) expect(types, t).toContain(t);
    const onlyTeam = await all(mock, 'merchantOps.activity.list', { objectType: 'team' });
    expect(onlyTeam.length).toBeGreaterThan(0);
    expect(onlyTeam.every((r) => r.objectType === 'team')).toBe(true);
    const recent = await all(mock, 'merchantOps.activity.list', { from: new Date(NOW - 2 * DAY).toISOString() });
    expect(recent.length).toBeLessThan(feed.length);
  });

  it('honours the status, asset and date filters on the lists that offer them', async () => {
    const subs = await all(mock, 'subscription.list', { status: 'paused' });
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s) => s.status === 'paused')).toBe(true);
    const refunds = await all(mock, 'payment.refunds.list', { assetId: 'USD' });
    expect(refunds.every((r) => r.assetId === 'USD')).toBe(true);
    const everyRefund = await all(mock, 'payment.refunds.list', {});
    expect(refunds.length).toBeLessThan(everyRefund.length);
    const disputes = await all(mock, 'merchantOps.disputes.list', { from: new Date(NOW - 2 * DAY).toISOString() });
    expect(disputes.length).toBe(1);
  });

  it('quiet and new accounts have nothing to add up, and say so', async () => {
    for (const scenario of ['quiet', 'new']) {
      const empty = createPortalMock(scenario, { now: NOW });
      expect(await all(empty, 'payment.list', {})).toEqual([]);
      expect((empty.world as Any).settlements).toEqual([]);
      const snapshot = await call(empty, 'merchantMetrics.snapshot', {
        merchantId: MERCHANT,
        window: { kind: 'preset', preset: 'rolling_30d' },
      });
      expect(snapshot.paymentCount).toBe(0);
    }
  });
});

describe('writes change the one set of facts', () => {
  it('a refund shows on the payment, the refund list, Home and the statement, and a replay does nothing more', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const target = (await all(mock, 'payment.list', { status: 'captured' }))[0];
    const before = await call(mock, 'merchantMetrics.snapshot', {
      merchantId: MERCHANT,
      window: { kind: 'preset', preset: 'rolling_30d' },
    });
    const refunded = await call(mock, 'payment.refund', { paymentId: target.id, amount: '10.00', refundId: 'TEST-refund-new' });
    expect(refunded.refundedAmount).toBe('10.00');
    await call(mock, 'payment.refund', { paymentId: target.id, amount: '10.00', refundId: 'TEST-refund-new' });
    expect((await call(mock, 'payment.get', { paymentId: target.id })).refundedAmount).toBe('10.00');
    const list = await all(mock, 'payment.refunds.list', { paymentId: target.id });
    expect(list.map((r) => r.refundId)).toEqual(['TEST-refund-new']);
    const after = await call(mock, 'merchantMetrics.snapshot', { merchantId: MERCHANT, window: { kind: 'preset', preset: 'rolling_30d' } });
    const sum = (s: Any, asset: string) => micro(s.refunded.find((r: Any) => r.assetCode === asset)?.amount ?? '0');
    // refunded totals count refunded payments, so a part refund shows on the payment and the refund list first
    expect(sum(after, target.assetId)).toBeGreaterThanOrEqual(sum(before, target.assetId));
    // more than was paid is refused
    await expect(call(mock, 'payment.refund', { paymentId: target.id, amount: '999999', refundId: 'TEST-too-much' })).rejects.toThrow(
      'pay.refund_amount_invalid',
    );
  });
  it('a new payment link appears in the list with its address, and can be switched off', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const made = await call(mock, 'merchant.createLink', { merchantId: MERCHANT, label: 'TEST new link' });
    expect(made.token).toContain('TEST-token');
    const links = await all(mock, 'merchant.listLinks', { merchantId: MERCHANT });
    const row = links.find((l) => l.id === made.id);
    expect(row.active).toBe(true);
    expect(row.checkoutUrl).toContain(made.prefix);
    await call(mock, 'merchant.deactivateLink', { merchantId: MERCHANT, linkId: made.id });
    expect((await all(mock, 'merchant.listLinks', { merchantId: MERCHANT })).find((l) => l.id === made.id).active).toBe(false);
  });
  it('a subscription is created once per idempotency key, then paused, resumed and cancelled', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const mandate = await call(mock, 'mandate.create', {
      merchantId: MERCHANT,
      customerId: 'TEST-cust-020',
      assetId: 'USDT',
      amount: '19.00',
      cadence: 'monthly',
      startsAt: new Date(NOW + DAY).toISOString(),
    });
    const input = { mandateId: mandate.id, path: 'crypto_invoice', idempotencyKey: 'TEST-key' };
    const first = await call(mock, 'subscription.create', input);
    const again = await call(mock, 'subscription.create', input);
    expect(again.id).toBe(first.id);
    expect((await all(mock, 'subscription.list', { mandateId: mandate.id })).length).toBe(1);
    expect((await call(mock, 'subscription.pause', { subscriptionId: first.id })).status).toBe('paused');
    expect((await call(mock, 'subscription.resume', { subscriptionId: first.id })).subscription.status).toBe('active');
    expect((await call(mock, 'subscription.cancel', { subscriptionId: first.id })).status).toBe('cancelled');
  });
  it('only the owner can make these writes, and the signed-in person’s sessions can be listed and ended', async () => {
    const finance = createPortalMock('active', { now: NOW, role: 'finance', myAccess: 'finance' });
    await expect(call(finance, 'merchant.createLink', { merchantId: MERCHANT, label: 'x' })).rejects.toThrow('pay.merchant_forbidden');
    const mock = createPortalMock('active', { now: NOW });
    const seats = await call(mock, 'listSessions', { userId: '22222222-2222-4222-8222-222222222222', limit: 50 });
    expect(seats.sessions.length).toBeGreaterThan(0);
    await call(mock, 'revokeSession', { userId: seats.userId, sessionId: seats.sessions[0].id });
    expect((await call(mock, 'listSessions', { userId: seats.userId, limit: 50 })).sessions.length).toBe(seats.sessions.length - 1);
  });
  it('answers the checkout settings the pages will read, and hides fee routing from a viewer', async () => {
    const owner = await call(createPortalMock('active', { now: NOW }), 'merchant.checkoutSettings.get', { merchantId: MERCHANT });
    expect(owner.status).toBe('configured');
    expect(owner.feeRouting).not.toBeNull();
    const viewer = await call(
      createPortalMock('active', { now: NOW, role: 'viewer', myAccess: 'viewer' }),
      'merchant.checkoutSettings.get',
      { merchantId: MERCHANT },
    );
    expect(viewer.feeRouting).toBeNull();
    expect((await call(createPortalMock('quiet', { now: NOW }), 'merchant.checkoutSettings.get', { merchantId: MERCHANT })).status).toBe(
      'not_configured',
    );
  });
});

// ---- the contradictions the second acceptance audit found: each one is pinned here so it cannot come back ------------------
describe('the stand-in never contradicts itself', () => {
  const mock = createPortalMock('active', { now: NOW });
  const world = mock.world as Any;
  const statementOf = (m: Mock, assetId = 'USDT', to = NOW + 1) =>
    all(m, 'merchant.statement.list', {
      merchantId: MERCHANT,
      assetId,
      from: new Date(NOW - 60 * DAY).toISOString(),
      to: new Date(to).toISOString(),
    });

  it('keeps every refund on its payment, and the payment history proves each one with the same refund id', async () => {
    const refunds = await all(mock, 'payment.refunds.list', {});
    const payments = await all(mock, 'payment.list', {});
    expect(refunds.length).toBeGreaterThanOrEqual(4);
    for (const p of payments) {
      const mine = refunds.filter((r) => r.paymentId === p.id);
      const given = mine.filter((r) => r.status !== 'reversed').reduce((t, r) => t + micro(r.amount), 0n);
      expect(micro(p.refundedAmount), `refunded on ${p.id}`).toBe(given);
      const history = await call(mock, 'payment.history', { paymentId: p.id });
      // time order, and every event a page can prove a refund with
      expect(history.map((e: Any) => e.ts)).toEqual([...history.map((e: Any) => e.ts)].sort());
      for (const r of mine) {
        const posted = history.filter((e: Any) => e.event === 'refund.posted' && e.payload.refundId === r.refundId);
        expect(posted.length, `${r.refundId} posted`).toBe(1);
        expect(posted[0].payload.amount).toBe(r.amount);
        const confirmedEvent = r.status === 'reversed' ? 'refund.reversed' : 'refunded';
        const confirmed = history.filter((e: Any) => e.event === confirmedEvent && e.payload.refundId === r.refundId);
        expect(confirmed.length, `${r.refundId} ${confirmedEvent}`).toBe(1);
        expect(micro(confirmed[0].payload.amount)).toBe(micro(r.amount));
        if (r.status === 'settled') expect(confirmed[0].ts).toBe(r.settledAt);
      }
    }
    // a part refund is among them: the payment keeps its own status and says how much has gone back
    const part = payments.find((p) => micro(p.refundedAmount) > 0n && p.status !== 'refunded');
    expect(part, 'a part-refunded payment').toBeDefined();
    expect(micro(part.refundedAmount)).toBeLessThan(micro(part.capturedAmount));
  });

  it('proves a refund made now, a part refund included, with a refunded event that carries its refund id', async () => {
    const m = createPortalMock('active', { now: NOW });
    const target = (await all(m, 'payment.list', { status: 'captured' }))[0];
    await call(m, 'payment.refund', { paymentId: target.id, amount: '10.00', refundId: 'TEST-part-1' });
    await call(m, 'payment.refund', { paymentId: target.id, amount: '5.00', refundId: 'TEST-part-2' });
    // the same request again is a replay: no third refund
    await call(m, 'payment.refund', { paymentId: target.id, amount: '5.00', refundId: 'TEST-part-2' });
    const history = await call(m, 'payment.history', { paymentId: target.id });
    for (const [id, amount] of [
      ['TEST-part-1', '10.00'],
      ['TEST-part-2', '5.00'],
    ]) {
      const refunded = history.filter((e: Any) => e.event === 'refunded' && e.payload.refundId === id);
      expect(refunded.length, id).toBe(1);
      expect(refunded[0].payload.amount).toBe(amount);
      expect(history.filter((e: Any) => e.event === 'refund.posted' && e.payload.refundId === id).length).toBe(1);
    }
    const after = await call(m, 'payment.get', { paymentId: target.id });
    expect(micro(after.refundedAmount)).toBe(micro('15'));
    expect(after.status).toBe('captured');
    // the rest goes back: the payment is refunded, and the refund list agrees
    const rest = fromMicro(micro(target.amount) - micro('15'));
    await call(m, 'payment.refund', { paymentId: target.id, amount: rest, refundId: 'TEST-part-3' });
    expect((await call(m, 'payment.get', { paymentId: target.id })).status).toBe('refunded');
    const list = await all(m, 'payment.refunds.list', { paymentId: target.id });
    expect(list.map((r) => r.status)).toEqual(['settled', 'settled', 'settled']);
  });

  it('says the same about a refund on the refund list, the payment and the refund itself', async () => {
    const refunds = await all(mock, 'payment.refunds.list', {});
    for (const r of refunds) {
      const detail = await call(mock, 'payment.refunds.get', { refundEventId: r.id });
      expect(detail.status, r.refundId).toBe(r.status);
      expect(detail.settledAt, r.refundId).toBe(r.settledAt);
      const payment = await call(mock, 'payment.get', { paymentId: r.paymentId });
      // a refund the network confirmed has a completion time; one still in progress has none; a payment never reads
      // Refunded while one of its refunds is still in progress
      expect(r.settledAt !== null, `${r.refundId} completed`).toBe(r.status === 'settled');
      if (payment.status === 'refunded')
        expect(refunds.filter((x) => x.paymentId === r.paymentId).every((x) => x.status !== 'posted')).toBe(true);
      if (r.status === 'reversed') expect(payment.status).not.toBe('refunded');
    }
  });

  it('takes a refund from the pot its money is in: pending until the payment is settled, then the settled balance', async () => {
    const refunds = (await all(mock, 'payment.refunds.list', {})).filter((r) => r.status !== 'reversed');
    const lines = await statementOf(mock);
    const kinds = new Set<string>();
    for (const r of refunds) {
      const settled = world.paymentById(r.paymentId).settlementId !== null;
      kinds.add(settled ? 'settled' : 'clearing');
      expect(r.source, r.refundId).toBe(settled ? 'settled' : 'clearing');
      expect(r.ledgerEffect.pot).toBe(settled ? 'merchantProceeds' : 'clearing');
      const line = lines.find((l) => l.kind === 'refund' && l.paymentId === r.paymentId);
      expect(line, `a statement line for ${r.refundId}`).toBeDefined();
      expect(line.account, r.refundId).toBe(settled ? 'proceeds' : 'clearing');
    }
    expect([...kinds].sort()).toEqual(['clearing', 'settled']);
    // and a refund made now follows the same rule
    const m = createPortalMock('active', { now: NOW });
    const inSettlement = (await all(m, 'payment.list', { status: 'settled' })).find((p) => p.assetId === 'USDT')!;
    const fresh = (await all(m, 'payment.list', { status: 'captured' })).find((p) => p.assetId === 'USDT')!;
    await call(m, 'payment.refund', { paymentId: inSettlement.id, amount: '1.00', refundId: 'TEST-from-settled' });
    await call(m, 'payment.refund', { paymentId: fresh.id, amount: '1.00', refundId: 'TEST-from-pending' });
    const made = await all(m, 'payment.refunds.list', {});
    expect(made.find((r) => r.refundId === 'TEST-from-settled').source).toBe('settled');
    expect(made.find((r) => r.refundId === 'TEST-from-pending').source).toBe('clearing');
    // refunds made now are stamped with the real clock, which is later than the stand-in's fixed one
    const after = await statementOf(m, 'USDT', Date.now() + DAY);
    expect(after.find((l) => l.kind === 'refund' && l.paymentId === inSettlement.id && l.amount === '1.00').account).toBe('proceeds');
    expect(after.find((l) => l.kind === 'refund' && l.paymentId === fresh.id).account).toBe('clearing');
  });

  it('gives each settlement its own timeline, drawn from its payments’ dates and its approvals', async () => {
    const settlements = (await call(mock, 'settlement.list', { limit: 50 })).items as Any[];
    const story = new Set<string>();
    for (const s of settlements) {
      const lifecycle = await call(mock, 'settlement.lifecycle', { settlementId: s.id });
      const events = lifecycle.events as Any[];
      const memberTimes = (world.settlementById(s.id).members as string[]).map((id) => Date.parse(world.paymentById(id).createdAt));
      const opened = events.find((e) => e.kind === 'settlement.opened');
      // it opens with its oldest payment, and nothing happens before that
      expect(Date.parse(opened.at), `${s.window} opens`).toBe(Math.min(...memberTimes));
      expect(events.every((e) => e.at >= opened.at)).toBe(true);
      expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort());
      // it is finalised two hours after its newest payment (a paid-out one goes straight on to its approvals)
      const posted = events.find((e) => e.kind === 'settlement.posted');
      if (s.status !== 'paid_out') expect(Date.parse(posted.at), `${s.window} finalised`).toBe(Math.max(...memberTimes) + 2 * 3600_000);
      else expect(posted).toBeUndefined();
      // approvals come after the statement is final
      for (const e of events.filter((x) => x.kind.startsWith('approval.')))
        expect(Date.parse(e.at), `${s.window} ${e.kind}`).toBeGreaterThan(Math.max(...memberTimes));
      if (s.status === 'paid_out') {
        const sent = events.find((e) => e.kind === 'rail.sent');
        const confirmed = events.find((e) => e.kind === 'rail.confirmed');
        for (const e of events.filter((x) => x.kind.startsWith('approval.'))) expect(e.at < sent.at).toBe(true);
        expect(events.at(-1)).toBe(confirmed);
        expect(Date.parse(confirmed.at)).toBeGreaterThan(Date.parse(sent.at));
      }
      story.add(`${opened.at}|${posted?.at ?? ''}`);
    }
    // no two settlements share the same dates
    expect(story.size).toBe(settlements.length);
  });

  it('keeps an approval’s status in step with its payout’s status', async () => {
    const approvals = await all(mock, 'merchantControl.approvals.list', {});
    const settlements = (await call(mock, 'settlement.list', { limit: 50 })).items as Any[];
    const byId = new Map(settlements.map((s) => [s.id, s]));
    for (const a of approvals) {
      const s = byId.get(a.settlementId)!;
      const later = approvals.filter((x) => x.settlementId === a.settlementId && x.createdAt > a.createdAt);
      // a used approval is a payout that was sent: paid out, or refused by the payment network after it was sent
      if (a.status === 'consumed' || a.status === 'approved') expect(['paid_out', 'failed'], `${a.approvalId} used`).toContain(s.status);
      // a payout that went ahead after a rejection or a withdrawal was asked for again, and that later request was approved
      if (a.status === 'rejected' || a.status === 'voided' || a.status === 'pending') {
        if (s.status === 'paid_out')
          expect(
            later.some((x) => x.status === 'consumed'),
            `${a.approvalId} ${a.status} but paid out`,
          ).toBe(true);
        else expect(['posted', 'failed']).toContain(s.status);
      }
      // the person who asks is never the person who decides
      if (a.checkerUserId) expect(a.checkerUserId).not.toBe(a.makerUserId);
    }
    // a payout above the approval threshold was approved first, except the oldest, which predates approvals
    const oldest = settlements.reduce((m, s) => (s.createdAt < m.createdAt ? s : m));
    for (const s of settlements.filter((x) => x.status === 'paid_out' && x.id !== oldest.id && micro(x.net) >= micro('1000')))
      expect(
        approvals.some((a) => a.settlementId === s.id && a.status === 'consumed'),
        s.window,
      ).toBe(true);
    // the lifecycle tells the same story as the approvals
    for (const s of settlements) {
      const events = (await call(mock, 'settlement.lifecycle', { settlementId: s.id })).events as Any[];
      for (const a of approvals.filter((x) => x.settlementId === s.id)) {
        const mine = events.filter((e) => e.approvalId === a.approvalId).map((e) => e.kind);
        expect(mine[0]).toBe('approval.requested');
        const decided: Record<string, string | undefined> = {
          consumed: 'approval.approved',
          approved: 'approval.approved',
          rejected: 'approval.rejected',
          voided: 'approval.voided',
        };
        expect(mine[1]).toBe(decided[a.status as string]);
      }
    }
  });

  it('counts today’s payouts in the daily limit, and leaves a payable settlement that fits and an approval that does not', async () => {
    const usage = await call(mock, 'merchantControl.usage', { merchantId: MERCHANT });
    const row = usage.rows.find((r: Any) => r.kind === 'daily_payout');
    const settlements = (await call(mock, 'settlement.list', { limit: 50 })).items as Any[];
    const today = settlements
      .filter((s) => s.status === 'paid_out' && s.assetId === 'USDT' && Date.parse(world.settlementById(s.id).sentAt) >= MIDNIGHT)
      .reduce((t, s) => t + micro(s.net), 0n);
    expect(micro(row.used)).toBe(today);
    expect(micro(row.remaining)).toBe(micro(row.limit) - today);
    const approvals = await all(mock, 'merchantControl.approvals.list', { status: 'pending' });
    const waiting = new Set(approvals.map((a) => a.settlementId));
    const payable = settlements.filter((s) => s.status === 'posted' && s.assetId === 'USDT' && !waiting.has(s.id));
    expect(
      payable.some((s) => micro(s.net) <= micro(row.remaining)),
      'a settlement that can be paid out now',
    ).toBe(true);
    expect(
      approvals.some((a) => micro(a.amount) > micro(row.remaining)),
      'one approval over what is left',
    ).toBe(true);
    expect(
      approvals.some((a) => micro(a.amount) <= micro(row.remaining)),
      'one approval that fits',
    ).toBe(true);
    // paying one out uses the limit up by exactly its size
    const m = createPortalMock('active', { now: NOW });
    const settlement = payable.find((s) => micro(s.net) <= micro(row.remaining))!;
    await call(m, 'settlement.payout', { settlementId: settlement.id, railId: 'crypto-native' });
    const next = (await call(m, 'merchantControl.usage', { merchantId: MERCHANT })).rows.find((r: Any) => r.kind === 'daily_payout');
    expect(micro(next.used)).toBe(micro(settlement.net));
    expect(micro(next.remaining)).toBe(micro(row.remaining) - micro(settlement.net));
  });

  it('shows the same figure as Paid in, Captured and Gross for the same days', async () => {
    for (const [preset, days] of [
      ['today', 1],
      ['rolling_7d', 7],
      ['rolling_30d', 30],
    ] as const) {
      const snapshot = await call(mock, 'merchantMetrics.snapshot', { merchantId: MERCHANT, window: { kind: 'preset', preset } });
      const volume = await call(mock, 'merchantAnalytics.volume', { merchantId: MERCHANT, bucket: 'day', ...utcDays(days) });
      const fees = await call(mock, 'merchantAnalytics.fees', { merchantId: MERCHANT, bucket: 'day', ...utcDays(days) });
      const listed = (await all(mock, 'payment.list', { from: utcDays(days).from })).filter((p) => TAKEN.includes(p.status));
      for (const asset of ['USDT', 'USD']) {
        const captured = micro(snapshot.captured.find((r: Any) => r.assetCode === asset)?.amount ?? '0');
        expect(total((volume.items as Any[]).filter((i) => i.assetCode === asset).map((i) => i.volume)), `${preset} volume ${asset}`).toBe(
          captured,
        );
        expect(total((fees.items as Any[]).filter((i) => i.assetCode === asset).map((i) => i.gross)), `${preset} gross ${asset}`).toBe(
          captured,
        );
        const refunded = micro(snapshot.refunded.find((r: Any) => r.assetCode === asset)?.amount ?? '0');
        expect(
          total((fees.items as Any[]).filter((i) => i.assetCode === asset).map((i) => i.refunded)),
          `${preset} refunded ${asset}`,
        ).toBe(refunded);
        // and the payments list, asked for the same days, adds up to it
        expect(total(listed.filter((p) => p.assetId === asset).map((p) => p.capturedAmount)), `${preset} listed ${asset}`).toBe(captured);
      }
    }
  });

  it('counts the intake limits for the same UTC days Home calls today and 30 days', async () => {
    const usage = await call(mock, 'merchantControl.usage', { merchantId: MERCHANT });
    const today = await call(mock, 'merchantMetrics.snapshot', { merchantId: MERCHANT, window: { kind: 'preset', preset: 'today' } });
    const month = await call(mock, 'merchantMetrics.snapshot', { merchantId: MERCHANT, window: { kind: 'preset', preset: 'rolling_30d' } });
    expect(usage.rows.find((r: Any) => r.kind === 'daily_intake').used).toBe(
      today.captured.find((r: Any) => r.assetCode === 'USDT').amount,
    );
    expect(usage.rows.find((r: Any) => r.kind === 'monthly_intake').used).toBe(
      month.captured.find((r: Any) => r.assetCode === 'USDT').amount,
    );
  });

  it('names a person the same way on the Team page and in a notification', async () => {
    const team = await all(mock, 'merchantOps.team.list', {});
    const labels = team.map((m) => m.label).filter(Boolean);
    const notes = await all(mock, 'merchantOps.notifications.list', {});
    const joined = notes.find((n) => n.kind === 'team_change');
    expect(
      labels.some((label) => joined.title.includes(label)),
      joined.title,
    ).toBe(true);
    for (const n of notes) for (const m of team) expect(`${n.title} ${n.body ?? ''}`, n.title).not.toContain(m.userId);
  });

  it('gives a payment a reference a person can read out, and the dispute on it the same one', async () => {
    const payments = await all(mock, 'payment.list', {});
    for (const p of payments.filter((x) => x.railRef)) {
      expect(p.railRef, p.id).not.toMatch(/rail/i);
      // the same number as the order it paid for: payment 8 is "TEST order 1008" and "TEST-1008"
      const number = Number.parseInt(p.id.slice(2, 8), 10);
      expect(p.railRef).toBe(`TEST-${1000 + number}`);
      if (p.description.startsWith('TEST order')) expect(p.description).toBe(`TEST order ${1000 + number}`);
    }
    const disputes = await all(mock, 'merchantOps.disputes.list', {});
    expect(disputes.length).toBeGreaterThan(0);
    for (const d of disputes) {
      const payment = await call(mock, 'payment.get', { paymentId: d.paymentId });
      const detail = await call(mock, 'merchantOps.disputes.get', { disputeId: d.disputeId });
      expect(detail.payment.paymentId).toBe(payment.id);
      expect(payment.railRef).toMatch(/^TEST-\d{4}$/);
    }
  });

  it('describes each sign-in only by what the real list returns: an id and when it began', async () => {
    const seats = await call(mock, 'listSessions', { userId: '22222222-2222-4222-8222-222222222222', limit: 50 });
    expect(seats.sessions.length).toBeGreaterThan(1);
    for (const seat of seats.sessions) {
      expect(Object.keys(seat).sort()).toEqual(['createdAt', 'id', 'revoked']);
      expect(Number.isFinite(Date.parse(seat.createdAt))).toBe(true);
    }
  });

  it('answers the network reads for a business that is not in the network with a not-a-platform refusal, not a 404', async () => {
    const child = (await call(mock, 'submerchant.list', { merchantId: MERCHANT, limit: 100 }))[0];
    expect((await call(mock, 'submerchant.get', { merchantId: child.id })).id).toBe(child.id);
    // the Network board opens /pay/network/TEST-child: it stands for the first business in the network
    expect((await call(mock, 'submerchant.get', { merchantId: 'TEST-child' })).id).toBe(child.id);
    expect((await call(mock, 'submerchant.summary', { merchantId: 'TEST-child' })).id).toBe(child.id);
    await expect(call(mock, 'submerchant.get', { merchantId: 'TEST-nobody' })).rejects.toThrow(/403.*pay\.submerchant_not_onboarded/);
    await expect(call(mock, 'submerchant.summary', { merchantId: 'TEST-nobody' })).rejects.toThrow(/403/);
    const platform = createPortalMock('active', { now: NOW, myAccess: 'payfac' });
    await expect(call(platform, 'submerchant.get', { merchantId: 'TEST-nobody' })).rejects.toThrow(/403.*pay\.submerchant_out_of_scope/);
  });

  it('makes one payment link for one request key, and hands back the address the service built', async () => {
    const m = createPortalMock('active', { now: NOW });
    const first = await call(m, 'merchant.createLink', { merchantId: MERCHANT, label: 'TEST once', idempotencyKey: 'TEST-link-key' });
    const again = await call(m, 'merchant.createLink', { merchantId: MERCHANT, label: 'TEST once', idempotencyKey: 'TEST-link-key' });
    expect(again).toEqual(first);
    expect(first.checkoutUrl).toContain(first.prefix);
    expect((await all(m, 'merchant.listLinks', { merchantId: MERCHANT })).filter((l) => l.label === 'TEST once').length).toBe(1);
  });
});

describe('the stand-in restores a sign-in the way the cookie would', () => {
  /** A page that only records the routes the stand-in installs, so the identity handler can be driven directly. */
  async function identityOf(mock: Mock) {
    const routes: { pattern: string; handler: (route: Any) => Promise<unknown> }[] = [];
    await mock.install({
      route: async (pattern: string, handler: (route: Any) => Promise<unknown>) => routes.push({ pattern, handler }),
    } as never);
    const handler = routes.find((r) => r.pattern.includes('/api/identity/'))!.handler;
    return async (procedure: string, headers: Record<string, string> = {}, withHeaders = true) => {
      let answer = 'fallback' as { status: number; body: string } | 'fallback';
      const request = {
        url: () => `http://stand-in.test/api/identity/trpc/${procedure}`,
        method: () => 'POST',
        postDataJSON: () => ({}),
        ...(withHeaders ? { headers: () => headers } : {}),
      };
      await handler({
        request: () => request,
        fulfill: async (r: { status?: number; body: string }) => {
          answer = { status: r.status ?? 200, body: r.body };
        },
        fallback: async () => undefined,
      });
      return answer === 'fallback' ? answer : { status: answer.status, data: JSON.parse(answer.body).result?.data };
    };
  }

  it('says nothing before anyone has signed in, then restores the session on a reload, until sign-out', async () => {
    const identity = await identityOf(createPortalMock('active', { now: NOW }));
    expect(await identity('auth.refresh')).toBe('fallback');
    // the person signs in: their next requests carry the token the app holds
    expect(await identity('listSessions', { authorization: 'Bearer TEST-signed-in' })).not.toBe('fallback');
    const restored = (await identity('auth.refresh')) as Any;
    expect(restored.status).toBe(200);
    expect(restored.data.userId).toBe('22222222-2222-4222-8222-222222222222');
    expect(restored.data.accessToken).toBe('TEST-signed-in');
    expect(Date.parse(restored.data.expiresAt)).toBeGreaterThan(Date.now());
    // signing out forgets it
    expect(((await identity('auth.logout')) as Any).data).toEqual({ ok: true });
    expect(await identity('auth.refresh')).toBe('fallback');
  });

  it('always restores for a caller that cannot show request headers (the preview server answers sign-in itself)', async () => {
    const identity = await identityOf(createPortalMock('active', { now: NOW }));
    expect(((await identity('auth.refresh', {}, false)) as Any).status).toBe(200);
  });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
describe('what the stand-in mints is shaped like what the service mints', () => {
  it('gives every refund it makes a real uuid, so the refunds-issued figure can be read', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const target = (await all(mock, 'payment.list', { status: 'captured' }))[0];
    await call(mock, 'payment.refund', { paymentId: target.id, amount: '10', refundId: 'TEST-refund-uuid' });
    const rows = await all(mock, 'payment.refunds.list', {});
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.id, 'refund id').toMatch(UUID);
      if (row.ledgerEffect?.ledgerTxId) expect(row.ledgerEffect.ledgerTxId, 'ledger tx id').toMatch(UUID);
    }
    // a refund of "10" reads "10.00", as every amount does
    expect(rows.find((r) => r.refundId === 'TEST-refund-uuid').amount).toBe('10.00');
  });
  it('gives links, subscriptions, approvals and quotes real uuids', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const link = await call(mock, 'merchant.createLink', { merchantId: MERCHANT, label: 'TEST uuid link' });
    expect(link.id ?? link.link?.id).toMatch(UUID);
    const quote = await call(mock, 'conversion.quote', { settlementId: 'x', fromAsset: 'USDT', toAsset: 'USD', fromAmount: '100' });
    expect(quote.quoteId).toMatch(UUID);
    for (const a of await all(mock, 'merchantControl.approvals.list', {})) expect(a.approvalId).toMatch(UUID);
  });
  it('dates a new link 30 days from when it is made', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const before = Date.now();
    const made = await call(mock, 'merchant.createLink', { merchantId: MERCHANT, label: 'TEST expiry' });
    const expires = Date.parse((made.link ?? made).expiresAt);
    expect(expires - before).toBeGreaterThanOrEqual(30 * DAY - 1000);
    expect(expires - Date.now()).toBeLessThanOrEqual(30 * DAY);
  });
  it('shows no billing history for a subscription it does not know, never another one’s', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const unknown = '99999999-9999-4999-8999-999999999999';
    expect(await call(mock, 'subscription.listExecutions', { subscriptionId: unknown })).toEqual([]);
    expect((await call(mock, 'subscription.cycles', { subscriptionId: unknown })).cycles).toEqual([]);
    const known = (await all(mock, 'subscription.list', {}))[0];
    expect((await call(mock, 'subscription.listExecutions', { subscriptionId: known.id })).length).toBeGreaterThan(0);
  });
});

describe('a subscription made since boot', () => {
  it('has no billing history, and the seeded subscriptions keep their own', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const seeded = await all(mock, 'subscription.list', {});
    const before = await Promise.all(seeded.map(async (s) => (await call(mock, 'subscription.cycles', { subscriptionId: s.id })).cycles));
    const mandate = await call(mock, 'mandate.create', {
      merchantId: MERCHANT,
      customerId: 'TEST-cust-020',
      assetId: 'USDT',
      amount: '19.00',
      cadence: 'monthly',
      startsAt: new Date(NOW + DAY).toISOString(),
    });
    const made = await call(mock, 'subscription.create', { mandateId: mandate.id, path: 'crypto_invoice', idempotencyKey: 'TEST-hist' });
    expect((await call(mock, 'subscription.cycles', { subscriptionId: made.id })).cycles).toEqual([]);
    expect(await call(mock, 'subscription.listExecutions', { subscriptionId: made.id })).toEqual([]);
    for (const [i, s] of seeded.entries()) {
      expect((await call(mock, 'subscription.cycles', { subscriptionId: s.id })).cycles).toEqual(before[i]);
    }
    expect(before.some((c) => c.length > 0)).toBe(true);
  });
});

describe('an approval the owner can decide and then send', () => {
  it('lets the owner approve a teammate’s request that fits today’s limit, and then send it', async () => {
    const mock = createPortalMock('active', { now: NOW });
    const usage = await call(mock, 'merchantControl.usage', { merchantId: MERCHANT });
    const left = micro(usage.rows.find((r: Any) => r.kind === 'daily_payout').remaining);
    const waiting = (await all(mock, 'merchantControl.approvals.list', { status: 'pending' })).filter(
      (a) => a.makerUserId !== '22222222-2222-4222-8222-222222222222' && micro(a.amount) <= left,
    );
    expect(waiting.length, 'a request the owner can approve and send under the limit').toBeGreaterThan(0);
    const a = waiting[0];
    await call(mock, 'merchantControl.approvals.decide', {
      approvalId: a.approvalId,
      decision: 'approve',
      expectedPayloadHash: a.payloadHash,
      reason: 'TEST approve',
    });
    const sent = await call(mock, 'settlement.payout', { settlementId: a.settlementId, railId: a.railId });
    expect(sent.status).toBe('paid_out');
  });
});
