import { describe, expect, it } from 'vitest';
import { createPortalMock } from './portal.mock.mjs';

/**
 * The stand-in is one set of facts, so a page can never contradict another. These tests ask the stand-in the way the
 * pages do (through its procedures) and check the answers add up: the fee rule, settlements, refunds, customers, the
 * statement, destinations and the activity feed. They fail the day one page's numbers drift from another's.
 */
const NOW = Date.parse('2026-10-17T09:00:00.000Z');
const DAY = 86_400_000;
const MERCHANT = '11111111-1111-4111-8111-111111111111';

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
const thirtyDays = { from: new Date(NOW - 30 * DAY).toISOString(), to: new Date(NOW + 1).toISOString() };

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
    const fees = await call(mock, 'merchantAnalytics.fees', { merchantId: MERCHANT, bucket: 'day', ...thirtyDays });
    for (const asset of ['USDT', 'USD']) {
      const fromList = total(
        payments.filter((p) => p.assetId === asset && Date.parse(p.createdAt) >= NOW - 30 * DAY).map((p) => p.refundedAmount),
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
      const inside = payments.filter((p) => Date.parse(p.createdAt) >= NOW - days * DAY);
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
