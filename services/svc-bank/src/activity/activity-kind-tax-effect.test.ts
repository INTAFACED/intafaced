import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, TAX_EFFECT_TYPES } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { TAX_EFFECT_MAP, TAX_EFFECT_OWNER_DECISION_BLOCKER, classifyTaxEffect, classifyTaxEffectWith } from './activity-kind.js';
import { ActivityService, type LedgerHistoryPages, type LedgerPageEntry } from './activity-service.js';
import { formatAmount, parseAmount, recipes, type PostRequest } from '@intafaced/ledger-client';

/** RC-portfolio-02: each feed line carries the tax effect the ledger's own reason says, from real ledger pages. */

const SECRET = 'a-bank-activity-tax-effect-test-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const UNMAPPED = { code: 'portfolio.tax_effect_unmapped' };
const BUYER = '55555555-5555-4555-8555-555555555555';
const SELLER_OF_BOB = '66666666-6666-4666-8666-666666666666';

/**
 * svc-ledger `historyPage` echoes `meta.rail` only when it is in `HISTORY_RAILS`
 * (services/svc-ledger/src/ledger/history.ts `allowedHistoryRail`); everything else reaches svc-bank as null.
 * Mirrored here (svc-bank may not import svc-ledger) so the pages below carry exactly what the feed receives.
 */
const LEDGER_HISTORY_RAILS = new Set(['crypto-native', 'card-sandbox', 'bank-crypto-ledger', 'local-test']);
const ledgerRail = (raw: unknown): string | null => (typeof raw === 'string' && LEDGER_HISTORY_RAILS.has(raw) ? raw : null);

let seq = 0;
/** The page lines one REAL recipe output puts on `owner`'s available account, as svc-ledger's history page returns them. */
function linesFrom(txId: string, req: PostRequest, owner: string): LedgerPageEntry[] {
  return req.entries
    .filter((e) => e.account.ownerType === 'user' && e.account.ownerId === owner && e.account.kind === 'available')
    .map((e) => {
      seq += 1;
      return {
        txId,
        module: req.module,
        reason: req.reason,
        direction: e.direction,
        amount: formatAmount(e.amount),
        assetId: e.account.assetId,
        postedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 60 - seq)),
        entryId: String(seq),
        rail: ledgerRail((req.meta as Record<string, unknown> | undefined)?.rail),
      };
    });
}

const amt = (v: string) => parseAmount(v);
const escrow = (tradeId: string, sellerId: string, buyerId: string) => ({ tradeId, sellerId, buyerId, assetId: 'BTC', amount: amt('1.5') });

const ALICE_ENTRIES: LedgerPageEntry[] = [
  // Alice sells: her only available leg is the lock; the release credits the escrow account she has no page for.
  ...linesFrom('tx-p2p-sell', recipes.escrowLock(escrow('t-sell', ALICE, BUYER)), ALICE),
  ...linesFrom('tx-p2p-sell-release', recipes.escrowRelease(escrow('t-sell', ALICE, BUYER)), ALICE),
  // Alice buys: the release debits her available.
  ...linesFrom('tx-p2p-buy', recipes.escrowRelease(escrow('t-buy', SELLER_OF_BOB, ALICE)), ALICE),
  // Refund returns the seller's own value.
  ...linesFrom('tx-p2p-refund', recipes.escrowRefund(escrow('t-ref', ALICE, BUYER)), ALICE),
  // Card hold on the card-sim issuer rail (card-service commitHold); the ledger page drops that rail.
  ...linesFrom(
    'tx-card',
    recipes.withdrawHold({ userId: ALICE, assetId: 'BTC', amount: amt('0.2'), rail: 'card-sim', withdrawalId: 'auth-1' }),
    ALICE,
  ),
  // A crypto withdrawal hold: same reason, kept rail, not a card spend.
  ...linesFrom(
    'tx-withdraw',
    recipes.withdrawHold({ userId: ALICE, assetId: 'BTC', amount: amt('0.3'), rail: 'crypto-native', withdrawalId: 'w-1' }),
    ALICE,
  ),
  ...linesFrom(
    'tx-stake-reward',
    recipes.rewardPay({ userId: ALICE, assetId: 'BTC', amount: amt('0.01'), reason: 'token.yield.distributed', rewardId: 'r-1' }),
    ALICE,
  ),
  // A deposit has no tax row.
  ...linesFrom(
    'tx-unknown',
    recipes.deposit({ userId: ALICE, assetId: 'BTC', amount: amt('2'), rail: 'crypto-native', railRef: '0xabc' }),
    ALICE,
  ),
];
const BOB_ENTRIES: LedgerPageEntry[] = linesFrom('tx-bob', recipes.escrowRelease(escrow('t-bob', SELLER_OF_BOB, BOB)), BOB);

const pages: LedgerHistoryPages = {
  async page(req) {
    if (req.cursor !== undefined || req.ownerType !== 'user') return { entries: [], nextCursor: null };
    if (req.ownerId === ALICE) return { entries: ALICE_ENTRIES, nextCursor: null };
    if (req.ownerId === BOB) return { entries: BOB_ENTRIES, nextCursor: null };
    return { entries: [], nextCursor: null };
  },
};

