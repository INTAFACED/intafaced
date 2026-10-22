import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, TAX_EFFECT_TYPES } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { TAX_EFFECT_MAP, classifyTaxEffect } from './activity-kind.js';
import { ActivityService, type ActivityServiceOptions, type LedgerHistoryPages, type LedgerPageEntry } from './activity-service.js';
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

/** svc-bank's own card authorisation rows: only tx-card is Alice's card hold. */
const cardHolds = {
  holdTxIds: async (userId: string, txIds: readonly string[]) => new Set(userId === ALICE ? txIds.filter((t) => t === 'tx-card') : []),
};

function service(holds: ActivityServiceOptions['cardHolds'] | null = cardHolds) {
  return new ActivityService(
    { allNamedSpaces: async () => [] },
    { pages, cursorSecret: SECRET, ...(holds === null ? {} : { cardHolds: holds }) },
  );
}

describe('tax effect on feed lines (bank.activity.list / get)', () => {
  const line = (items: { txId: string; taxEffect: unknown }[], txId: string) => items.filter((i) => i.txId === txId);

  it('pages built from the real P2P recipes: the seller sees only the lock leg, which is the p2p_sale disposal', async () => {
    expect(line(ALICE_ENTRIES as never, 'tx-p2p-sell-release')).toHaveLength(0);
    const { items } = await service().list(ALICE, {});
    const sell = line(items, 'tx-p2p-sell');
    expect(sell).toHaveLength(1);
    expect(sell[0]!.taxEffect).toEqual({ type: 'p2p_sale', effect: 'disposal', sourceEvent: 'p2p/p2p.escrow.lock' });
  });

  it('the buyer leg of a real escrowRelease is the p2p_purchase acquisition, naming its source', async () => {
    const { items } = await service().list(ALICE, {});
    const buy = line(items, 'tx-p2p-buy');
    expect(buy).toHaveLength(1);
    expect(buy[0]!.taxEffect).toEqual({ type: 'p2p_purchase', effect: 'acquisition', sourceEvent: 'p2p/p2p.escrow.release' });
  });

  it('a refund returns the seller’s own value and is unmapped', async () => {
    const { items } = await service().list(ALICE, {});
    expect(line(items, 'tx-p2p-refund').map((i) => i.taxEffect)).toEqual([UNMAPPED]);
  });

  it('the ledger page drops the card-sim rail, and the card hold is still one card_spend via svc-bank’s own authorisation', async () => {
    const cardPage = ALICE_ENTRIES.find((e) => e.txId === 'tx-card')!;
    expect(cardPage.rail).toBeNull();
    expect(ALICE_ENTRIES.find((e) => e.txId === 'tx-withdraw')!.rail).toBe('crypto-native');
    const { items } = await service().list(ALICE, {});
    const card = items.filter((i) => 'type' in i.taxEffect && i.taxEffect.type === 'card_spend');
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({ txId: 'tx-card', postedAt: cardPage.postedAt.toISOString() });
    expect(card[0]!.taxEffect).toEqual({ type: 'card_spend', effect: 'disposal', sourceEvent: 'ledger/withdraw.held' });
    expect(line(items, 'tx-withdraw').map((i) => i.taxEffect)).toEqual([UNMAPPED]);
  });

  it('without the card fact (no port, or the read fails) a withdraw hold is unmapped, never guessed, and still shown', async () => {
    for (const holds of [null, { holdTxIds: async () => Promise.reject(new Error('db down')) }]) {
      const { items } = await service(holds).list(ALICE, {});
      expect(line(items, 'tx-card').map((i) => i.taxEffect)).toEqual([UNMAPPED]);
    }
  });

  it('only the card hold candidates of the caller are asked about', async () => {
    const asked: Array<[string, readonly string[]]> = [];
    await service({ holdTxIds: async (u, t) => (asked.push([u, t]), new Set<string>()) }).list(ALICE, {});
    expect(asked).toEqual([[ALICE, ['tx-card', 'tx-withdraw']]]);
  });

  it('a staking reward from the real rewardPay is income at receipt', async () => {
    const { items } = await service().list(ALICE, {});
    const reward = line(items, 'tx-stake-reward');
    expect(reward.map((i) => i.taxEffect)).toEqual([
      { type: 'staking_reward', effect: 'income', sourceEvent: 'token/token.yield.distributed' },
    ]);
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

  it('taxEffects serves the map: five rows, mining blocked, and the unmapped code', async () => {
    const out = await caller(['bank:read']).activity.taxEffects({});
    expect(out.unmappedCode).toBe('portfolio.tax_effect_unmapped');
    expect(out.rows.map((row) => [row.type, row.effect, row.sourceEvent])).toEqual([
      ['p2p_sale', 'disposal', 'p2p/p2p.escrow.lock'],
      ['p2p_purchase', 'acquisition', 'p2p/p2p.escrow.release'],
      ['card_spend', 'disposal', 'ledger/withdraw.held'],
      ['mining_payout', 'income', null],
      ['staking_reward', 'income', 'token/token.yield.distributed'],
    ]);
  });

  it('list rows carry taxEffect through the output schema', async () => {
    const out = await caller(['bank:read']).activity.list({});
    expect(out.items.find((i) => i.txId === 'tx-p2p-sell')?.taxEffect).toEqual({
      type: 'p2p_sale',
      effect: 'disposal',
      sourceEvent: 'p2p/p2p.escrow.lock',
    });
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
