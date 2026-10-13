import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import type { EngineLiveOrder, EngineOrder } from './engine/types.js';
import { reconcile, type CounterpartOrder, summarizeReconcile } from './reconcile.js';

/**
 * ENGINE ↔ COUNTERPART RECONCILE.
 *
 * There is no database in this file and there should not be. svc-matching has no
 * `DATABASE_URL` by design (`env.ts` says so, and says why), so a suite that
 * stood one up would be testing a coupling this service must never have. The
 * DB-backed half of reconciliation is svc-trade's `order-route-reconcile.test.ts`,
 * which already runs on a per-run `createTestDatabase`.
 *
 * The engine's side is proven against a REAL `MatchingEngine` with a real book
 * rather than hand-written `EngineLiveOrder` literals, because the claim being
 * made is "the engine reports what it is actually holding" — and a fixture
 * cannot be wrong in the way the engine can.
 *
 * Order ids are UUIDs for the same reason `engine.test.ts` gives: the engine
 * validates every payload against `packages/events` before publishing it, and
 * `intafaced.matching.order.accepted` requires a uuid. A readable order id never
 * reaches a book here — it is rejected at the bus — so a suite written with one
 * is testing an engine production does not have.
 */

const MARKET = 'BTC/USDT';
const OTHER_MARKET = 'ETH/USDT';

/**
 * Readable label → stable uuid, allocated in first-use order.
 *
 * The labels are what the assertions read in; the uuids are what the bus
 * accepts. Memoised, so `id('maker')` is the same order everywhere in one test
 * and a fresh one in the next.
 */
function idFactory(): (label: string) => string {
  const assigned = new Map<string, string>();
  return (label: string) => {
    const existing = assigned.get(label);
    if (existing !== undefined) return existing;
    const next = `00000000-0000-4000-8000-${String(assigned.size + 1).padStart(12, '0')}`;
    assigned.set(label, next);
    return next;
  };
}

function engineWith(): MatchingEngine {
  return new MatchingEngine({ journal: new MemoryJournal(), bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
}

function limit(orderId: string, accountLabel: string, side: 'buy' | 'sell', qty: string, price: string): EngineOrder {
  return {
    orderId,
    accountId: `acct-${accountLabel}`,
    type: 'limit',
    side,
    qty: parseAmount(qty),
    price: parseAmount(price),
    stopPrice: null,
    tif: 'GTC',
  };
}

function claim(over: Partial<CounterpartOrder> & { orderId: string }): CounterpartOrder {
  return { marketId: MARKET, state: 'open', remaining: '1', funded: true, ...over };
}

// ── The engine's own liveness read ───────────────────────────────────────────

describe('restingOrders — the non-destructive read', () => {
  it('reports a resting order with its id, account and remaining, and does not remove it', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '2', '100'));

    const first = engine.restingOrders();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      marketId: MARKET,
      orderId: id('o1'),
      accountId: 'acct-o1',
      kind: 'book',
      side: 'buy',
      remaining: '2',
    });

    // The point of the whole exercise: asking twice gives the same answer.
    // `cancel()` — the only probe that existed before — would not.
    expect(engine.restingOrders()).toEqual(first);
    expect(engine.depth(MARKET, 50)?.bids).toEqual([['100', '2']]);
  });

  it('reports the unfilled remainder after a partial fill, not the original qty', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('maker'), 'maker', 'sell', '5', '100'));
    await engine.submit(MARKET, limit(id('taker'), 'taker', 'buy', '2', '100'));

    const live = engine.restingOrders();
    expect(live).toHaveLength(1);
    expect(live[0]?.orderId).toBe(id('maker'));
    // 5 submitted, 2 taken. A reconciler comparing against the hold needs 3.
    expect(live[0]?.remaining).toBe('3');
  });

  it('includes an untriggered stop, which never appears in depth', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, {
      orderId: id('stop-1'),
      accountId: 'acct-stop',
      type: 'stop',
      side: 'sell',
      qty: parseAmount('4'),
      price: null,
      stopPrice: parseAmount('90'),
      tif: 'GTC',
    });

    // Invisible in depth — and svc-trade is holding funds for it all the same.
    expect(engine.depth(MARKET, 50)).toMatchObject({ bids: [], asks: [] });

    const live = engine.restingOrders();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ orderId: id('stop-1'), kind: 'stop', remaining: '4', price: '90' });
  });

  it('is empty once an order is cancelled, and filters by market', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '1', '100'));
    await engine.submit(OTHER_MARKET, limit(id('o2'), 'o2', 'buy', '1', '100'));

    expect(engine.restingOrders()).toHaveLength(2);
    expect(engine.restingOrders(MARKET).map((o) => o.orderId)).toEqual([id('o1')]);
    expect(engine.restingOrders('never-traded')).toEqual([]);

    await engine.cancel(MARKET, id('o1'));
    expect(engine.restingOrders().map((o) => o.orderId)).toEqual([id('o2')]);
  });

  it('survives replay — the count after recovery is the count before it', async () => {
    const id = idFactory();
    const journal = new MemoryJournal();
    const bus = new MemoryEventBus('svc-matching');
    const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 });
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '2', '100'));
    await engine.submit(MARKET, limit(id('o2'), 'o2', 'buy', '3', '99'));
    const before = engine.restingOrders();

    // This is the boot path that strands things: a fresh process, the same
    // journal, and no database on the other side any more.
    const rebooted = new MatchingEngine({ journal, bus, snapshotEvery: 0 });
    rebooted.recover();

    expect(rebooted.restingOrders()).toEqual(before);
    expect(rebooted.restingOrderCount).toBe(2);
  });
});