function service() {
  return new ActivityService({ allNamedSpaces: async () => [] }, { pages, cursorSecret: SECRET });
}

describe('tax effect on feed lines (bank.activity.list / get)', () => {
  const line = (items: { txId: string; taxEffect: unknown }[], txId: string) => items.filter((i) => i.txId === txId);

  it('p2p_sale is BLOCKED: the seller only sees the lock (the release posts to escrow), and lock and refund are never taxable', async () => {
    expect(ALICE_ENTRIES.filter((e) => e.txId === 'tx-p2p-sell-release')).toHaveLength(0);
    expect(TAX_EFFECT_MAP.find((row) => row.type === 'p2p_sale')).toMatchObject({
      sourceEvent: null,
      blocker: expect.stringContaining('escrow'),
    });
    const { items } = await service().list(ALICE, {});
    expect(line(items, 'tx-p2p-sell').map((i) => i.taxEffect)).toEqual([UNMAPPED]);
    expect(line(items, 'tx-p2p-refund').map((i) => i.taxEffect)).toEqual([UNMAPPED]);
  });

  it('p2p_purchase is BLOCKED on an owner decision: the buyer leg of a real escrowRelease is unmapped', async () => {
    const { items } = await service().list(ALICE, {});
    const buy = line(items, 'tx-p2p-buy');
    expect(buy).toHaveLength(1);
    expect(buy[0]!.taxEffect).toEqual(UNMAPPED);
    expect(TAX_EFFECT_MAP.find((row) => row.type === 'p2p_purchase')).toMatchObject({
      sourceEvent: 'p2p/p2p.escrow.release',
      blocker: TAX_EFFECT_OWNER_DECISION_BLOCKER,
    });
  });

  it('no row is live without an owner decision: every map row names a blocker', () => {
    expect(TAX_EFFECT_MAP.every((row) => typeof row.blocker === 'string' && row.blocker.length > 0)).toBe(true);
  });

  it('once a row is live, only the exact event AND the user leg side match; the credit side of the same event is unmapped', () => {
    const live = TAX_EFFECT_MAP.map((row) => (row.type === 'p2p_purchase' ? { ...row, blocker: null } : row));
    const release = { module: 'p2p', reason: 'p2p.escrow.release' };
    expect(classifyTaxEffectWith(live, { ...release, direction: 'debit' })).toEqual({
      type: 'p2p_purchase',
      effect: 'acquisition',
      sourceEvent: 'p2p/p2p.escrow.release',
    });
    expect(classifyTaxEffectWith(live, { ...release, direction: 'credit' })).toEqual(UNMAPPED);
    expect(classifyTaxEffectWith(live, { module: 'p2p', reason: 'p2p.escrow.refund', direction: 'debit' })).toEqual(UNMAPPED);
    expect(classifyTaxEffectWith(live, { module: 'p2p2', reason: 'p2p.escrow.release', direction: 'debit' })).toEqual(UNMAPPED);
  });

  it('exact match pins case, prefix, suffix and the module/reason split (DR3 minors 4 and 5)', () => {
    const live = TAX_EFFECT_MAP.map((row) => (row.type === 'p2p_purchase' ? { ...row, blocker: null } : row));
    const near = [
      { module: 'P2P', reason: 'p2p.escrow.release' },
      { module: 'p2p', reason: 'P2P.escrow.release' },
      { module: 'p2p', reason: 'p2p.escrow.release.x' },
      { module: 'p2p', reason: 'x.p2p.escrow.release' },
      { module: 'xp2p', reason: 'p2p.escrow.release' },
      { module: 'p2p/p2p', reason: 'escrow.release' },
      { module: 'p2p/p2p.escrow', reason: 'release' },
      { module: '', reason: 'p2p/p2p.escrow.release' },
    ];
    for (const n of near) expect(classifyTaxEffectWith(live, { ...n, direction: 'debit' })).toEqual(UNMAPPED);
  });

  it('card_spend is BLOCKED: the commitHold shape arrives with the rail dropped, capture is off the feed, and hold or void are never taxable', async () => {
    expect(ALICE_ENTRIES.find((e) => e.txId === 'tx-card')!.rail).toBeNull();
    expect(ALICE_ENTRIES.find((e) => e.txId === 'tx-withdraw')!.rail).toBe('crypto-native');
    // withdrawSettle draws on the hold account: no available leg, so the capture never reaches the feed.
    expect(ALICE_ENTRIES.filter((e) => e.txId === 'tx-card-capture')).toHaveLength(0);
    expect(TAX_EFFECT_MAP.find((row) => row.type === 'card_spend')).toMatchObject({
      sourceEvent: null,
      blocker: expect.stringContaining('capture'),
    });
    const { items } = await service().list(ALICE, {});
    for (const tx of ['tx-card', 'tx-withdraw']) expect(line(items, tx).map((i) => i.taxEffect)).toEqual([UNMAPPED]);
    // A void returns the hold; whatever lines the feed shows for it carry no tax effect.
    expect(line(items, 'tx-card-void').every((i) => JSON.stringify(i.taxEffect) === JSON.stringify(UNMAPPED))).toBe(true);
    expect(items.some((i) => 'type' in i.taxEffect && (i.taxEffect.type === 'card_spend' || i.taxEffect.type === 'p2p_sale'))).toBe(false);
  });

  it('staking_reward is BLOCKED on an owner decision: a real rewardPay line is unmapped', async () => {
    const { items } = await service().list(ALICE, {});
    const reward = line(items, 'tx-stake-reward');
    expect(reward.map((i) => i.taxEffect)).toEqual([UNMAPPED]);
  });

  it('a reason with no row is portfolio.tax_effect_unmapped and carries no effect', async () => {
    const { items } = await service().list(ALICE, {});
    const unknown = line(items, 'tx-unknown');
    expect(unknown.map((i) => i.taxEffect)).toEqual([UNMAPPED]);
    expect(unknown[0]!.taxEffect).not.toHaveProperty('effect');
  });

  it('the same history read twice gets the same classification', async () => {
    const first = (await service().list(ALICE, {})).items.map((i) => [i.id, i.taxEffect]);
    const second = (await service().list(ALICE, {})).items.map((i) => [i.id, i.taxEffect]);
    expect(second).toEqual(first);
    expect(first).toHaveLength(ALICE_ENTRIES.length);
  });

  it('get returns the same tax effect as the list for one line', async () => {
    const svc = service();
    const sell = (await svc.list(ALICE, {})).items.find((i) => i.txId === 'tx-p2p-sell')!;
    const found = await svc.get(ALICE, sell.id);
    expect(found.item.taxEffect).toEqual(sell.taxEffect);
    const buy = (await svc.list(ALICE, {})).items.find((i) => i.txId === 'tx-p2p-buy')!;
    expect((await svc.get(ALICE, buy.id)).item.taxEffect).toEqual(buy.taxEffect);
  });

  it('mining is listed with its blocker named and classifies nothing', () => {
    const mining = TAX_EFFECT_MAP.find((row) => row.type === 'mining_payout');
    expect(mining).toMatchObject({ effect: 'income', sourceEvent: null, blocker: expect.stringContaining('mining') });
    for (const reason of ['mining.payout', 'mining_payout', 'mining'])
      expect(classifyTaxEffect({ module: 'bank', reason, direction: 'debit' })).toEqual(UNMAPPED);
    expect(TAX_EFFECT_MAP.map((row) => row.type).sort()).toEqual([...TAX_EFFECT_TYPES].sort());
  });
});

