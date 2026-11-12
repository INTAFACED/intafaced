import { describe, expect, it } from 'vitest';
import { recipes, type LedgerTx, type PostRequest } from '@intafaced/ledger-client';
import { planCopyFeeShareSettle, copyFeeShareLedgerKeys } from './fee-share.js';
import {
  judgeSettlement,
  listSettlements,
  reconcileSettlements,
  requireSettlementWindow,
  type SettlementOversightDeps,
  type StoredShareRow,
  type VenueBuilderFeeReport,
} from './settlement-oversight.js';

const LEAD = '11111111-1111-4111-8111-111111111111';
const FOLLOWER = '22222222-2222-4222-8222-222222222222';
const FILL = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-12T12:00:00.000Z');

function share(over: Partial<StoredShareRow> = {}): StoredShareRow {
  return {
    followId: 'follow-1',
    fillId: FILL,
    leaderId: LEAD,
    followerId: FOLLOWER,
    assetId: 'USDT',
    protocolFee: 1_000_000_000_000_000n, // 0.001
    owed: 100_000_000_000_000n, // 0.0001
    skippedReason: null,
    settled: true,
    createdAt: new Date(NOW.getTime() - 3_600_000),
    ...over,
  };
}

/** The transaction the ledger would hold for a request, as getTxByKey returns it. */
function tx(req: PostRequest): LedgerTx {
  return {
    id: `tx:${req.idempotencyKey}`,
    idempotencyKey: req.idempotencyKey,
    module: req.module,
    reason: req.reason,
    meta: req.meta ?? {},
    postedAt: NOW,
    hash: 'h',
    previousHash: null,
    entries: req.entries.map((e, i) => ({
      id: `e${i}`,
      txId: 't',
      accountId: `${e.account.ownerType}:${e.account.ownerId}`,
      assetId: e.account.assetId,
      direction: e.direction,
      amount: e.amount,
      balanceAfter: 0n,
    })),
  };
}

/** The two posts the real settle path makes for a share, from the same recipes. */
function posted(s: StoredShareRow, amount = s.owed) {
  const plan = planCopyFeeShareSettle({
    fillId: s.fillId,
    leaderId: s.leaderId,
    followerId: s.followerId,
    assetId: s.assetId,
    protocolFee: s.protocolFee,
    appliedShareBps: 1000,
    grossLeaderShare: amount,
    cappedLeaderShare: amount,
    skippedReason: null,
  });
  return { sweep: tx(plan.sweep), payout: tx(plan.payout) };
}

const venueFee = (amount: bigint, assetId = 'USDT'): VenueBuilderFeeReport => ({
  venueId: 'hyperliquid-test',
  fillId: 'venue-fill-1',
  assetId,
  amount,
  recordedAt: NOW,
});

describe('copy settlement oversight (J-copy-bots-otc-11 #1)', () => {
  it('reads the keys the settle path posts under', () => {
    const s = share();
    const p = posted(s);
    const keys = copyFeeShareLedgerKeys(s.fillId, s.leaderId, s.assetId);
    expect(keys.payout).toBe(p.payout.idempotencyKey);
    expect(keys.sweep).toBe(p.sweep.idempotencyKey);
  });

  it('is Settled only when both posts carry the share and the venue reports the fee it is a share of', () => {
    const s = share();
    const row = judgeSettlement(s, posted(s), [venueFee(s.protocolFee)]);
    expect(row.status).toBe('settled');
    expect(row.reasons).toEqual([]);
    expect(row.owed).toBe('0.0001');
    expect(row.venueAmount).toBe('0.001');
  });

  it('is Held with its key when the ledger has no post', () => {
    const s = share();
    const row = judgeSettlement(s, { sweep: null, payout: null }, [venueFee(s.protocolFee)]);
    expect(row.status).toBe('held');
    expect(row.key).toBe(`reward:copy-leader-share:${FILL}:${LEAD}`);
    expect(row.reasons).toEqual(['ledger_post_missing']);
  });

  it('is Held when only one of the two posts exists', () => {
    const s = share();
    const row = judgeSettlement(s, { sweep: null, payout: posted(s).payout }, [venueFee(s.protocolFee)]);
    expect(row.reasons).toEqual(['ledger_post_missing']);
  });

  it('is Held when the ledger post is a different amount, and never says it matched', () => {
    const s = share();
    const row = judgeSettlement(s, posted(s, s.owed + 1n), [venueFee(s.protocolFee)]);
    expect(row.status).toBe('held');
    expect(row.reasons).toEqual(['ledger_amount_differs']);
  });

  it('is Held when the venue reports no builder fee for the fill (a copy filled on the TEST book)', () => {
    const s = share();
    const row = judgeSettlement(s, posted(s), []);
    expect(row.status).toBe('held');
    expect(row.reasons).toEqual(['venue_not_reported']);
    expect(row.venueAmount).toBeNull();
  });

  it('is Held when the venue reports a different builder fee, or one in another asset', () => {
    const s = share();
    expect(judgeSettlement(s, posted(s), [venueFee(s.protocolFee - 1n)]).reasons).toEqual(['venue_fee_differs']);
    expect(judgeSettlement(s, posted(s), [venueFee(s.protocolFee, 'USDC')]).reasons).toEqual(['venue_fee_differs']);
  });

  it('holds an unfinished settle claim, and names every reason at once', () => {
    const s = share({ settled: false, owed: 0n, protocolFee: 0n });
    const row = judgeSettlement(s, { sweep: null, payout: null }, []);
    expect(row.status).toBe('held');
    expect(row.reasons).toEqual(['settle_unfinished', 'ledger_post_missing', 'venue_not_reported']);
  });

  it('counts a share the cap left at nothing as not owed; a post under its key all the same is held', () => {
    const s = share({ skippedReason: 'cap_reached', owed: 0n, settled: false });
    expect(judgeSettlement(s, { sweep: null, payout: null }, []).status).toBe('not_owed');
    const stray = posted(share());
    expect(judgeSettlement(s, stray, []).status).toBe('held');
  });

  it('reads the posted amount from the payout recipe itself', () => {
    const s = share();
    const pay = recipes.rewardPay({ rewardId: 'copy-leader-share:x', userId: LEAD, assetId: 'USDT', amount: s.owed });
    expect(judgeSettlement(s, { sweep: posted(s).sweep, payout: tx(pay) }, [venueFee(s.protocolFee)]).status).toBe('settled');
  });
});

