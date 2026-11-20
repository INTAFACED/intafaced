import { beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerError,
  MemoryLedger,
  feeShareBudgetAccount,
  feeShareOwedAccount,
  formatAmount,
  houseFees,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { UserVenueFill } from '@intafaced/venue-contracts';
import type { BuilderFeeClaim, BuilderFeeClaimReader } from '../builder-fee/builder-fee-collect.js';
import type { FeeShareAttribution } from './fee-share.js';
import { UNPUBLISHED_COPY_FEE_SHARE_LAW, type CopyFeeShareLaw } from './fee-share-law.js';
import { feeShareState } from './my-copy-fees.js';
import {
  runVenueFeeShares,
  venueFeeShareFundKey,
  venueFeeShareOweKey,
  venueFeeShareRowId,
  type FundPlan,
  type NewVenueShare,
  type VenueCopyFill,
  type VenueFeeShareDeps,
  type VenueFeeShareStore,
  type VenueShareRow,
} from './venue-fee-share.js';

/**
 * The lead's share of our builder fee on a copied venue fill (J-copy-bots-otc-06 #1 #3), against the in-memory ledger and
 * an in-memory store with the SQL store's rules. TEST amounts only. Whose funds are stranded if a run stops exactly here?
 * Each test that crashes a run proves nobody's: every leg is ours, and the next run finishes it under the same keys.
 */
const a = parseAmount;
const VENUE = 'test-venue-sim';
const OWNER = '0x00000000000000000000000000000000000000f1';
const SUB = '0x00000000000000000000000000000000000000f2';
const ACCOUNT = `${OWNER}/${SUB}`;
const BUILDER = '0x00000000000000000000000000000000000000b7';
const LEADER = '11111111-1111-4111-8111-1111111111a1';
const FOLLOWER = '11111111-1111-4111-8111-1111111111f1';
const T0 = new Date('2026-11-20T10:00:00.000Z');
const LAW: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 1234,
  earningsCapPerFollower: '5000',
  decayRoundTrips: 100,
  decayShareBps: 2500,
};

/** What the SQL store keeps, in memory, with its rules: one row per fill id, the cap counted with the row, one plan per claim. */
class MemoryStore implements VenueFeeShareStore {
  rows = new Map<string, VenueShareRow & { settled: boolean; skipped: FeeShareAttribution['skippedReason']; oweTx: string | null }>();
  plans = new Map<string, FundPlan & { tx: string | null }>();
  stats = new Map<string, { earningsPaid: Amount; roundTrips: number }>();
  failMarkOwed = 0;
  failMarkFund = 0;
  async recorded(ids: readonly string[]) {
    return new Set(ids.filter((id) => this.rows.has(id)));
  }
  async record(share: NewVenueShare, compute: (p: { earningsPaid: Amount; roundTrips: number }) => FeeShareAttribution) {
    if (this.rows.has(share.rowId)) return 'exists' as const;
    const key = `${share.leaderId}:${share.followerId}`;
    const period = this.stats.get(key) ?? { earningsPaid: 0n, roundTrips: 0 };
    const att = compute(period);
    this.rows.set(share.rowId, {
      rowId: share.rowId,
      followId: share.followId,
      leaderId: share.leaderId,
      venueId: share.venueId,
      venueAccount: share.venueAccount,
      venueFillId: share.venueFillId,
      assetId: share.assetId,
      feeEarned: att.protocolFee,
      appliedShareBps: att.appliedShareBps,
      amount: att.cappedLeaderShare,
      filledAt: share.filledAt,
      claimId: null,
      settled: false,
      skipped: att.skippedReason,
      oweTx: null,
    });
    this.stats.set(key, { earningsPaid: period.earningsPaid + att.cappedLeaderShare, roundTrips: period.roundTrips + 1 });
    return 'recorded' as const;
  }
  async fundPlan(venueId: string, claimId: string) {
    return this.plans.get(`${venueId}:${claimId}`) ?? null;
  }
  async unfunded(venueId: string, assetId: string, through: Date) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.venueId === venueId &&
          r.assetId === assetId &&
          r.claimId === null &&
          r.skipped === null &&
          r.amount > 0n &&
          r.filledAt <= through,
      )
      .sort((x, y) => x.filledAt.getTime() - y.filledAt.getTime() || (x.rowId < y.rowId ? -1 : 1));
  }
  async planFund(plan: FundPlan, ids: readonly string[]) {
    const had = this.plans.get(`${plan.venueId}:${plan.claimId}`);
    if (had) return had;
    this.plans.set(`${plan.venueId}:${plan.claimId}`, { ...plan, tx: null });
    for (const id of ids) this.rows.get(id)!.claimId = plan.claimId;
    return plan;
  }
  async markFundPosted(venueId: string, claimId: string, tx: string) {
    if (this.failMarkFund > 0) {
      this.failMarkFund -= 1;
      throw new Error('crash after the set-aside was posted');
    }
    const p = this.plans.get(`${venueId}:${claimId}`)!;
    this.plans.set(`${venueId}:${claimId}`, { ...p, status: 'posted', tx });
  }
  async owing() {
    return [...this.rows.values()].filter(
      (r) =>
        !r.settled &&
        r.skipped === null &&
        r.amount > 0n &&
        r.claimId !== null &&
        this.plans.get(`${r.venueId}:${r.claimId}`)?.status === 'posted',
    );
  }
  async markOwed(rowId: string, tx: string) {
    if (this.failMarkOwed > 0) {
      this.failMarkOwed -= 1;
      throw new Error('crash after the share was owed');
    }
    const r = this.rows.get(rowId)!;
    r.settled = true;
    r.oweTx = tx;
  }
}

