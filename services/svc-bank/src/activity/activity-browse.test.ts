import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { ActivityService, type LedgerHistoryPages, type LedgerPageEntry, type LedgerPageRequest } from './activity-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import { ACTIVITY_KINDS } from './activity-kind.js';

/**
 * PF-activity-01: the kinds the book already posts, oldest-first sort, one account, a calendar year, the tax-year
 * refusal and the withdrawal-address filter.
 */

const SECRET = 'a-bank-activity-browse-test-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const SPACE = '33333333-3333-4333-8333-333333333333';
const STRANGER_SPACE = '44444444-4444-4444-8444-444444444444';

interface Posted extends LedgerPageEntry {
  ownerType: 'user' | 'subaccount';
  ownerId: string;
  seq: number;
}

function post(
  txId: string,
  reason: string,
  direction: 'debit' | 'credit',
  seq: number,
  extra: { module?: string; owner?: string; at?: Date; amount?: string } = {},
): Posted {
  return {
    ownerType: extra.owner ? 'subaccount' : 'user',
    ownerId: extra.owner ?? ALICE,
    txId,
    module: extra.module ?? 'bank',
    reason,
    direction,
    amount: extra.amount ?? '1',
    assetId: 'USDT',
    seq,
    postedAt: extra.at ?? new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
    entryId: String(seq),
  };
}

function pages(rows: Posted[]): LedgerHistoryPages {
  return {
    async page(req: LedgerPageRequest) {
      const before = req.cursor === undefined ? Infinity : Number(Buffer.from(req.cursor, 'base64url').toString().slice(3));
      const mine = rows
        .filter((row) => row.ownerType === req.ownerType && row.ownerId === req.ownerId && row.seq < before)
        .sort((a, b) => b.seq - a.seq);
      const page = mine.slice(0, req.limit);
      const last = page[page.length - 1];
      return {
        entries: page.map((row) => ({
          txId: row.txId,
          module: row.module,
          reason: row.reason,
          direction: row.direction,
          amount: row.amount,
          postedAt: row.postedAt,
          assetId: row.assetId,
          entryId: row.entryId,
        })),
        nextCursor: mine.length > req.limit && last ? Buffer.from(`v2.${last.seq}`).toString('base64url') : null,
      };
    },
  };
}

const space = {
  id: SPACE,
  userId: ALICE,
  assetId: 'USDT',
  kind: 'named',
  name: 'Rent',
  goalTarget: null,
  lockedUntil: null,
  archivedAt: null,
} as SpaceRecord;
const spaces = { allNamedSpaces: async (): Promise<SpaceRecord[]> => [space] };

type Records = NonNullable<ConstructorParameters<typeof ActivityService>[1]>['records'];
function service(rows: Posted[], records?: Records) {
  return new ActivityService(spaces, { pages: pages(rows), cursorSecret: SECRET, ...(records ? { records } : {}) });
}
const txs = (items: Array<{ txId: string }>) => items.map((item) => item.txId);

describe('earn, staking and reward lines', () => {
  const rows = [
    post('tx-interest', 'bank.earn.interest', 'debit', 1),
    post('tx-stake', 'token.stake', 'credit', 2, { module: 'token' }),
    post('tx-yield', 'token.yield.distributed', 'debit', 3, { module: 'token' }),
    post('tx-mystery', 'brand.new.reason', 'debit', 4, { module: 'brand-new' }),
    post('tx-fee', 'fee.charged', 'credit', 5, { module: 'ledger' }),
  ];

  it('shows an earn interest credit as earn, and an unknown reason as other, with every line kept', async () => {
    const all = await service(rows).list(ALICE, { limit: 50 });
    const kindOf = (txId: string) => all.items.find((item) => item.txId === txId)?.kind;
    expect(kindOf('tx-interest')).toBe('earn');
    expect(kindOf('tx-stake')).toBe('staking');
    expect(kindOf('tx-yield')).toBe('reward');
    expect(kindOf('tx-mystery')).toBe('other');
    // The kinds still account for the whole list: nothing is dropped and nothing is counted twice.
    const perKind = ACTIVITY_KINDS.map((kind) => all.items.filter((item) => item.kind === kind).length);
    expect(perKind.reduce((a, b) => a + b, 0)).toBe(rows.length);
  });

  it('filters to the new kinds', async () => {
    const earn = await service(rows).list(ALICE, { kind: ['earn', 'reward'] });
    expect(txs(earn.items).sort()).toEqual(['tx-interest', 'tx-yield']);
  });
});

