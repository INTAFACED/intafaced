import { parseAmount, recipes, type LedgerTx, type PostRequest } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { MemoryDisputeCaseStore } from '../fraud/dispute-case.js';
import { MerchantOpsError } from './errors.js';
import {
  DISPUTE_FUNDS_STATUSES,
  disputeFundsKeys,
  readDisputeFunds,
  type DisputeFundsLedger,
} from './merchant-disp-bill-rep-dispute-funds.js';
import type { MerchantCaller } from './roles.js';

const merchantId = '11111111-1111-4111-8111-111111111111';
const otherMerchant = '22222222-2222-4222-8222-222222222222';
const paymentId = '33333333-3333-4333-8333-333333333333';
const caller = (over: Partial<MerchantCaller> = {}): MerchantCaller => ({
  merchantId,
  userId: 'owner-1',
  role: 'owner',
  viaApiKey: false,
  interactive: true,
  ...over,
});

/** A posted tx built from the real recipe, so its key and meta cannot drift from what production posts. */
function posted(request: PostRequest, n: number): LedgerTx {
  return {
    id: `tx-${n}`,
    idempotencyKey: request.idempotencyKey,
    module: request.module,
    reason: request.reason,
    meta: request.meta ?? {},
    postedAt: new Date('2026-10-22T00:00:00Z'),
    hash: `h${n}`,
    previousHash: null,
    entries: request.entries.map((e, i) => ({
      id: `e-${n}-${i}`,
      txId: `tx-${n}`,
      accountId: `acct-${i}`,
      assetId: e.account.assetId,
      direction: e.direction,
      amount: e.amount,
      balanceAfter: 0n,
    })),
  };
}

function ledgerOf(requests: PostRequest[]): DisputeFundsLedger & { keys: string[] } {
  const byKey = new Map(requests.map((r, i) => [r.idempotencyKey, posted(r, i)]));
  const keys: string[] = [];
  return {
    keys,
    getTxByKey: async (key: string) => {
      keys.push(key);
      return byKey.get(key) ?? null;
    },
  };
}

const legs = (disputeId: string, clearing: string, balance: string) => ({
  disputeId,
  paymentId,
  merchantId,
  merchantUserId: 'owner-1',
  assetId: 'USDT',
  rail: 'card',
  fromClearing: parseAmount(clearing),
  fromMerchantBalance: parseAmount(balance),
});
const fund = (disputeId: string, amount: string) => ({
  disputeId,
  paymentId,
  merchantId,
  assetId: 'USDT',
  rail: 'card',
  amount: parseAmount(amount),
});

function storeWith(disputeId: string, amount = '100', owner = merchantId) {
  const store = new MemoryDisputeCaseStore();
  store.open({ disputeId, paymentId, merchantId: owner, amount, assetId: 'USDT', ledgerPost: { txId: 'tx-0' } });
  return store;
}

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MerchantOpsError);
    return { code: (e as MerchantOpsError).code, kind: (e as MerchantOpsError).kind };
  }
  throw new Error('expected a refusal');
}