let ledger: MemoryLedger;
let store: MemoryStore;
let fills: VenueCopyFill[];
let claims: BuilderFeeClaim[];
beforeEach(() => {
  ledger = new MemoryLedger();
  store = new MemoryStore();
  fills = [];
  claims = [];
});

function copyFill(fillId: string, builderFee: string, over: Partial<UserVenueFill> = {}, killed = false): VenueCopyFill {
  const fill: UserVenueFill = {
    fillId,
    venueClientOrderId: `0xcloid-${fillId}`,
    symbol: 'BTC-USDC',
    side: 'sell',
    price: a('60000'),
    amount: a('0.0003'),
    role: 'taker',
    venueFee: a('0.0063'),
    builderFee: a(builderFee),
    feeAsset: 'USDC',
    realisedPnl: null,
    filledAt: new Date(T0.getTime() + fills.length * 1_000),
    ...over,
  };
  const c: VenueCopyFill = {
    followId: 'follow-1',
    followerId: FOLLOWER,
    leaderId: LEADER,
    leaderFillId: `venue:${OWNER}:${fill.filledAt.getTime()}:lead-${fillId}`,
    feeShareKilled: killed,
    venueId: VENUE,
    venueAccount: ACCOUNT,
    account: { venueId: VENUE, owner: OWNER, subAccount: SUB },
    fill,
  };
  fills.push(c);
  return c;
}
const earn = (c: VenueCopyFill) =>
  ledger.post(
    recipes.builderFeeEarn({
      venueId: VENUE,
      venueAccount: c.venueAccount,
      fillId: c.fill.fillId,
      assetId: 'USDC',
      amount: c.fill.builderFee,
      userId: FOLLOWER,
    }),
  );
async function claim(claimId: string, amount: string, at = new Date(T0.getTime() + 3_600_000), post = true) {
  const c: BuilderFeeClaim = { claimId, builder: BUILDER, assetId: 'USDC', amount: a(amount), claimedAt: at };
  claims.push(c);
  if (post) await ledger.post(recipes.builderFeeReceive({ venueId: VENUE, claimId, assetId: 'USDC', amount: c.amount }));
}
const reader = (): BuilderFeeClaimReader => ({ venueId: VENUE, claims: async () => claims });
const deps = (over: Partial<VenueFeeShareDeps> = {}): VenueFeeShareDeps => ({
  law: LAW,
  ledger,
  store,
  copyFills: async () => fills,
  claims: reader(),
  builder: BUILDER,
  ...over,
});
const owedTo = async () => (await ledger.balance(feeShareOwedAccount({ kind: 'lead-trader', userId: LEADER }, 'USDC'))).amount;
const budget = async () => (await ledger.balance(feeShareBudgetAccount(VENUE, 'USDC'))).amount;
const oweKey = (c: VenueCopyFill) =>
  venueFeeShareOweKey({ venueId: VENUE, venueAccount: ACCOUNT, venueFillId: c.fill.fillId, leaderId: LEADER });