describe('oldest first', () => {
  const rows = Array.from({ length: 7 }, (_, i) => post(`tx-${i + 1}`, 'bank.transfer.manual', 'debit', i + 1));

  it('starts at the oldest line and pages to the end with no gap or repeat at the boundary', async () => {
    const activity = service(rows);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await activity.list(ALICE, { sort: 'asc', limit: 3, ...(cursor ? { cursor } : {}) });
      if (guard === 0) expect(page.items[0]?.txId).toBe('tx-1');
      seen.push(...txs(page.items));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['tx-1', 'tx-2', 'tx-3', 'tx-4', 'tx-5', 'tx-6', 'tx-7']);
  });

  it('keeps its place when a newer line posts between pages', async () => {
    const live = [...rows];
    const activity = service(live);
    const first = await activity.list(ALICE, { sort: 'asc', limit: 3 });
    live.push(post('tx-8', 'bank.transfer.manual', 'debit', 8));
    const second = await activity.list(ALICE, { sort: 'asc', limit: 3, cursor: first.nextCursor! });
    expect(txs(second.items)).toEqual(['tx-4', 'tx-5', 'tx-6']);
  });

  it('combines with a filter, and a cursor from the other order is refused', async () => {
    const activity = service(rows);
    const asc = await activity.list(ALICE, { sort: 'asc', limit: 2, direction: 'in' });
    const desc = await activity.list(ALICE, { limit: 2, direction: 'in' });
    expect(txs(asc.items)).toEqual(['tx-1', 'tx-2']);
    expect(txs(desc.items)).toEqual(['tx-7', 'tx-6']);
    await expect(activity.list(ALICE, { sort: 'asc', limit: 2, direction: 'in', cursor: desc.nextCursor! })).rejects.toThrow(/cursor/i);
    await expect(activity.list(ALICE, { limit: 2, direction: 'in', cursor: asc.nextCursor! })).rejects.toThrow(/cursor/i);
  });

  it('refuses a history too long to sort instead of showing a short list', async () => {
    const long = Array.from({ length: 2_050 }, (_, i) => post(`tx-${i + 1}`, 'bank.transfer.manual', 'debit', i + 1));
    await expect(service(long).list(ALICE, { sort: 'asc', limit: 5 })).rejects.toMatchObject({ code: 'bank.activity_sort_bounded' });
    // Exactly the limit is not too long, even with older lines that do not match.
    const edge = [
      ...Array.from({ length: 50 }, (_, i) => post(`tx-old-${i}`, 'bank.transfer.manual', 'credit', i + 1)),
      ...Array.from({ length: 2_000 }, (_, i) => post(`tx-in-${i + 1}`, 'bank.transfer.manual', 'debit', i + 100)),
    ];
    const exact = await service(edge).list(ALICE, { sort: 'asc', limit: 5, direction: 'in' });
    expect(exact.items[0]?.txId).toBe('tx-in-1');
    // A shorter range answers.
    const from = new Date(Date.UTC(2026, 9, 1, 0, 33, 0)).toISOString();
    const page = await service(long).list(ALICE, { sort: 'asc', limit: 5, from });
    expect(page.items[0]?.txId).toBe('tx-1980');
  });
});

describe('one account', () => {
  const rows = [
    post('tx-main', 'bank.transfer.manual', 'debit', 1),
    post('tx-space-1', 'bank.transfer.manual', 'debit', 2, { owner: SPACE }),
    post('tx-space-2', 'bank.transfer.manual', 'credit', 3, { owner: SPACE }),
  ];

  it('reads only that Space, or only the main account', async () => {
    const activity = service(rows);
    expect(txs((await activity.list(ALICE, { accountId: SPACE })).items)).toEqual(['tx-space-2', 'tx-space-1']);
    expect(txs((await activity.list(ALICE, { accountId: 'main' })).items)).toEqual(['tx-main']);
    expect(txs((await activity.list(ALICE, {})).items).sort()).toEqual(['tx-main', 'tx-space-1', 'tx-space-2']);
  });

  it("still reads a move between two of the customer's own pots as a Space move, from either side", async () => {
    const withMove = [
      ...rows,
      post('tx-move', 'bank.transfer.manual', 'credit', 4),
      post('tx-move', 'bank.transfer.manual', 'debit', 5, { owner: SPACE }),
    ];
    const activity = service(withMove);
    const fromMain = await activity.list(ALICE, { accountId: 'main' });
    expect(fromMain.items.filter((i) => i.txId === 'tx-move').map((i) => i.kind)).toEqual(['space_move']);
    const fromSpace = await activity.list(ALICE, { accountId: SPACE });
    expect(fromSpace.items.filter((i) => i.txId === 'tx-move').map((i) => i.kind)).toEqual(['space_move']);
    const moves = await activity.list(ALICE, { accountId: 'main', kind: ['space_move'] });
    expect(txs(moves.items)).toEqual(['tx-move']);
  });

  it('pages inside one Space', async () => {
    const activity = service(rows);
    const first = await activity.list(ALICE, { accountId: SPACE, limit: 1 });
    expect(txs(first.items)).toEqual(['tx-space-2']);
    const second = await activity.list(ALICE, { accountId: SPACE, limit: 1, cursor: first.nextCursor! });
    expect(txs(second.items)).toEqual(['tx-space-1']);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a Space that is not the customer's and never reads it", async () => {
    await expect(service(rows).list(ALICE, { accountId: STRANGER_SPACE })).rejects.toMatchObject({ code: 'bank.activity_account_unknown' });
  });
});

