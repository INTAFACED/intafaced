import { describe, expect, it, vi } from 'vitest';

/**
 * The fraud evaluator and the dispute case reach no ledger writer. With ledger-client cut down to its amount helpers
 * (the root answers only what @intafaced/ledger-client/money exports, so a recipe, a client or a memory ledger is not
 * there) and every other subpath refusing to load, both modules load and every path through them runs. Outcome posts
 * live in chargeback-ledger.ts: chargeback-unwired.test.ts holds each one to its recipe.
 */
const { refuse } = vi.hoisted(() => ({
  refuse: (): never => {
    throw new Error('a fraud module loaded a ledger-client writer');
  },
}));
vi.mock('@intafaced/ledger-client', async () => ({ ...(await vi.importActual<object>('@intafaced/ledger-client/money')) }));
vi.mock('@intafaced/ledger-client/recipes', refuse);
vi.mock('@intafaced/ledger-client/testing', refuse);
vi.mock('@intafaced/ledger-client/testing/ledger-door', refuse);
vi.mock('@intafaced/ledger-client/testing/saga', refuse);
vi.mock('@intafaced/ledger-client/history-page', refuse);
vi.mock('@intafaced/ledger-client/post-recipe', refuse);
vi.mock('@intafaced/ledger-client/operator-reverse', refuse);
vi.mock('@intafaced/ledger-client/gate', refuse);

describe('the fraud evaluator and the dispute case reach no ledger writer', () => {
  it('the cut is in force: the root has no recipes, no client and no memory ledger', async () => {
    const root: object = await import('@intafaced/ledger-client');
    expect(Object.keys(root)).toContain('parseAmount');
    for (const writer of ['recipes', 'MemoryLedger', 'createHttpLedgerClient', 'chargebackOpen', 'chargebackWon', 'chargebackShortfall']) {
      expect(Object.keys(root), writer).not.toContain(writer);
    }
  });

  it('the evaluator loads and decides on every rule with only the amount helpers', async () => {
    const { evaluateFraud, isAutoDecline } = await import('./evaluate.js');
    const base = { merchantId: 'm_1', amount: '100', assetId: 'USDT' };
    const decisions = [
      evaluateFraud({ ...base, enabled: { velocity_count: false, velocity_volume: false, amount_anomaly: false } }),
      evaluateFraud({ ...base, ip: '9.9.9.9', blocklists: { ips: ['9.9.9.9'] } }),
      evaluateFraud({
        ...base,
        recentPaymentCount: 9,
        thresholds: { maxPaymentsInWindow: 3 },
        enabled: { velocity_volume: false, amount_anomaly: false },
      }),
      evaluateFraud({
        ...base,
        recentVolume: '9007199254740993',
        thresholds: { maxVolumeInWindow: '9007199254740992' },
        enabled: { velocity_count: false, amount_anomaly: false },
      }),
      evaluateFraud({
        ...base,
        amount: '500',
        baselineAmount: '100',
        thresholds: { amountAnomalyMultiplier: 2 },
        enabled: { velocity_count: false, velocity_volume: false },
      }),
      evaluateFraud(base),
    ];
    expect(decisions.map((d) => d.outcome)).toEqual(['allow', 'decline', 'review', 'review', 'review', 'review']);
    for (const d of decisions) expect(typeof isAutoDecline(d)).toBe('boolean');
  });

  it('the dispute case loads and walks every path with only the amount helpers', async () => {
    const { MemoryDisputeCaseStore } = await import('./dispute-case.js');
    const walks: Array<(store: InstanceType<typeof MemoryDisputeCaseStore>, id: string) => unknown> = [
      (store, id) => (store.contest(id), store.markWon(id)),
      (store, id) => (store.contest(id), store.markLost(id)),
      (store, id) => store.accept(id),
      (store, id) => store.applyRailResolution({ disputeId: id, railEventId: `evt-${id}`, outcome: 'won' }),
      (store, id) => store.applyRailResolution({ disputeId: id, railEventId: `evt-${id}`, outcome: 'lost' }),
      (store, id) => store.applyRailResolution({ disputeId: id, railEventId: `evt-${id}`, outcome: 'closed' }),
    ];
    for (const [i, walk] of walks.entries()) {
      const store = new MemoryDisputeCaseStore();
      const id = `dsp-${i}`;
      store.open({ disputeId: id, paymentId: 'p', merchantId: 'm', amount: '1', assetId: 'USDT' });
      walk(store, id);
      expect(store.get(id)?.ledgerTxId ?? null).toBeNull();
    }
  });
});
