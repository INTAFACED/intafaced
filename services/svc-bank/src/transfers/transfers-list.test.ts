import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { ActivityService, type LedgerHistoryPages, type LedgerPageEntry, type LedgerPageRequest } from '../activity/activity-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';

/** W-balances-03: `bank.transfers.list` is the caller's own transfer history, read from the activity feed. */

const SECRET = 'a-bank-transfers-list-test-secret-long-enough';
const EDGE = 'a-bank-transfers-list-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SPACE = '33333333-3333-4333-8333-333333333333';

type Row = LedgerPageEntry & { ownerType: 'user' | 'subaccount'; ownerId: string; seq: number };
function row(txId: string, module: string, reason: string, direction: 'debit' | 'credit', seq: number, owner?: string): Row {
  return {
    ownerType: owner ? 'subaccount' : 'user',
    ownerId: owner ?? ALICE,
    txId,
    module,
    reason,
    direction,
    amount: '5',
    assetId: 'USDT',
    seq,
    postedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
    entryId: String(seq),
  };
}

function pages(rows: Row[]): LedgerHistoryPages {
  return {
    async page(req: LedgerPageRequest) {
      const before = req.cursor === undefined ? Infinity : Number(Buffer.from(req.cursor, 'base64url').toString().slice(3));
      const mine = rows
        .filter((r) => r.ownerType === req.ownerType && r.ownerId === req.ownerId && r.seq < before)
        .sort((a, b) => b.seq - a.seq);
      const page = mine.slice(0, req.limit);
      const last = page[page.length - 1];
      return {
        entries: page.map(({ ownerType: _t, ownerId: _o, seq: _s, ...entry }) => entry),
        nextCursor: mine.length > req.limit && last ? Buffer.from(`v2.${last.seq}`).toString('base64url') : null,
      };
    },
  };
}

const space = { id: SPACE, userId: ALICE, assetId: 'USDT', kind: 'named', name: 'Rent' } as SpaceRecord;

function caller(rows: Row[], userId = ALICE) {
  const activity = new ActivityService(
    { allNamedSpaces: async () => (userId === ALICE ? [space] : []) },
    { pages: pages(rows), cursorSecret: SECRET },
  );
  const principal = {
    sub: userId,
    userId,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return createBankRouter({ activity } as unknown as BankServices).createCaller(
    createEdgeContext({ secret: EDGE, serviceName: 'svc-bank' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req',
    }),
  );
}

describe('bank.transfers.list', () => {
  const rows = [
    row('tx-sent', 'bank', 'bank.transfer.manual', 'credit', 1),
    row('tx-got', 'bank', 'bank.transfer.manual', 'debit', 2),
    row('tx-trade', 'trade', 'trade.fill', 'debit', 3),
    row('tx-move', 'bank', 'bank.transfer.manual', 'credit', 4),
    row('tx-move', 'bank', 'bank.transfer.manual', 'debit', 5, SPACE),
    row('tx-fee', 'ledger', 'fee.charged', 'credit', 6),
  ];

  it('lists transfers and own moves only, newest first, each completed, and leaves trades and fees out', async () => {
    const out = await caller(rows).transfers.list();
    expect(out.items.map((i) => `${i.txId}:${i.kind}:${i.direction}`)).toEqual([
      'tx-move:space_move:in',
      'tx-move:space_move:out',
      'tx-got:transfer_in:in',
      'tx-sent:transfer_out:out',
    ]);
    expect(out.items.every((i) => i.status === 'completed' && i.asset === 'USDT')).toBe(true);
    expect(out.items.find((i) => i.spaceName === 'Rent')?.direction).toBe('in');
  });

  it('pages without a gap or repeat', async () => {
    const api = caller(rows);
    const first = await api.transfers.list({ limit: 2 });
    const second = await api.transfers.list({ limit: 2, cursor: first.nextCursor! });
    expect([...first.items, ...second.items].map((i) => i.id)).toHaveLength(4);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(4);
    expect(second.nextCursor).toBeNull();
  });

  it("never shows another customer's transfers: the caller's own accounts are the only ones read", async () => {
    const out = await caller(rows, BOB).transfers.list();
    expect(out.items).toEqual([]);
  });

  it('refuses an unknown input key instead of stripping it', async () => {
    await expect(caller(rows).transfers.list({ userId: BOB } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