describe('calendar year and tax year', () => {
  const edge = (txId: string, iso: string, seq: number) => post(txId, 'bank.transfer.manual', 'debit', seq, { at: new Date(iso) });
  const rows = [
    edge('tx-2025-last', '2025-12-31T23:59:59.999Z', 1),
    edge('tx-2026-first', '2026-01-01T00:00:00.000Z', 2),
    edge('tx-2026-mid', '2026-06-15T12:00:00.000Z', 3),
    edge('tx-2026-last', '2026-12-31T23:59:59.999Z', 4),
    edge('tx-2027-first', '2027-01-01T00:00:00.000Z', 5),
  ];

  it('means the UTC calendar year, first to last millisecond', async () => {
    const out = await service(rows).list(ALICE, { year: 2026 });
    expect(txs(out.items)).toEqual(['tx-2026-last', 'tx-2026-mid', 'tx-2026-first']);
  });

  it('narrows further by a range, and an empty overlap is a range error', async () => {
    const from = '2026-06-01T00:00:00.000Z';
    expect(txs((await service(rows).list(ALICE, { year: 2026, from })).items)).toEqual(['tx-2026-last', 'tx-2026-mid']);
    await expect(service(rows).list(ALICE, { year: 2026, to: '2025-12-31T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'bank.activity_range',
    });
  });

  it('refuses a tax year, whose start date is not set, and guesses nothing', async () => {
    await expect(service(rows).list(ALICE, { taxYear: 2026 })).rejects.toMatchObject({ code: 'portfolio.tax_year_start_unset' });
    await expect(service(rows).list(ALICE, { taxYear: 2026, sort: 'asc' })).rejects.toMatchObject({
      code: 'portfolio.tax_year_start_unset',
    });
  });
});

describe('withdrawal address', () => {
  const ADDRESS = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  const rows = [
    post('tx-wd', 'withdraw.held', 'credit', 1, { module: 'ledger' }),
    post('tx-trade', 'trade.fill', 'debit', 2, { module: 'trade' }),
    post('tx-wd-fiat', 'withdraw.held', 'credit', 3, { module: 'ledger' }),
  ];
  const records = (override: Partial<NonNullable<Records>> = {}): Records =>
    ({
      forItems: async () => new Map(),
      addressesFor: async (_user: string, ids: readonly string[]) => new Map(ids.filter((id) => id === 'tx-wd').map((id) => [id, ADDRESS])),
      ...override,
    }) as Records;

  it('finds a withdrawal by part of its address, ignoring case, and never matches a line with none', async () => {
    const activity = service(rows, records());
    expect(txs((await activity.list(ALICE, { address: '0xabcdef01' })).items)).toEqual(['tx-wd']);
    expect(txs((await activity.list(ALICE, { address: '0xnothere' })).items)).toEqual([]);
    const all = await activity.list(ALICE, {});
    expect(all.items.find((item) => item.txId === 'tx-wd')?.address).toBe(ADDRESS);
    expect(all.items.find((item) => item.txId === 'tx-trade')?.address).toBeUndefined();
    expect(all.items.find((item) => item.txId === 'tx-wd-fiat')?.address).toBeUndefined();
  });

  it('fails the read when the lookup fails during an address filter, but still shows the lines without one', async () => {
    const broken = records({
      addressesFor: async () => {
        throw new Error('db down');
      },
    });
    await expect(service(rows, broken).list(ALICE, { address: '0xabcdef01' })).rejects.toMatchObject({ name: 'ActivityUnavailableError' });
    expect(txs((await service(rows, broken).list(ALICE, {})).items)).toHaveLength(3);
  });

  it('refuses an address filter when nothing can look addresses up', async () => {
    await expect(service(rows).list(ALICE, { address: '0xabcdef01' })).rejects.toMatchObject({ name: 'ActivityUnavailableError' });
  });
});

describe('over the router', () => {
  const EDGE = 'a-bank-activity-browse-edge-secret-long-enough';
  const edge = createEdgeContext({ secret: EDGE, serviceName: 'svc-bank' });
  function caller(activity: ActivityService) {
    const principal = {
      sub: ALICE,
      userId: ALICE,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createBankRouter({ activity } as unknown as BankServices).createCaller(
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
  const rows = [post('tx-1', 'bank.earn.interest', 'debit', 1), post('tx-2', 'bank.transfer.manual', 'debit', 2)];

  it('names the typed code when a tax year is asked for', async () => {
    await expect(caller(service(rows)).activity.list({ taxYear: 2026 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('portfolio.tax_year_start_unset'),
    });
  });

  it('serves sort, account and year, and rejects an account that is neither main nor an id', async () => {
    const api = caller(service(rows));
    expect((await api.activity.list({ sort: 'asc' })).items.map((i) => i.txId)).toEqual(['tx-1', 'tx-2']);
    expect((await api.activity.list({ accountId: 'main', year: 2026 })).items).toHaveLength(2);
    expect((await api.activity.list({ kind: ['earn'] })).items.map((i) => i.kind)).toEqual(['earn']);
    await expect(api.activity.list({ accountId: 'someone-elses' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.activity.list({ accountId: STRANGER_SPACE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('links a purchase to the asset history, and a sale, a futures settlement or a refund to nothing', async () => {
    // The feed shows only the asset a fill paid in, so each case is one line.
    const lines = [
      { ...post('tx-buy', 'trade.fill', 'debit', 3, { module: 'trade' }), assetId: 'BTC' },
      { ...post('tx-sell', 'trade.fill', 'debit', 4, { module: 'trade' }), assetId: 'USDT' },
      { ...post('tx-mm', 'trade.fill.mm_maker', 'debit', 5, { module: 'trade' }), assetId: 'ETH' },
      // A maker's sale to the token buyback: the customer always sells there, so even a non-dollar quote is no purchase.
      { ...post('tx-buyback', 'trade.fill.buyback', 'debit', 5, { module: 'trade' }), assetId: 'BTC' },
      { ...post('tx-margin', 'futures.margin.release', 'debit', 6, { module: 'trade' }), assetId: 'ETH' },
      { ...post('tx-profit', 'futures.profit.realized', 'debit', 7, { module: 'trade' }), assetId: 'USDT' },
      { ...post('tx-p2p-buy', 'p2p.escrow.release', 'debit', 8, { module: 'p2p' }), assetId: 'USDT' },
      { ...post('tx-p2p-refund', 'p2p.escrow.refund', 'debit', 9, { module: 'p2p' }), assetId: 'BTC' },
      post('tx-send', 'bank.transfer.manual', 'credit', 10),
    ];
    const api = caller(service(lines));
    const list = await api.activity.list({ limit: 20 });
    const pageOf = async (txId: string) => {
      const line = list.items.find((i) => i.txId === txId)!;
      return (await api.activity.get({ id: line.id })).assetPage;
    };
    expect(await pageOf('tx-buy')).toBe('/coin/BTC');
    expect(await pageOf('tx-mm')).toBe('/coin/ETH');
    expect(await pageOf('tx-p2p-buy')).toBe('/coin/USDT');
    expect(list.items.find((i) => i.txId === 'tx-buyback')?.kind).toBe('trade');
    for (const txId of ['tx-sell', 'tx-buyback', 'tx-margin', 'tx-profit', 'tx-p2p-refund', 'tx-send']) expect(await pageOf(txId)).toBeNull();
    expect(
      list.items
        .filter((i) => i.purchase)
        .map((i) => i.txId)
        .sort(),
    ).toEqual(['tx-buy', 'tx-mm', 'tx-p2p-buy']);
  });

  it('never builds a link from an asset id that is not a plain code', async () => {
    const odd = [{ ...post('tx-odd', 'trade.fill', 'debit', 3, { module: 'trade' }), assetId: '..' }];
    const api = caller(service(odd));
    const line = (await api.activity.list({})).items[0]!;
    expect((await api.activity.get({ id: line.id })).assetPage).toBeNull();
  });
});