describe('over the router', () => {
  const EDGE = 'a-bank-activity-tax-effect-edge-secret-long-enough';
  const edge = createEdgeContext({ secret: EDGE, serviceName: 'svc-bank' });
  function caller(scopes: string[], bank: Record<string, unknown> = { activity: service() }) {
    const principal = {
      sub: ALICE,
      userId: ALICE,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createBankRouter(bank as unknown as BankServices).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req',
      }),
    );
  }

  it('taxEffects refuses portfolio.tax_effect_map_unset while every row is blocked (no owner decision)', async () => {
    await expect(caller(['bank:read']).activity.taxEffects({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('portfolio.tax_effect_map_unset'),
    });
    expect(TAX_EFFECT_MAP.every((row) => row.blocker !== null)).toBe(true);
    expect(TAX_EFFECT_MAP.map((row) => [row.type, row.effect, row.sourceEvent])).toEqual([
      ['p2p_sale', 'disposal', null],
      ['p2p_purchase', 'acquisition', 'p2p/p2p.escrow.release'],
      ['card_spend', 'disposal', null],
      ['mining_payout', 'income', null],
      ['staking_reward', 'income', 'token/token.yield.distributed'],
    ]);
  });

  it('list rows carry taxEffect through the output schema', async () => {
    const out = await caller(['bank:read']).activity.list({});
    expect(out.items.find((i) => i.txId === 'tx-p2p-buy')?.taxEffect).toEqual(UNMAPPED);
    expect(out.items.find((i) => i.txId === 'tx-unknown')?.taxEffect).toEqual(UNMAPPED);
  });

  it('refuses without bank:read', async () => {
    await expect(caller(['trade:read']).activity.taxEffects({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('only the caller’s own entries: another user’s entry is never returned, and a smuggled owner is refused', async () => {
    const api = caller(['bank:read']);
    const out = await api.activity.list({});
    expect(out.items.some((i) => i.txId === 'tx-bob')).toBe(false);
    await expect(api.activity.get({ id: `tx-bob:u:${BOB}:BTC:in` })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(api.activity.list({ userId: BOB } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.activity.list({ accountId: '44444444-4444-4444-8444-444444444444' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('bank.activity_account_unknown'),
    });
  });
});
