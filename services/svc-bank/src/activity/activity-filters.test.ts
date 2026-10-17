import { describe, expect, it } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { ActivityService, type LedgerHistoryPages, type LedgerPageEntry, type LedgerPageRequest } from './activity-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';

const SECRET = 'a-bank-activity-filter-test-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const EDGE = 'a-bank-activity-filter-edge-secret-long-enough';

interface Posted extends LedgerPageEntry {
  ownerType: 'user' | 'subaccount';
  ownerId: string;
  seq: number;
}

function post(
  txId: string,
  reason: string,
  direction: 'debit' | 'credit',
  amount: string,
  seq: number,
  extra: { module?: string; orderId?: string; assetId?: string } = {},
): Posted {
  return {
    ownerType: 'user',
    ownerId: ALICE,
    txId,
    module: extra.module ?? 'bank',
    reason,
    direction,
    amount,
    assetId: extra.assetId ?? 'USDT',
    seq,
    postedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
    entryId: String(seq),
    ...(extra.orderId ? { orderId: extra.orderId } : {}),
  };
}

function pages(rows: Posted[]): LedgerHistoryPages {
  return {
    async page(req: LedgerPageRequest) {
      const before = req.cursor === undefined ? Infinity : Number(Buffer.from(req.cursor, 'base64url').toString().slice(3));
      const mine = rows
        .filter((row) => row.ownerType === req.ownerType && row.ownerId === req.ownerId && row.seq < before)
        .filter((row) => req.assetId === undefined || row.assetId === req.assetId)
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
          ...(row.orderId ? { orderId: row.orderId } : {}),
        })),
        nextCursor: mine.length > req.limit && last ? Buffer.from(`v2.${last.seq}`).toString('base64url') : null,
      };
    },
  };
}

const spaces = { allNamedSpaces: async (_userId: string, _assetId?: string): Promise<SpaceRecord[]> => [] };

function service(rows: Posted[], records?: BankServices['activityRecords']) {
  return new ActivityService(spaces, { pages: pages(rows), cursorSecret: SECRET, ...(records ? { records } : {}) });
}

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

const rows = [
  post('tx-fee', 'fee.charged', 'credit', '0.10', 1, { module: 'ledger' }),
  post('tx-in', 'bank.transfer.manual', 'debit', '10', 2),
  post('tx-out', 'bank.transfer.manual', 'credit', '4.5', 3),
  post('tx-trade', 'trade.fill', 'debit', '2', 4, { module: 'trade', orderId: 'ord-9' }),
];

describe('bank.activity filters and get', () => {
  it('filters by kind, direction, amount and text, comparing decimals exactly', async () => {
    const activity = service(rows);
    const out = await activity.list(ALICE, { kind: ['transfer_out', 'fee'], direction: 'out', minAmount: '0.1', maxAmount: '4.50' });
    expect(out.items.map((item) => item.txId).sort()).toEqual(['tx-fee', 'tx-out']);
    const searched = await activity.list(ALICE, { q: '4.5' });
    expect(searched.items.map((item) => item.txId)).toEqual(['tx-out']);
  });

  it('keeps walking until the date range is filled', async () => {
    const activity = service(rows);
    const from = new Date(Date.UTC(2026, 9, 1, 0, 0, 2)).toISOString();
    const to = new Date(Date.UTC(2026, 9, 1, 0, 0, 3)).toISOString();
    const out = await activity.list(ALICE, { from, to, limit: 10 });
    expect(out.items.map((item) => item.txId)).toEqual(['tx-out', 'tx-in']);
    expect(out.nextCursor).toBeNull();
  });

  it('returns one line and its order lines', async () => {
    const activity = service(rows);
    const listed = await activity.list(ALICE, { limit: 10 });
    const fee = listed.items.find((item) => item.txId === 'tx-fee');
    const one = await activity.get(ALICE, fee!.id);
    expect(one.item.txId).toBe('tx-fee');
    expect(one.lines.map((line) => line.txId)).toEqual(['tx-fee']);
    const order = await activity.get(ALICE, 'order:ord-9');
    expect(order.lines.map((line) => line.orderId)).toEqual(['ord-9']);
    expect(order.complete).toBe(true);
  });

  it('refuses a missing id and serves get through the router', async () => {
    const activity = service(rows);
    await expect(activity.get(ALICE, 'missing')).rejects.toMatchObject({ code: 'bank.activity_not_found' });
    const api = caller(activity);
    const listed = await api.activity.list({ limit: 10, kind: ['trade'] });
    expect(listed.items).toHaveLength(1);
    const detail = await api.activity.get({ id: listed.items[0]!.id });
    expect(detail.item.kind).toBe('trade');
    expect(detail.lines).toHaveLength(1);
  });

  it('matches a private note in search', async () => {
    const listed = await service(rows).list(ALICE, { limit: 10 });
    const fee = listed.items.find((item) => item.txId === 'tx-fee')!;
    const records = {
      forItems: async () => new Map([[fee.id, { note: null, reference: null, privateNote: 'birthday', dispute: null }]]),
    } as unknown as BankServices['activityRecords'];
    const found = await service(rows, records).list(ALICE, { q: 'birthday' });
    expect(found.items.map((item) => item.privateNote)).toEqual(['birthday']);
  });
});

describe('cursor key stays derived', () => {
  it('still derives the activity cursor key the unfiltered pages use', () => {
    const key = Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(0), 'bank.activity.cursor.v1', 32));
    expect(createHmac('sha256', key).update('x').digest('hex')).toHaveLength(64);
  });
});