const rowOf = (c: VenueCopyFill) => store.rows.get(venueFeeShareRowId(VENUE, ACCOUNT, c.fill.fillId))!;
const txsOf = (reason: string) => ledger.journal().filter((t) => t.reason === reason);

/** The invariant: what the ledger says we owe the lead is exactly the settled shares in the fee-share history. */
async function expectLedgerMatchesHistory() {
  const settled = [...store.rows.values()].filter((r) => r.settled);
  expect(await owedTo()).toBe(settled.reduce((s, r) => s + r.amount, 0n));
  for (const r of settled) {
    const tx = await ledger.getTxByKey(venueFeeShareOweKey(r));
    expect(tx?.id).toBe(r.oweTx);
  }
  // Nothing is set aside past a claim, and nothing is owed past what was set aside.
  for (const p of store.plans.values()) expect(p.amount <= p.claimAmount).toBe(true);
  const fundedTotal = [...store.plans.values()].filter((p) => p.status === 'posted').reduce((s, p) => s + p.amount, 0n);
  expect((await budget()) + (await owedTo())).toBe(fundedTotal);
}

describe('runVenueFeeShares', () => {
  it('records the lead share of our builder fee on a copied fill once, sets it aside from the claim, and owes it to the lead', async () => {
    const c = copyFill('sim-fill-1', '0.0009');
    await earn(c);
    await claim('claim-1', '0.0009');
    const run = await runVenueFeeShares(deps());
    expect(run).toEqual({ status: 'ran', recorded: 1, earnNotBooked: 0, killed: 0, funded: 1, claimNotBooked: 0, owed: 1, budgetShort: 0 });
    // 12.34% of 0.0009, floored at 18 places.
    const share = a('0.00011106');
    expect(rowOf(c)).toMatchObject({ amount: share, feeEarned: a('0.0009'), appliedShareBps: 1234, settled: true, claimId: 'claim-1' });
    const owe = await ledger.getTxByKey(oweKey(c));
    expect(owe?.reason).toBe('trade.fee_share.owed');
    expect(owe?.idempotencyKey).toBe(`fee-share:builder-fee:${VENUE}:${ACCOUNT}:sim-fill-1:lead-trader:${LEADER}`);
    // Only our own accounts move: the venue's budget and what we owe the lead. The follower has no entry anywhere.
    const fund = await ledger.getTxByKey(venueFeeShareFundKey(VENUE, 'claim-1'));
    for (const tx of [owe!, fund!]) for (const e of tx.entries) expect(e.accountId).not.toContain(FOLLOWER);
    expect(await owedTo()).toBe(share);
    expect(await budget()).toBe(0n);
    expect((await ledger.balance(houseFees('builder', 'USDC'))).amount).toBe(a('0.0009') - share);
    expect(
      feeShareState(c, {
        rowId: '',
        leaderId: LEADER,
        assetId: 'USDC',
        amount: formatAmount(share),
        appliedShareBps: 1234,
        skippedReason: null,
        settled: true,
      }),
    ).toEqual({
      state: 'owed',
      share: { amount: '0.00011106', asset: 'USDC' },
      shareBps: 1234,
      ledgerKey: oweKey(c),
    });
    await expectLedgerMatchesHistory();
  });

  it('records, sets aside and owes nothing while the owner has not set the share rate', async () => {
    const c = copyFill('sim-fill-1', '0.0009');
    await earn(c);
    await claim('claim-1', '0.0009');
    const before = ledger.journal().length;
    expect(await runVenueFeeShares(deps({ law: UNPUBLISHED_COPY_FEE_SHARE_LAW }))).toEqual({
      status: 'waiting',
      reason: 'trade.copy_fee_share_blank',
    });
    expect(store.rows.size).toBe(0);
    expect(ledger.journal()).toHaveLength(before);
  });

  it('waits for the poster: a fill whose Earn is not booked, or booked at another amount, is not recorded', async () => {
    copyFill('sim-fill-1', '0.0009');
    await claim('claim-1', '0.0009');
    let run = await runVenueFeeShares(deps());
    expect(run).toMatchObject({ recorded: 0, earnNotBooked: 1, owed: 0 });
    expect(store.rows.size).toBe(0);
    // Booked at another amount than the venue reports: still not ours to share.
    await ledger.post(
      recipes.builderFeeEarn({
        venueId: VENUE,
        venueAccount: ACCOUNT,
        fillId: 'sim-fill-1',
        assetId: 'USDC',
        amount: a('0.0008'),
        userId: FOLLOWER,
      }),
    );
    run = await runVenueFeeShares(deps());
    expect(run).toMatchObject({ recorded: 0, earnNotBooked: 1 });
    // The venue's own figure and the Earn agree once read again: recorded and owed.
    fills = [];
    const same = copyFill('sim-fill-1', '0.0008');
    run = await runVenueFeeShares(deps());
    expect(run).toMatchObject({ recorded: 1, funded: 1, owed: 1 });
    expect(rowOf(same).settled).toBe(true);
    await expectLedgerMatchesHistory();
  });

  it('a spot buy (no builder fee) and a follow with its fee share killed record nothing', async () => {
    copyFill('sim-fill-1', '0', { side: 'buy' });
    const k = copyFill('sim-fill-2', '0.0009', {}, true);
    await earn(k);
    const run = await runVenueFeeShares(deps());
    expect(run).toMatchObject({ recorded: 0, killed: 1, owed: 0 });
    expect(store.rows.size).toBe(0);
  });

  it('owes nothing until the venue pays us: a claim the ledger has not received sets nothing aside', async () => {
    const c = copyFill('sim-fill-1', '0.0009');
    await earn(c);
    await claim('claim-1', '0.0009', undefined, false);
    const run = await runVenueFeeShares(deps());
    expect(run).toMatchObject({ recorded: 1, funded: 0, claimNotBooked: 1, owed: 0 });
    expect(rowOf(c)).toMatchObject({ settled: false, claimId: null });
    expect(await owedTo()).toBe(0n);
    // No claim reader at all (an adapter that reads none): the same, recorded and waiting.
    expect(await runVenueFeeShares(deps({ claims: null }))).toMatchObject({ funded: 0, owed: 0 });
    // Collected: set aside and owed on the next run.
    await ledger.post(recipes.builderFeeReceive({ venueId: VENUE, claimId: 'claim-1', assetId: 'USDC', amount: a('0.0009') }));
    expect(await runVenueFeeShares(deps())).toMatchObject({ funded: 1, owed: 1 });
    await expectLedgerMatchesHistory();
  });

  it('a claim sets aside only whole shares it covers, of fills made by its time; the rest wait for the next claim', async () => {
    const f1 = copyFill('sim-fill-1', '0.0009');
    const f2 = copyFill('sim-fill-2', '0.0009');
    const late = copyFill('sim-fill-3', '0.0009', { filledAt: new Date(T0.getTime() + 7_200_000) });
    for (const c of [f1, f2, late]) await earn(c);
    // Covers one share and a part of the second: only the first is set aside. The third was filled after the claim.
    await claim('claim-1', '0.00015');
    let run = await runVenueFeeShares(deps());
    expect(run).toMatchObject({ recorded: 3, funded: 1, owed: 1 });
    expect([rowOf(f1).settled, rowOf(f2).settled, rowOf(late).settled]).toEqual([true, false, false]);
    expect(store.plans.get(`${VENUE}:claim-1`)).toMatchObject({ amount: a('0.00011106'), claimAmount: a('0.00015') });
    await claim('claim-2', '0.0018', new Date(T0.getTime() + 9_000_000));
    run = await runVenueFeeShares(deps());
    expect(run).toMatchObject({ recorded: 0, funded: 1, owed: 2 });
    expect([rowOf(f2).claimId, rowOf(late).claimId]).toEqual(['claim-2', 'claim-2']);
    await expectLedgerMatchesHistory();
  });

  it('leaves a share unowed when the budget is short, and owes it on a later run', async () => {
    const c = copyFill('sim-fill-1', '0.0009');
    await earn(c);
    await claim('claim-1', '0.0009');
    let refuse = true;
    const short: Pick<LedgerClient, 'post' | 'getTxByKey'> = {
      getTxByKey: (k) => ledger.getTxByKey(k),
      post: async (req: PostRequest) => {
        if (refuse && req.reason === 'trade.fee_share.owed') throw new LedgerError('Insufficient USDC', 'ledger.insufficient_funds');
        return ledger.post(req);
      },
    };
    const run = await runVenueFeeShares(deps({ ledger: short }));
    expect(run).toMatchObject({ funded: 1, owed: 0, budgetShort: 1 });
    expect(rowOf(c).settled).toBe(false);
    expect(await owedTo()).toBe(0n);
    refuse = false;
    expect(await runVenueFeeShares(deps({ ledger: short }))).toMatchObject({ owed: 1, budgetShort: 0 });
    await expectLedgerMatchesHistory();
  });

  it('a refusal that is not the budget (the posting freeze, an outage) stops the run, to be retried whole', async () => {
    const c = copyFill('sim-fill-1', '0.0009');
    await earn(c);
    await claim('claim-1', '0.0009');
    const frozen: Pick<LedgerClient, 'post' | 'getTxByKey'> = {
      getTxByKey: (k) => ledger.getTxByKey(k),
      post: async (req: PostRequest) => {
        if (req.reason === 'trade.fee_share.owed') throw new LedgerError('postings frozen', 'ledger.frozen');
        return ledger.post(req);
      },
    };
    await expect(runVenueFeeShares(deps({ ledger: frozen }))).rejects.toMatchObject({ code: 'ledger.frozen' });
    expect(rowOf(c).settled).toBe(false);
    expect(await runVenueFeeShares(deps())).toMatchObject({ owed: 1 });
    await expectLedgerMatchesHistory();
  });

  it('a crash after the set-aside or the owe is posted and before it is recorded posts nothing twice', async () => {
    const c = copyFill('sim-fill-1', '0.0009');
    await earn(c);
    await claim('claim-1', '0.0009');
    store.failMarkFund = 1;
    await expect(runVenueFeeShares(deps())).rejects.toThrow('crash after the set-aside was posted');
    store.failMarkOwed = 1;
    await expect(runVenueFeeShares(deps())).rejects.toThrow('crash after the share was owed');
    expect(rowOf(c).settled).toBe(false);
    expect(await runVenueFeeShares(deps())).toMatchObject({ recorded: 0, funded: 0, owed: 1 });
    expect(txsOf('trade.fee_share.budget_funded')).toHaveLength(1);
    expect(txsOf('trade.fee_share.owed')).toHaveLength(1);
    await expectLedgerMatchesHistory();
  });

  it('a fill read again (redelivered) is recorded, set aside and owed once', async () => {
    const c = copyFill('sim-fill-1', '0.0009');
    fills.push({ ...c });
    await earn(c);
    await claim('claim-1', '0.0009');
    await runVenueFeeShares(deps());
    expect(await runVenueFeeShares(deps())).toEqual({
      status: 'ran',
      recorded: 0,
      earnNotBooked: 0,
      killed: 0,
      funded: 0,
      claimNotBooked: 0,
      owed: 0,
      budgetShort: 0,
    });
    expect(store.rows.size).toBe(1);
    expect(txsOf('trade.fee_share.owed')).toHaveLength(1);
    expect(store.stats.get(`${LEADER}:${FOLLOWER}`)).toEqual({ earningsPaid: a('0.00011106'), roundTrips: 1 });
    await expectLedgerMatchesHistory();
  });

  it("holds to the owner's cap per follower: past it nothing is owed, and the row says so", async () => {
    const capped: CopyFeeShareLaw = { ...LAW, earningsCapPerFollower: '0.0001' };
    const f1 = copyFill('sim-fill-1', '0.0009');
    const f2 = copyFill('sim-fill-2', '0.0009');
    for (const c of [f1, f2]) await earn(c);
    await claim('claim-1', '0.0018');
    await runVenueFeeShares(deps({ law: capped }));
    expect(rowOf(f1)).toMatchObject({ amount: a('0.0001'), settled: true });
    expect(rowOf(f2)).toMatchObject({ amount: 0n, skipped: 'cap_reached', settled: false, claimId: null });
    await expectLedgerMatchesHistory();
  });
});