describe('copy settlement reconcile (J-copy-bots-otc-11 #2 #3)', () => {
  const settled = share({ fillId: '44444444-4444-4444-8444-444444444444' });
  const held = share();
  const ledgerTxs = new Map<string, LedgerTx>();
  for (const v of Object.values(posted(settled))) ledgerTxs.set(v.idempotencyKey, v);
  const reads: string[] = [];
  const deps: SettlementOversightDeps = {
    ledger: {
      getTxByKey: async (key) => {
        reads.push(key);
        return ledgerTxs.get(key) ?? null;
      },
    },
    shares: async ({ since, followId }) =>
      [settled, held, share({ fillId: '55555555-5555-4555-8555-555555555555', createdAt: new Date(NOW.getTime() - 3 * 86_400_000) })]
        .filter((s) => !since || s.createdAt > since)
        .filter((s) => !followId || s.followId === followId),
    venueReports: async (shares) =>
      new Map(shares.filter((s) => s.fillId === settled.fillId).map((s) => [`${s.followId}\u0000${s.fillId}`, [venueFee(s.protocolFee)]])),
  };

  it('refuses a blank or unknown window and reads nothing', async () => {
    reads.length = 0;
    await expect(reconcileSettlements(deps, NOW, '')).rejects.toMatchObject({ code: 'trade.copy_settlement_window_required' });
    await expect(reconcileSettlements(deps, NOW, null)).rejects.toMatchObject({ code: 'trade.copy_settlement_window_required' });
    await expect(reconcileSettlements(deps, NOW, '1y')).rejects.toMatchObject({ code: 'trade.copy_settlement_window_required' });
    expect(reads).toEqual([]);
    expect(() => requireSettlementWindow('24h')).not.toThrow();
  });

  it('gives the same counts when run twice, and says what it compared through when', async () => {
    const first = await reconcileSettlements(deps, NOW, '24h');
    const second = await reconcileSettlements(deps, NOW, '24h');
    expect(second).toEqual(first);
    expect(first.counts).toMatchObject({ compared: 2, settled: 1, held: 1, notOwed: 0 });
    expect(first.counts.byReason.ledger_post_missing).toBe(1);
    expect(first.verdict).toBe('held');
    expect(first.through).toBe(NOW.toISOString());
    const week = await reconcileSettlements(deps, NOW, '7d');
    expect(week.counts.compared).toBe(3);
  });

  it('reads nothing compared as nothing to compare, never matched', async () => {
    const empty: SettlementOversightDeps = { ...deps, shares: async () => [] };
    const r = await reconcileSettlements(empty, NOW, '24h');
    expect(r.verdict).toBe('nothing_to_compare');
  });

  it('lists the newest shares with their counts, and one follow on its own', async () => {
    const all = await listSettlements(deps, NOW);
    expect(all.rows.map((r) => r.status)).toEqual(['settled', 'held', 'held']);
    const one = await listSettlements({ ...deps, shares: async (q) => (q.followId === 'other' ? [] : deps.shares(q)) }, NOW, 'other');
    expect(one.rows).toEqual([]);
  });
});
