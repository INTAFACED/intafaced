import { describe, expect, it } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import { ActivityCursorInvalidError, decodeCursor, encodeCursor } from './activity-cursor.js';
import {
  ActivityService,
  ActivityUnavailableError,
  type LedgerHistoryPages,
  type LedgerPageEntry,
  type LedgerPageRequest,
} from './activity-service.js';

const SECRET = 'a-bank-activity-test-cursor-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ALICE_SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB_SPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const space = (id: string, userId: string, name: string, assetId = 'USDT'): SpaceRecord => ({
  id,
  userId,
  assetId,
  kind: 'named',
  name,
  goalTarget: null,
  lockedUntil: null,
  unlockRequestedAt: null,
  unlocksAt: null,
  archivedAt: null,
});

interface Posted extends LedgerPageEntry {
  /** Only sent by the fake ledger in `entryIds` mode. */
  rowRail?: string | null;
  /** The owner's own trade order the ledger links this posting to. Sent whenever set. */
  rowOrderId?: string | null;
  ownerType: 'user' | 'subaccount';
  ownerId: string;
  /** Position in the book: newer = larger. The real ledger pages on this. */
  seq: number;
}

let seq = 0;
function post(
  ownerType: 'user' | 'subaccount',
  ownerId: string,
  txId: string,
  reason: string,
  direction: 'debit' | 'credit',
  amount: string,
  assetId = 'USDT',
  module = 'bank',
): Posted {
  seq += 1;
  return {
    ownerType,
    ownerId,
    txId,
    module,
    reason,
    direction,
    amount,
    assetId,
    seq,
    postedAt: new Date(Date.UTC(2026, 9, 13, 0, 0, seq)),
  };
}

/** A fake svc-ledger `historyPage`: opaque `v2.<seq>` cursors, newest first, LIMIT+1 for nextCursor. Records every request. */
function fakePages(rows: Posted[], mode: { entryIds?: boolean } = {}) {
  const asked: LedgerPageRequest[] = [];
  const pages: LedgerHistoryPages = {
    async page(req) {
      asked.push(req);
      const before = req.cursor === undefined ? Infinity : Number(Buffer.from(req.cursor, 'base64url').toString().slice(3));
      const mine = rows
        .filter((r) => r.ownerType === req.ownerType && r.ownerId === req.ownerId && r.seq < before)
        .filter((r) => req.assetId === undefined || r.assetId === req.assetId)
        .sort((a, b) => b.seq - a.seq);
      const page = mine.slice(0, req.limit);
      const last = page[page.length - 1];
      return {
        entries: page.map(({ txId, module, reason, direction, amount, postedAt, assetId, seq: entrySeq, rowRail, rowOrderId }) => ({
          txId,
          module,
          reason,
          direction,
          amount,
          postedAt,
          assetId,
          ...(mode.entryIds ? { entryId: String(entrySeq), rail: rowRail ?? null } : {}),
          ...(rowOrderId !== undefined ? { orderId: rowOrderId } : {}),
        })),
        nextCursor: mine.length > req.limit && last ? Buffer.from(`v2.${last.seq}`).toString('base64url') : null,
      };
    },
  };
  return { pages, asked };
}

const spacesOf = (all: SpaceRecord[]) => ({
  allNamedSpaces: async (userId: string, assetId?: string) =>
    all.filter((s) => s.userId === userId && (assetId === undefined || s.assetId === assetId)),
});

function build(rows: Posted[], spaces: SpaceRecord[] = [], mode: { entryIds?: boolean } = {}) {
  const fake = fakePages(rows, mode);
  const service = new ActivityService(spacesOf(spaces), { pages: fake.pages, cursorSecret: SECRET });
  return { service, ...fake };
}

/** Walk every page. */
async function drain(service: ActivityService, userId: string, limit: number, assetId?: string) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pagesRead = 0;
  do {
    const page = await service.list(userId, { limit, cursor, assetId });
    ids.push(...page.items.map((i) => i.txId));
    cursor = page.nextCursor ?? undefined;
    pagesRead += 1;
    expect(pagesRead).toBeLessThan(100);
  } while (cursor !== undefined);
  return ids;
}

