import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, TAX_EFFECT_TYPES } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { CARD_SPEND_RAILS, TAX_EFFECT_MAP, classifyTaxEffect } from './activity-kind.js';
import { ActivityService, type LedgerHistoryPages, type LedgerPageEntry } from './activity-service.js';

/** RC-portfolio-02: each feed line carries the tax effect the ledger's own reason says, from real ledger pages. */

const SECRET = 'a-bank-activity-tax-effect-test-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const UNMAPPED = { code: 'portfolio.tax_effect_unmapped' };

let seq = 0;
function entry(
  txId: string,
  module: string,
  reason: string,
  direction: 'debit' | 'credit',
  extra: Partial<LedgerPageEntry> = {},
): LedgerPageEntry {
  seq += 1;
  return {
    txId,
    module,
    reason,
    direction,
    amount: '1.5',
    assetId: 'BTC',
    postedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 60 - seq)),
    entryId: String(seq),
    ...extra,
  };
}

const ALICE_ENTRIES: LedgerPageEntry[] = [
  entry('tx-p2p-sell', 'p2p', 'p2p.escrow.release', 'credit'),
  entry('tx-p2p-buy', 'p2p', 'p2p.escrow.release', 'debit'),
  entry('tx-p2p-lock', 'p2p', 'p2p.escrow.lock', 'credit'),
  entry('tx-card', 'ledger', 'withdraw.held', 'credit', { rail: 'card-sandbox' }),
  entry('tx-withdraw', 'ledger', 'withdraw.held', 'credit', { rail: 'crypto-native' }),
  entry('tx-stake-reward', 'token', 'token.yield.distributed', 'debit'),
  entry('tx-stake', 'token', 'token.stake', 'credit'),
  entry('tx-unknown', 'bank', 'bank.something.new', 'debit'),
];
const BOB_ENTRIES: LedgerPageEntry[] = [entry('tx-bob', 'p2p', 'p2p.escrow.release', 'debit')];

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
  it('a P2P escrow release is p2p_sale disposal for the seller and p2p_purchase acquisition for the buyer, naming its source', async () => {
    const { items } = await service().list(ALICE, {});
    const byTx = new Map(items.map((i) => [i.txId, i]));
    expect(byTx.get('tx-p2p-sell')?.taxEffect).toEqual({ type: 'p2p_sale', effect: 'disposal', sourceEvent: 'p2p/p2p.escrow.release' });
    expect(byTx.get('tx-p2p-buy')?.taxEffect).toEqual({
      type: 'p2p_purchase',
      effect: 'acquisition',
      sourceEvent: 'p2p/p2p.escrow.release',
    });
    expect(byTx.get('tx-p2p-lock')?.taxEffect).toEqual(UNMAPPED);
  });

  it('a card spend is one card_spend disposal at the spend time; a withdrawal on another rail is unmapped', async () => {
    const { items } = await service().list(ALICE, {});
    const card = items.filter((i) => i.taxEffect && 'type' in i.taxEffect && i.taxEffect.type === 'card_spend');
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({ txId: 'tx-card', postedAt: ALICE_ENTRIES[3]!.postedAt.toISOString() });
    expect(card[0]?.taxEffect).toEqual({ type: 'card_spend', effect: 'disposal', sourceEvent: 'ledger/withdraw.held' });
    expect(items.find((i) => i.txId === 'tx-withdraw')?.taxEffect).toEqual(UNMAPPED);
  });

  it('a staking reward is income at receipt; staking the principal is unmapped', async () => {
    const { items } = await service().list(ALICE, {});
    const reward = items.find((i) => i.txId === 'tx-stake-reward');
    expect(reward?.taxEffect).toEqual({ type: 'staking_reward', effect: 'income', sourceEvent: 'token/token.yield.distributed' });
    expect(reward?.postedAt).toBe(ALICE_ENTRIES[5]!.postedAt.toISOString());
    expect(items.find((i) => i.txId === 'tx-stake')?.taxEffect).toEqual(UNMAPPED);
  });

  it('a reason with no row is portfolio.tax_effect_unmapped and carries no effect', async () => {
    const { items } = await service().list(ALICE, {});
    const line = items.find((i) => i.txId === 'tx-unknown');
    expect(line?.taxEffect).toEqual(UNMAPPED);
    expect(line?.taxEffect).not.toHaveProperty('effect');
  });

  it('the same history read twice gets the same classification', async () => {
    const first = (await service().list(ALICE, {})).items.map((i) => [i.id, i.taxEffect]);
    const second = (await service().list(ALICE, {})).items.map((i) => [i.id, i.taxEffect]);
    expect(second).toEqual(first);
    expect(first).toHaveLength(ALICE_ENTRIES.length);
  });

  it('get returns the same tax effect as the list for one line', async () => {
    const svc = service();
    const line = (await svc.list(ALICE, {})).items.find((i) => i.txId === 'tx-p2p-sell')!;
    const found = await svc.get(ALICE, line.id);
    expect(found.item.taxEffect).toEqual(line.taxEffect);
  });

  it('mining is listed with its blocker named and classifies nothing', () => {
    const mining = TAX_EFFECT_MAP.find((row) => row.type === 'mining_payout');
    expect(mining).toMatchObject({ effect: 'income', sourceEvent: null, blocker: expect.stringContaining('mining') });
    for (const reason of ['mining.payout', 'mining_payout', 'mining'])
      expect(classifyTaxEffect({ module: 'bank', reason, direction: 'debit' })).toEqual(UNMAPPED);
    expect(TAX_EFFECT_MAP.map((row) => row.type).sort()).toEqual([...TAX_EFFECT_TYPES].sort());
    expect(CARD_SPEND_RAILS).toEqual(['card-sandbox']);
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
      ['p2p_sale', 'disposal', 'p2p/p2p.escrow.release'],
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
      sourceEvent: 'p2p/p2p.escrow.release',
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