// ── The failure modes, in both directions ────────────────────────────────────

describe('reconcile — a clean pair is silent', () => {
  it('reports ok with no findings when both sides agree', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '2', '100'));

    const report = reconcile(engine.restingOrders(), [claim({ orderId: id('o1'), remaining: '2' })]);

    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ ok: true, refusals: 0, agreed: 1, checked: 1 });
  });

  it('treats a decimal string that spells the same amount as agreement', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '2', '100'));

    // `2` and `2.000000000000000000` are one amount and two strings. Comparing
    // them as strings would report a quantity disagreement on every order.
    const report = reconcile(engine.restingOrders(), [claim({ orderId: id('o1'), remaining: '2.000000000000000000' })]);

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('says nothing when both sides agree an order is over', () => {
    const id = idFactory();
    const report = reconcile([], [claim({ orderId: id('gone'), state: 'terminal', remaining: '0', funded: false })]);
    expect(report).toMatchObject({ ok: true, agreed: 1 });
    expect(report.findings).toEqual([]);
  });
});

describe('reconcile — ledger has a hold the engine does not (the one that strands money)', () => {
  it('refuses, and names the order and both states', () => {
    const id = idFactory();
    const report = reconcile([], [claim({ orderId: id('stranded-1'), remaining: '2', funded: true, detail: 'hold=200 USDT' })]);

    expect(report.ok).toBe(false);
    expect(report.refusals).toBe(1);

    const finding = report.findings[0];
    expect(finding?.orderId).toBe(id('stranded-1'));
    expect(finding?.case).toBe('counterpart_open_engine_missing');
    expect(finding?.verdict).toBe('refuse');

    // Both states named. A refusal that reports one side is not actionable.
    expect(finding?.engine).toContain('NOT LIVE');
    expect(finding?.counterpart).toContain('OPEN');
    expect(finding?.counterpart).toContain('remaining=2');
    expect(finding?.counterpart).toContain('hold=200 USDT');

    // And it says WHY it will not just release, which is the whole argument.
    expect(finding?.reason).toMatch(/lost fill/i);
  });

  it('does not auto-release — no verdict in the report authorises moving value', () => {
    const id = idFactory();
    const report = reconcile([], [claim({ orderId: id('stranded-1'), funded: true })]);
    expect(report.findings.every((f) => f.verdict !== 'auto')).toBe(true);
  });
});

describe('reconcile — journal has an order the counterpart does not', () => {
  it('refuses rather than cancelling a book it cannot see all of', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('phantom'), 'phantom', 'sell', '1', '100'));

    // This is the live dev-fleet shape: the engine replayed orders from a
    // journal that outlived the database, and `trade.orders` is empty.
    const report = reconcile(engine.restingOrders(), []);

    expect(report.ok).toBe(false);
    const finding = report.findings[0];
    expect(finding?.case).toBe('engine_only');
    expect(finding?.verdict).toBe('refuse');
    expect(finding?.engine).toContain('LIVE');
    expect(finding?.counterpart).toContain('UNKNOWN');
    expect(finding?.reason).toMatch(/incomplete counterpart view/i);
  });
});