describe('ActivityService: merging several owners', () => {
  // Alice: 7 main-account movements and 6 in her Space, interleaved in time. Bob has a Space and money too.
  const rows: Posted[] = [];
  const expectedOrder: string[] = [];
  for (let i = 1; i <= 13; i++) {
    const inSpace = i % 2 === 0 || i === 3;
    const row = inSpace
      ? post('subaccount', ALICE_SPACE, `tx-${i}`, 'bank.transfer.manual', 'debit', '1')
      : post('user', ALICE, `tx-${i}`, 'bank.transfer.manual', 'credit', '1');
    rows.push(row);
    expectedOrder.unshift(`tx-${i}`);
    rows.push(post('user', BOB, `bob-${i}`, 'deposit.credited', 'debit', '999', 'USDT', 'ledger'));
    rows.push(post('subaccount', BOB_SPACE, `bobspace-${i}`, 'deposit.credited', 'debit', '999', 'USDT', 'ledger'));
  }
  const spaces = [space(ALICE_SPACE, ALICE, 'Holiday'), space(BOB_SPACE, BOB, 'Bobs')];

  it.each([1, 2, 3, 5, 6, 13, 50])(
    'paging with limit %i returns every entry once, newest first, across the page boundaries',
    async (limit) => {
      const { service } = build(rows, spaces);
      expect(await drain(service, ALICE, limit)).toEqual(expectedOrder);
    },
  );

  it("names the Space on its rows and never reads or returns another user's money", async () => {
    const { service, asked } = build(rows, spaces);
    const page = await service.list(ALICE, { limit: 200 });
    expect(page.items).toHaveLength(13);
    expect(page.nextCursor).toBeNull();
    expect(page.items.find((i) => i.txId === 'tx-2')?.spaceName).toBe('Holiday');
    expect(page.items.find((i) => i.txId === 'tx-1')?.spaceName).toBeNull();
    expect(JSON.stringify(page)).not.toContain('bob');
    expect(JSON.stringify(page)).not.toContain(BOB);
    const owners = new Set(asked.map((a) => `${a.ownerType}:${a.ownerId}`));
    expect(owners).toEqual(new Set([`user:${ALICE}`, `subaccount:${ALICE_SPACE}`]));
    expect(asked.every((a) => a.kind === 'available')).toBe(true);
  });

  it("never reads another user's Space even if it exists in the book", async () => {
    // Alice has no Space of her own here; Bob's Space holds money.
    const { service, asked } = build(
      rows,
      spaces.filter((s) => s.userId === BOB),
    );
    const page = await service.list(ALICE, { limit: 200 });
    expect(page.items.every((i) => i.spaceName === null)).toBe(true);
    expect(asked.map((a) => a.ownerId)).toEqual([ALICE]);
  });

  it("refuses to treat a Space row that claims another user's id as Alice's", async () => {
    const forged = { ...space(BOB_SPACE, BOB, 'Bobs'), userId: BOB };
    const lister = { allNamedSpaces: async () => [forged] }; // a lister that wrongly returns Bob's Space for Alice
    const fake = fakePages(rows);
    const service = new ActivityService(lister, { pages: fake.pages, cursorSecret: SECRET });
    await service.list(ALICE, { limit: 10 });
    expect(fake.asked.map((a) => a.ownerId)).toEqual([ALICE]);
  });

  it('sends the ledger exactly the strict fields: no purpose, no before, no unknown keys', async () => {
    const { service, asked } = build(rows, spaces);
    await service.list(ALICE, { limit: 5, assetId: 'USDT' });
    for (const req of asked) {
      expect(Object.keys(req).sort()).toEqual(['assetId', 'kind', 'limit', 'ownerId', 'ownerType']);
    }
  });

  it('applies the asset filter to every owner and only reads Spaces of that asset', async () => {
    const mixed = [...rows, post('user', ALICE, 'btc-1', 'trade.fill', 'debit', '0.1', 'BTC', 'trade')];
    const { service, asked } = build(mixed, [...spaces, space('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ALICE, 'Coins', 'BTC')]);
    const page = await service.list(ALICE, { limit: 100, assetId: 'BTC' });
    expect(page.items.map((i) => i.txId)).toEqual(['btc-1']);
    expect(asked.every((a) => a.assetId === 'BTC')).toBe(true);
    expect(asked.map((a) => a.ownerId).sort()).toEqual([ALICE, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'].sort());
  });

  it('keeps both halves of a move between her own pots on one page, as space_move', async () => {
    const lone = post('user', ALICE, 'pay-1', 'bank.transfer.manual', 'credit', '2'); // oldest
    const a = post('user', ALICE, 'mv-1', 'bank.transfer.manual', 'credit', '5');
    const b = post('subaccount', ALICE_SPACE, 'mv-1', 'bank.transfer.manual', 'debit', '5'); // newest
    const { service } = build([lone, a, b], [space(ALICE_SPACE, ALICE, 'Holiday')]);
    // limit 1 would split mv-1 across pages; the second half is pulled in instead.
    const p1 = await service.list(ALICE, { limit: 1 });
    expect(p1.items.map((i) => [i.txId, i.kind, i.direction])).toEqual([
      ['mv-1', 'space_move', 'in'],
      ['mv-1', 'space_move', 'out'],
    ]);
    const p2 = await service.list(ALICE, { limit: 1, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => [i.txId, i.kind])).toEqual([['pay-1', 'transfer_out']]);
    expect(p2.nextCursor).toBeNull();
  });

  it('types rows and carries decimal-string amounts and ISO times', async () => {
    const { service } = build(
      [
        post('user', ALICE, 'd1', 'deposit.credited', 'debit', '100.5', 'USDT', 'ledger'),
        post('user', ALICE, 'f1', 'fee.charged', 'credit', '0.25', 'USDT', 'trade'),
        post('user', ALICE, 'w1', 'withdraw.held', 'credit', '10', 'USDT', 'ledger'),
        post('user', ALICE, 'x1', 'something.new', 'debit', '1', 'USDT', 'newmod'),
      ],
      [],
    );
    const { items } = await service.list(ALICE, { limit: 10 });
    expect(items.map((i) => [i.txId, i.kind, i.direction, i.amount, i.asset])).toEqual([
      ['x1', 'other', 'in', '1', 'USDT'],
      ['w1', 'withdrawal', 'out', '10', 'USDT'],
      ['f1', 'fee', 'out', '0.25', 'USDT'],
      ['d1', 'deposit', 'in', '100.5', 'USDT'],
    ]);
    expect(items[0]!.postedAt).toMatch(/^2026-10-13T00:00:\d\d\.000Z$/);
    expect(new Set(items.map((i) => i.id)).size).toBe(4);
  });

  it('labels a hold, a release and a fill end to end; an unknown posting stays other', async () => {
    const { service } = build([
      post('user', ALICE, 'h1', 'order.hold', 'credit', '50', 'USDT', 'trade'),
      post('user', ALICE, 'f1', 'trade.fill', 'debit', '0.001', 'BTC', 'trade'),
      post('user', ALICE, 'r1', 'order.hold.released', 'debit', '20', 'USDT', 'trade'),
      post('user', ALICE, 'x1', 'something.new', 'debit', '1', 'USDT', 'newmod'),
    ]);
    const { items } = await service.list(ALICE, { limit: 10 });
    expect(items.map((i) => [i.txId, i.kind, i.direction])).toEqual([
      ['x1', 'other', 'in'],
      ['r1', 'order_release', 'in'],
      ['f1', 'trade', 'in'],
      ['h1', 'order_hold', 'out'],
    ]);
  });

  it('gives two entries of one tx in one pot distinct ids (a trade is two assets)', async () => {
    const { service } = build([
      post('user', ALICE, 't1', 'trade.fill', 'debit', '0.1', 'BTC', 'trade'),
      post('user', ALICE, 't1', 'trade.fill', 'credit', '6000', 'USDT', 'trade'),
    ]);
    const { items } = await service.list(ALICE, { limit: 10 });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.every((i) => i.kind === 'trade')).toBe(true);
  });

  it('empty history is an empty page with no cursor', async () => {
    const { service } = build([]);
    expect(await service.list(ALICE, { limit: 20 })).toEqual({ items: [], nextCursor: null });
  });

  it('refuses when no ledger page port is wired, instead of answering empty', async () => {
    const service = new ActivityService(spacesOf([]), {});
    await expect(service.list(ALICE, { limit: 5 })).rejects.toBeInstanceOf(ActivityUnavailableError);
  });

  it('refuses (not empty) when the ledger fails', async () => {
    const service = new ActivityService(spacesOf([]), {
      pages: {
        page: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
      cursorSecret: SECRET,
    });
    await expect(service.list(ALICE, { limit: 5 })).rejects.toBeInstanceOf(ActivityUnavailableError);
  });

  it('counterparty: null without a resolver; a handle (never an id) from one, for transfers only', async () => {
    const t = [
      post('user', ALICE, 'tr-in', 'bank.transfer.manual', 'debit', '3'),
      post('user', ALICE, 'dep', 'deposit.credited', 'debit', '9', 'USDT', 'ledger'),
    ];
    const plain = await build(t).service.list(ALICE, { limit: 10 });
    expect(plain.items.every((i) => i.counterparty === null)).toBe(true);

    const asked: string[][] = [];
    const service = new ActivityService(spacesOf([]), {
      pages: fakePages(t).pages,
      cursorSecret: SECRET,
      counterparties: {
        handlesFor: async (_user, txIds) => {
          asked.push([...txIds]);
          return new Map([['tr-in', { handle: 'bob' }]]);
        },
      },
    });
    const out = await service.list(ALICE, { limit: 10 });
    expect(out.items.find((i) => i.txId === 'tr-in')?.counterparty).toEqual({ handle: 'bob' });
    expect(out.items.find((i) => i.txId === 'dep')?.counterparty).toBeNull();
    expect(asked).toEqual([['tr-in']]);
    expect(JSON.stringify(out)).not.toContain(BOB);
  });

  it('a failing handle lookup never hides the movement', async () => {
    const fake = fakePages([post('user', ALICE, 'tr-in', 'bank.transfer.manual', 'debit', '3')]);
    const service = new ActivityService(spacesOf([]), {
      pages: fake.pages,
      cursorSecret: SECRET,
      counterparties: {
        handlesFor: async () => {
          throw new Error('identity down');
        },
      },
    });
    const out = await service.list(ALICE, { limit: 10 });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.counterparty).toBeNull();
  });
});

describe('ActivityService: the cursor', () => {
  const rows = [1, 2, 3, 4, 5, 6].map((i) => post('user', ALICE, `c-${i}`, 'deposit.credited', 'debit', '1', 'USDT', 'ledger'));

  it('is opaque and signed', async () => {
    const { service } = build(rows);
    const { nextCursor } = await service.list(ALICE, { limit: 2 });
    expect(nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('refuses a forged or mangled cursor with no read', async () => {
    const { service, asked } = build(rows);
    for (const bad of [
      'garbage',
      'a.b',
      '',
      '....',
      encodeCursor('another-secret-entirely-xxxxxxxxxxxxxxxxx', { userId: ALICE, assetId: null, owners: { u: null } }),
    ]) {
      await expect(service.list(ALICE, { limit: 2, cursor: bad })).rejects.toBeInstanceOf(ActivityCursorInvalidError);
    }
    expect(asked).toEqual([]);
  });

  it('refuses an edited cursor: a payload re-pointed at another user keeps the old signature', async () => {
    const { service } = build(rows);
    const { nextCursor } = await service.list(ALICE, { limit: 2 });
    const [payload, mac] = nextCursor!.split('.');
    const body = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    body.u = BOB;
    const edited = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${mac}`;
    await expect(service.list(BOB, { limit: 2, cursor: edited })).rejects.toBeInstanceOf(ActivityCursorInvalidError);
  });

  it("refuses Alice's genuine cursor presented by Bob", async () => {
    const { service, asked } = build(rows);
    const { nextCursor } = await service.list(ALICE, { limit: 2 });
    asked.length = 0;
    await expect(service.list(BOB, { limit: 2, cursor: nextCursor! })).rejects.toBeInstanceOf(ActivityCursorInvalidError);
    expect(asked).toEqual([]);
  });

  it('refuses a cursor used with a different asset filter', async () => {
    const { service } = build(rows);
    const { nextCursor } = await service.list(ALICE, { limit: 2, assetId: 'USDT' });
    await expect(service.list(ALICE, { limit: 2, cursor: nextCursor!, assetId: 'BTC' })).rejects.toBeInstanceOf(ActivityCursorInvalidError);
    await expect(service.list(ALICE, { limit: 2, cursor: nextCursor! })).rejects.toBeInstanceOf(ActivityCursorInvalidError);
  });

  it('a validly signed cursor naming an owner the session does not have reads nothing for it', async () => {
    const { service, asked } = build(rows);
    const signed = encodeCursor(SECRET, { userId: ALICE, assetId: null, owners: { u: null, [`s:${BOB_SPACE}`]: null } });
    await service.list(ALICE, { limit: 3, cursor: signed });
    expect(asked.every((a) => a.ownerId === ALICE)).toBe(true);
    expect(decodeCursor(SECRET, signed, { userId: ALICE, assetId: null }).owners).toHaveProperty(`s:${BOB_SPACE}`);
  });
});

describe('ActivityService: closed Spaces, exact resume, welcome funds, the key', () => {
  const ARCHIVED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const archivedSpace = { ...space(ARCHIVED, ALICE, 'Old trip'), archivedAt: new Date('2026-09-01T00:00:00Z') };

  it('a move into an archived (closed, empty) Space is a space_move, not a payment sent', async () => {
    const out = post('user', ALICE, 'to-closed', 'bank.transfer.manual', 'credit', '40');
    const into = post('subaccount', ARCHIVED, 'to-closed', 'bank.transfer.manual', 'debit', '40');
    const { service, asked } = build([out, into], [archivedSpace]);
    const { items } = await service.list(ALICE, { limit: 10 });
    expect(items.map((i) => [i.kind, i.direction, i.spaceName])).toEqual([
      ['space_move', 'in', 'Old trip'],
      ['space_move', 'out', null],
    ]);
    expect(asked.map((a) => a.ownerId).sort()).toEqual([ALICE, ARCHIVED].sort());
  });

  for (const entryIds of [false, true]) {
    describe(entryIds ? 'ledger sends entryId' : 'ledger without entryId', () => {
      it('a posting between pages causes no duplicate and no gap', async () => {
        const rows: Posted[] = [];
        for (let i = 1; i <= 8; i++) {
          rows.push(
            i % 2
              ? post('user', ALICE, `p-${i}`, 'deposit.credited', 'debit', '1', 'USDT', 'ledger')
              : post('subaccount', ALICE_SPACE, `p-${i}`, 'bank.transfer.manual', 'debit', '1'),
          );
        }
        const { service } = build(rows, [space(ALICE_SPACE, ALICE, 'Holiday')], { entryIds });
        const p1 = await service.list(ALICE, { limit: 3 });
        // A newer posting lands between the two page reads.
        rows.push(post('user', ALICE, 'newer', 'deposit.credited', 'debit', '5', 'USDT', 'ledger'));
        const seen = p1.items.map((i) => i.txId);
        let cursor = p1.nextCursor;
        while (cursor !== null) {
          const next = await service.list(ALICE, { limit: 3, cursor });
          seen.push(...next.items.map((i) => i.txId));
          cursor = next.nextCursor;
        }
        expect(seen).toEqual(['p-8', 'p-7', 'p-6', 'p-5', 'p-4', 'p-3', 'p-2', 'p-1']);
        expect(new Set(seen).size).toBe(seen.length);
      });
    });
  }

  it('with entryId, resumes exactly with no re-read; without it, falls back to one re-read per partly-used owner', async () => {
    const rows: Posted[] = [];
    for (let i = 1; i <= 6; i++)
      rows.push(
        post(i % 2 ? 'user' : 'subaccount', i % 2 ? ALICE : ALICE_SPACE, `r-${i}`, 'deposit.credited', 'debit', '1', 'USDT', 'ledger'),
      );
    const spaces = [space(ALICE_SPACE, ALICE, 'Holiday')];

    const exact = build(rows, spaces, { entryIds: true });
    await exact.service.list(ALICE, { limit: 2 });
    expect(exact.asked).toHaveLength(2); // one read per owner, nothing more

    const legacy = build(rows, spaces);
    await legacy.service.list(ALICE, { limit: 2 });
    expect(legacy.asked.length).toBeGreaterThan(2);
  });

  it('merges equal timestamps across owners by entryId', async () => {
    const a = post('user', ALICE, 'tie-a', 'deposit.credited', 'debit', '1', 'USDT', 'ledger');
    const later = post('subaccount', ALICE_SPACE, 'tie-b', 'deposit.credited', 'debit', '1', 'USDT', 'ledger');
    // Same instant as `a`, later in the book, and a tx id that would sort the other way.
    const b = { ...later, postedAt: a.postedAt, txId: 'aaa-tie-b' };
    const { service } = build([a, b], [space(ALICE_SPACE, ALICE, 'Holiday')], { entryIds: true });
    const { items } = await service.list(ALICE, { limit: 10 });
    expect(items.map((i) => i.txId)).toEqual(['aaa-tie-b', 'tie-a']);
  });

  it('local-test deposits are welcome_funds; a real or unknown rail stays deposit', async () => {
    const mk = (id: string, rail: string | null) => {
      const r = post('user', ALICE, id, 'deposit.credited', 'debit', '1000', 'USDT', 'ledger');
      r.rowRail = rail;
      return r;
    };
    const { service } = build([mk('w', 'local-test'), mk('c', 'crypto-native'), mk('n', null)], [], { entryIds: true });
    const { items } = await service.list(ALICE, { limit: 10 });
    expect(Object.fromEntries(items.map((i) => [i.txId, i.kind]))).toEqual({ w: 'welcome_funds', c: 'deposit', n: 'deposit' });
    // A ledger that does not send the rail yet: everything stays a deposit.
    const old = build([mk('w2', 'local-test')]);
    expect((await old.service.list(ALICE, { limit: 10 })).items[0]!.kind).toBe('deposit');
  });

  it('signs with an HKDF-derived key (info bank.activity.cursor.v1), not the raw secret', async () => {
    const cursor = encodeCursor(SECRET, { userId: ALICE, assetId: null, owners: { u: null } });
    const [payload, mac] = cursor.split('.') as [string, string];
    const derived = Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(0), 'bank.activity.cursor.v1', 32));
    expect(mac).toBe(createHmac('sha256', derived).update(payload).digest('base64url'));
    expect(mac).not.toBe(createHmac('sha256', SECRET).update(payload).digest('base64url'));
    // A cursor signed with the raw secret is refused.
    const rawSigned = `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
    expect(() => decodeCursor(SECRET, rawSigned, { userId: ALICE, assetId: null })).toThrow(ActivityCursorInvalidError);
    expect(decodeCursor(SECRET, cursor, { userId: ALICE, assetId: null }).owners).toEqual({ u: null });
  });
});

// ── Through the real router and the real edge-context ────────────────────────

const EDGE_SECRET = 'a-bank-activity-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-bank' });

function principal(userId: string, scopes: string[] = ['bank:read']): Principal {
  return {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(p: Principal) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-activity',
  });
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function callerFor(service: ActivityService, p: Principal) {
  return createBankRouter({ activity: service } as unknown as BankServices).createCaller(signed(p));
}

describe('bank.activity.list through the router', () => {
  const rows = [
    post('user', ALICE, 'a-dep', 'deposit.credited', 'debit', '100', 'USDT', 'ledger'),
    post('subaccount', ALICE_SPACE, 'a-sp', 'bank.transfer.manual', 'debit', '7'),
    post('user', BOB, 'b-dep', 'deposit.credited', 'debit', '999999', 'USDT', 'ledger'),
  ];
  const spaces = [space(ALICE_SPACE, ALICE, 'Holiday')];

  it("returns the signed-in user's feed (TEST DATA), shaped as the contract says", async () => {
    const { service } = build(rows, spaces);
    const out = await callerFor(service, principal(ALICE)).activity.list({ limit: 10 });
    expect(out.nextCursor).toBeNull();
    expect(out.items.map((i) => [i.txId, i.kind, i.direction, i.amount, i.asset, i.spaceName, i.counterparty])).toEqual([
      ['a-sp', 'transfer_in', 'in', '7', 'USDT', 'Holiday', null],
      ['a-dep', 'deposit', 'in', '100', 'USDT', null, null],
    ]);
  });

  it('is self-only: Bob sees his own, and no input can name another user or owner', async () => {
    const { service, asked } = build(rows, spaces);
    const bobs = await callerFor(service, principal(BOB)).activity.list({ limit: 10 });
    expect(bobs.items.map((i) => i.txId)).toEqual(['b-dep']);
    expect(asked.map((a) => a.ownerId)).toEqual([BOB]);

    const caller = callerFor(service, principal(ALICE)) as unknown as { activity: { list: (i: unknown) => Promise<unknown> } };
    await expect(caller.activity.list({ limit: 10, userId: BOB })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.activity.list({ limit: 10, ownerId: BOB_SPACE, ownerType: 'subaccount' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(asked.every((a) => a.ownerId !== BOB_SPACE)).toBe(true);
  });

  it('refuses an anonymous caller and a token without bank:read, and reads nothing', async () => {
    const { service, asked } = build(rows, spaces);
    const bank = { activity: service } as unknown as BankServices;
    await expect(createBankRouter(bank).createCaller(anonymous()).activity.list({ limit: 5 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(callerFor(service, principal(ALICE, ['trade:read'])).activity.list({ limit: 5 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(asked).toEqual([]);
  });

  it("a forged cursor is BAD_REQUEST; another user's real cursor is too", async () => {
    const { service } = build(rows, spaces);
    await expect(callerFor(service, principal(ALICE)).activity.list({ limit: 1, cursor: 'forged.value' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const first = await callerFor(service, principal(ALICE)).activity.list({ limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    await expect(callerFor(service, principal(BOB)).activity.list({ limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('limit is 1 to 200', async () => {
    const { service } = build(rows, spaces);
    await expect(callerFor(service, principal(ALICE)).activity.list({ limit: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(callerFor(service, principal(ALICE)).activity.list({ limit: 201 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('empty history is an empty feed', async () => {
    const { service } = build([], []);
    expect(await callerFor(service, principal(ALICE)).activity.list({ limit: 10 })).toEqual({ items: [], nextCursor: null });
  });

  it('ledger down is SERVICE_UNAVAILABLE with no internals in the message', async () => {
    const service = new ActivityService(spacesOf([]), {
      pages: {
        page: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.7:4002');
        },
      },
      cursorSecret: SECRET,
    });
    const err = await callerFor(service, principal(ALICE))
      .activity.list({ limit: 5 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect((err as Error).message).not.toContain('ECONNREFUSED');
  });
});

describe('bank.activity.list orderId (what the ledger links to a trade order)', () => {
  const TAKER_ORDER = 'c1111111-1111-4111-8111-c11111111111';
  const MAKER_ORDER = 'c2222222-2222-4222-8222-c22222222222';
  const withOrder = (p: Posted, orderId: string | null): Posted => ({ ...p, rowOrderId: orderId });

  // One fill between Alice (taker, buys BTC with USDT) and Bob (maker, sells BTC). The ledger names each
  // user's own order on that user's own line, so the two users' reads carry different ids for the same tx.
  // A factory, not a constant: `post` bumps a module-wide counter that other tests' timestamps depend on.
  const makeRows = (): Posted[] => [
    withOrder(post('user', ALICE, 'tx-hold', 'order.hold', 'credit', '100', 'USDT', 'trade'), TAKER_ORDER),
    withOrder(post('user', ALICE, 'tx-amend', 'order.hold.amend', 'credit', '20', 'USDT', 'trade'), TAKER_ORDER),
    withOrder(post('user', ALICE, 'tx-fill', 'trade.fill', 'debit', '0.5', 'BTC', 'trade'), TAKER_ORDER),
    withOrder(post('user', ALICE, 'tx-release', 'order.hold.released', 'debit', '30', 'USDT', 'trade'), TAKER_ORDER),
    withOrder(post('user', BOB, 'tx-fill', 'trade.fill', 'debit', '90', 'USDT', 'trade'), MAKER_ORDER),
    post('user', ALICE, 'tx-dep', 'deposit.credited', 'debit', '5', 'USDT', 'ledger'),
    withOrder(post('user', ALICE, 'tx-null', 'trade.fill', 'debit', '1', 'BTC', 'trade'), null),
  ];

  it('a taker fill leg carries the taker order id, and a maker fill leg carries the maker order id', async () => {
    const { service } = build(makeRows());
    const alice = (await service.list(ALICE, {})).items.find((i) => i.txId === 'tx-fill')!;
    const bob = (await service.list(BOB, {})).items.find((i) => i.txId === 'tx-fill')!;
    expect(alice).toMatchObject({ kind: 'trade', asset: 'BTC', orderId: TAKER_ORDER });
    expect(bob).toMatchObject({ kind: 'trade', asset: 'USDT', orderId: MAKER_ORDER });
  });

  it('an order hold, a hold amend and a release carry the order id', async () => {
    const { service } = build(makeRows());
    const items = (await service.list(ALICE, {})).items;
    const by = (txId: string) => items.find((i) => i.txId === txId)!;
    expect(by('tx-hold')).toMatchObject({ kind: 'order_hold', orderId: TAKER_ORDER });
    expect(by('tx-amend')).toMatchObject({ kind: 'order_hold', orderId: TAKER_ORDER });
    expect(by('tx-release')).toMatchObject({ kind: 'order_release', orderId: TAKER_ORDER });
  });

  it('a line the ledger does not link to an order omits orderId (absent or null from the ledger)', async () => {
    const { service } = build(makeRows());
    const items = (await service.list(ALICE, {})).items;
    for (const txId of ['tx-dep', 'tx-null']) {
      const item = items.find((i) => i.txId === txId)!;
      expect(item).not.toHaveProperty('orderId');
    }
  });

  it('is optional on the wire: the router returns orderId when present and omits the key when not', async () => {
    const { service } = build(makeRows());
    const out = await callerFor(service, principal(ALICE)).activity.list({ limit: 50 });
    expect(out.items.find((i) => i.txId === 'tx-fill')).toMatchObject({ orderId: TAKER_ORDER });
    expect(out.items.find((i) => i.txId === 'tx-dep')).not.toHaveProperty('orderId');
  });

  it('leaves the cursor unchanged: it encodes the same positions with or without order ids', async () => {
    const rows = makeRows();
    const plain = rows.map(({ rowOrderId: _o, ...r }) => r as Posted);
    const a = await build(rows).service.list(ALICE, { limit: 2 });
    const b = await build(plain).service.list(ALICE, { limit: 2 });
    expect(a.nextCursor).toBe(b.nextCursor);
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
  });
});