describe('M-disp-01 dispute funds (read only)', () => {
  it('keys match the chargeback recipes exactly', () => {
    const k = disputeFundsKeys('dp-1');
    expect(k.open).toBe(recipes.chargebackOpen(legs('dp-1', '1', '0')).idempotencyKey);
    expect(k.shortfall).toBe(recipes.chargebackShortfall(fund('dp-1', '1')).idempotencyKey);
    expect(k.won).toBe(recipes.chargebackWon(legs('dp-1', '1', '0')).idempotencyKey);
    expect(k.shortfallRecovered).toBe(recipes.chargebackShortfallRecovered(fund('dp-1', '1')).idempotencyKey);
  });

  it('exposes the stored status set', () => {
    expect(DISPUTE_FUNDS_STATUSES).toEqual(['open', 'contested', 'accepted', 'won', 'lost']);
  });

  it('opened on 100.00: taken at opening 100.00, returned 0.00, status open (disputes-risk-014)', async () => {
    const store = storeWith('dp-1');
    const ledger = ledgerOf([recipes.chargebackOpen(legs('dp-1', '60', '40'))]);
    const funds = await readDisputeFunds(caller(), store, ledger, 'dp-1');
    expect(funds).toMatchObject({
      status: 'open',
      disputed: '100',
      takenAtOpening: '100',
      openingBooked: true,
      notYetTaken: '0',
      returned: '0',
      shortfall: '0',
      shortfallRecovered: '0',
      fee: { state: 'not_set' },
      ledgerTxIds: { open: 'tx-0', won: null },
    });
  });

  it('won after chargebackWon is booked: returned equals taken at opening', async () => {
    const store = storeWith('dp-2');
    store.markWon('dp-2');
    const ledger = ledgerOf([recipes.chargebackOpen(legs('dp-2', '60', '40')), recipes.chargebackWon(legs('dp-2', '60', '40'))]);
    const funds = await readDisputeFunds(caller(), store, ledger, 'dp-2');
    expect(funds.status).toBe('won');
    expect(funds.returned).toBe(funds.takenAtOpening);
    expect(funds.returned).toBe('100');
  });

  it('lost or accepted: taken stays 100.00, returned 0.00, and reading posts nothing (disputes-risk-002, -004)', async () => {
    for (const end of ['lost', 'accepted'] as const) {
      const store = storeWith(`dp-${end}`);
      if (end === 'lost') store.markLost(`dp-${end}`);
      else store.accept(`dp-${end}`);
      const ledger = ledgerOf([recipes.chargebackOpen(legs(`dp-${end}`, '0', '100'))]);
      const funds = await readDisputeFunds(caller(), store, ledger, `dp-${end}`);
      expect(funds).toMatchObject({ status: end, takenAtOpening: '100', returned: '0' });
      // The port is read-only by type (getTxByKey only); every call was a key read.
      expect(ledger.keys.every((k) => k.startsWith('pay.chargeback.'))).toBe(true);
    }
  });

  it('merchant short: shortfall covered by the fund is shown, and its recovery', async () => {
    const store = storeWith('dp-3');
    const ledger = ledgerOf([
      recipes.chargebackOpen(legs('dp-3', '0', '70')),
      recipes.chargebackShortfall(fund('dp-3', '30')),
      recipes.chargebackShortfallRecovered(fund('dp-3', '30')),
    ]);
    const funds = await readDisputeFunds(caller(), store, ledger, 'dp-3');
    expect(funds).toMatchObject({ takenAtOpening: '70', shortfall: '30', shortfallRecovered: '30', notYetTaken: '0' });
  });

  it('opening refused or missing: nothing taken, the whole amount not yet taken, shortfall not recorded (never a guess)', async () => {
    const store = storeWith('dp-4', '100.5');
    const funds = await readDisputeFunds(caller(), store, ledgerOf([]), 'dp-4');
    expect(funds).toMatchObject({ takenAtOpening: '0', openingBooked: false, notYetTaken: '100.5', shortfall: null });
  });

  it('partly booked opening: the rest is not yet taken', async () => {
    const store = storeWith('dp-5');
    const funds = await readDisputeFunds(caller(), store, ledgerOf([recipes.chargebackOpen(legs('dp-5', '0', '25'))]), 'dp-5');
    expect(funds).toMatchObject({ takenAtOpening: '25', notYetTaken: '75' });
  });

  it('ledger not wired or failing: refused as unavailable, never zero', async () => {
    const store = storeWith('dp-6');
    expect(await refusal(() => readDisputeFunds(caller(), store, undefined, 'dp-6'))).toEqual({
      code: 'pay.dispute_funds_unavailable',
      kind: 'unavailable',
    });
    const broken: DisputeFundsLedger = {
      getTxByKey: async () => {
        throw new Error('ledger down');
      },
    };
    expect(await refusal(() => readDisputeFunds(caller(), store, broken, 'dp-6'))).toEqual({
      code: 'pay.dispute_funds_unavailable',
      kind: 'unavailable',
    });
  });

  it('a booked tx whose meta cannot be read is refused, not shown as zero', async () => {
    const store = storeWith('dp-7');
    const bad = recipes.chargebackOpen(legs('dp-7', '1', '0'));
    const ledger = ledgerOf([{ ...bad, meta: { ...bad.meta, fromClearing: '1.5' } }]);
    expect((await refusal(() => readDisputeFunds(caller(), store, ledger, 'dp-7'))).code).toBe('pay.dispute_funds_unavailable');
  });

  it("another merchant's dispute answers exactly like a missing one", async () => {
    const store = storeWith('dp-8', '100', otherMerchant);
    const ledger = ledgerOf([recipes.chargebackOpen(legs('dp-8', '0', '100'))]);
    const foreign = await refusal(() => readDisputeFunds(caller(), store, ledger, 'dp-8'));
    const missing = await refusal(() => readDisputeFunds(caller(), store, ledger, 'dp-none'));
    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({ code: 'pay.dispute_not_found', kind: 'not_found' });
    expect(ledger.keys).toEqual([]);
  });

  it('every role holding disputes.read may read; the read checks it', async () => {
    const store = storeWith('dp-9');
    for (const role of ['admin', 'finance', 'developer', 'viewer'] as const) {
      await expect(readDisputeFunds(caller({ role }), store, ledgerOf([]), 'dp-9')).resolves.toMatchObject({ disputeId: 'dp-9' });
    }
  });
});