describe('reconcile — both have it but disagree', () => {
  it('refuses on a quantity disagreement, naming both quantities', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('maker'), 'maker', 'sell', '5', '100'));
    await engine.submit(MARKET, limit(id('taker'), 'taker', 'buy', '2', '100'));

    // The engine took 2 of the 5. The counterpart never saw the fill event, so
    // it still believes 5 are working — and is holding for 5.
    const report = reconcile(engine.restingOrders(), [claim({ orderId: id('maker'), state: 'open', remaining: '5', funded: true })]);

    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.orderId === id('maker'));
    expect(finding?.case).toBe('quantity_disagreement');
    expect(finding?.verdict).toBe('refuse');
    expect(finding?.engine).toContain('remaining=3');
    expect(finding?.counterpart).toContain('remaining=5');
  });

  it('refuses a pending claim whose id is already resting, including when unfunded and the qty matches', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('intent'), 'intent', 'buy', '2', '100'));

    const before = engine.restingOrders();
    const unfunded = reconcile(before, [claim({ orderId: id('intent'), state: 'pending', remaining: '2', funded: false })]);

    // Intent recorded, not yet live. Same market and same remaining are not agreement,
    // and funded false does not make a resting id clean.
    expect(unfunded.agreed).toBe(0);
    expect(unfunded.ok).toBe(false);
    expect(unfunded.refusals).toBe(1);
    expect(unfunded.findings).toHaveLength(1);
    expect(unfunded.findings[0]).toMatchObject({
      orderId: id('intent'),
      case: 'counterpart_pending_engine_live',
      verdict: 'refuse',
    });
    expect(unfunded.findings[0]?.engine).toContain('LIVE');
    expect(unfunded.findings[0]?.engine).toContain('remaining=2');
    expect(unfunded.findings[0]?.counterpart).toContain('PENDING');
    expect(unfunded.findings[0]?.counterpart).toContain('funded=false');
    expect(unfunded.findings[0]?.counterpart).toContain('remaining=2');
    expect(unfunded.findings[0]?.reason).toMatch(/not yet live/i);
    expect(unfunded.findings[0]?.reason).toMatch(/auto-cancel/i);
    expect(unfunded.findings[0]?.reason).toMatch(/auto-release/i);

    const funded = reconcile(before, [claim({ orderId: id('intent'), state: 'pending', remaining: '2', funded: true })]);
    expect(funded.agreed).toBe(0);
    expect(funded.ok).toBe(false);
    expect(funded.findings[0]?.case).toBe('counterpart_pending_engine_live');
    expect(funded.findings[0]?.verdict).toBe('refuse');

    const opened = reconcile(before, [claim({ orderId: id('intent'), state: 'open', remaining: '2', funded: true })]);
    expect(opened).toMatchObject({ ok: true, refusals: 0, agreed: 1, checked: 1 });
    expect(opened.findings).toEqual([]);

    // Classify only. The resting order stays, at the same remaining.
    expect(engine.restingOrders()).toEqual(before);
  });

  it('refuses when the counterpart calls it terminal and the engine is still working it', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '2', '100'));

    const report = reconcile(engine.restingOrders(), [claim({ orderId: id('o1'), state: 'terminal', remaining: '0', funded: false })]);

    const finding = report.findings[0];
    expect(finding?.case).toBe('counterpart_terminal_engine_live');
    expect(finding?.verdict).toBe('refuse');
    expect(finding?.engine).toContain('LIVE');
    expect(finding?.counterpart).toContain('TERMINAL');
    expect(finding?.reason).toMatch(/free book risk/i);
  });

  it('refuses when one order id is resting under a different market than the caller believes', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '2', '100'));

    const report = reconcile(engine.restingOrders(), [claim({ orderId: id('o1'), marketId: OTHER_MARKET, remaining: '2' })]);

    const finding = report.findings[0];
    expect(finding?.case).toBe('market_disagreement');
    expect(finding?.verdict).toBe('refuse');
    expect(finding?.engine).toContain(`market=${MARKET}`);
    expect(finding?.counterpart).toContain(`market=${OTHER_MARKET}`);
  });

  it('refuses on an unreadable quantity instead of coercing one', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '2', '100'));

    const report = reconcile(engine.restingOrders(), [claim({ orderId: id('o1'), remaining: 'not-a-number' })]);

    expect(report.findings[0]?.case).toBe('unreadable_amount');
    expect(report.findings[0]?.verdict).toBe('refuse');
  });
});

describe('reconcile — the one case that is safe to automate', () => {
  it('marks an unfunded intent row the engine never saw as auto, and does not count it as a refusal', () => {
    const id = idFactory();
    const report = reconcile([], [claim({ orderId: id('orphan'), state: 'pending', remaining: '2', funded: false })]);

    const finding = report.findings[0];
    expect(finding?.case).toBe('counterpart_unfunded_engine_missing');
    expect(finding?.verdict).toBe('auto');
    expect(finding?.reason).toMatch(/moves no value/i);

    // `auto` is a finding, not a problem: ok stays true so a scheduled check
    // does not page anyone for a row svc-trade can clean up on its own.
    expect(report.ok).toBe(true);
    expect(report.refusals).toBe(0);
  });

  it('is NOT auto once the same row is funded — the hold is the whole difference', () => {
    const id = idFactory();
    const funded = reconcile([], [claim({ orderId: id('orphan'), state: 'pending', remaining: '2', funded: true })]);
    expect(funded.findings[0]?.verdict).toBe('refuse');
    expect(funded.ok).toBe(false);
  });
});

// ── A self-contradictory counterpart view ────────────────────────────────────
//
// The route takes a JSON array, not a result set. Two rows for one order id
// cannot come out of `SELECT ... WHERE id = ...`, so if it happens the caller
// assembled its view wrong — and every other verdict in the report was computed
// from that same view. Judging the id twice would report one order as both
// agreed and stranded, and the count of "agreed" would be a number nobody can
// act on.

describe('reconcile — the counterpart contradicts itself', () => {
  it('refuses a duplicated order id instead of silently judging it twice', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '2', '100'));

    const report = reconcile(engine.restingOrders(), [
      claim({ orderId: id('o1'), remaining: '2' }),
      claim({ orderId: id('o1'), remaining: '5' }),
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.case).toBe('duplicate_counterpart_id');
    expect(report.findings[0]?.verdict).toBe('refuse');
    expect(report.findings[0]?.counterpart).toContain('remaining=2');
    expect(report.findings[0]?.counterpart).toContain('remaining=5');
    // Not silently counted as agreement on the strength of whichever came first.
    expect(report.agreed).toBe(0);
  });
});

describe('reconcile — report shape', () => {
  it('sorts findings by order id so two runs read the same', async () => {
    // Explicit ids rather than the label factory: the claim under test IS the
    // ordering, so the ids have to read as ordered at the call site.
    const LOW = '00000000-0000-4000-8000-0000000000a1';
    const HIGH = '00000000-0000-4000-8000-0000000000f9';

    const engine = engineWith();
    await engine.submit(MARKET, limit(HIGH, 'high', 'buy', '1', '100'));
    await engine.submit(MARKET, limit(LOW, 'low', 'buy', '1', '99'));

    const report = reconcile(engine.restingOrders(), []);
    expect(report.findings.map((f) => f.orderId)).toEqual([LOW, HIGH]);
  });

  it('counts both directions in a mixed run', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('agreed'), 'agreed', 'buy', '1', '100'));
    await engine.submit(MARKET, limit(id('phantom'), 'phantom', 'buy', '1', '99'));

    const report = reconcile(engine.restingOrders(), [
      claim({ orderId: id('agreed'), remaining: '1' }),
      claim({ orderId: id('stranded'), funded: true }),
      claim({ orderId: id('orphan'), state: 'pending', funded: false }),
    ]);

    expect(report.agreed).toBe(1);
    expect(report.refusals).toBe(2); // phantom (engine_only) + stranded
    expect(report.ok).toBe(false);
    // Four distinct ids across both sides: three claimed, plus the engine's phantom.
    expect(report.checked).toBe(4);
    expect(report.findings.map((f) => f.case).sort()).toEqual([
      'counterpart_open_engine_missing',
      'counterpart_unfunded_engine_missing',
      'engine_only',
    ]);
  });
});

// ── Type-level guard ─────────────────────────────────────────────────────────
//
// `EngineLiveOrder` is what crosses the wire. If a field ever becomes a JS
// number, money precision leaves with it.
describe('EngineLiveOrder carries amounts as strings', () => {
  it('has no numeric price or quantity', async () => {
    const id = idFactory();
    const engine = engineWith();
    await engine.submit(MARKET, limit(id('o1'), 'o1', 'buy', '0.000000000000000001', '100'));

    const live = engine.restingOrders()[0] as EngineLiveOrder;
    expect(typeof live.price).toBe('string');
    expect(typeof live.remaining).toBe('string');
    // The 18th decimal place survives, which is the reason for the rule.
    expect(live.remaining).toBe('0.000000000000000001');
  });

  it('summarizeReconcile counts by case without invent', () => {
    const report = reconcile([], []);
    const s = summarizeReconcile(report);
    expect(s.ok).toBe(true);
    expect(s.refusals).toBe(0);
    expect(s.byCase).toEqual({});
  });
});
