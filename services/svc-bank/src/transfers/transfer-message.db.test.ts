/**
 * Space-to-space transfer words on real Postgres, and the personal-send path
 * that must not copy those words into bank.transfer_messages.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable, type LedgerTx } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import type { LedgerPageEntry, LedgerPageRequest } from '../activity/activity-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'd'.repeat(32);
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CARA = '33333333-3333-4333-8333-333333333333';
const SID = '77777777-7777-4777-8777-777777777777';

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

function principal(userId: string): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function historyPages(ledger: MemoryLedger) {
  return {
    async page(req: LedgerPageRequest): Promise<{ entries: LedgerPageEntry[]; nextCursor: string | null }> {
      if (req.cursor !== undefined || req.ownerType !== 'user') return { entries: [], nextCursor: null };
      const assetId = req.assetId ?? 'USDT';
      const { accountId } = await ledger.balance(userAvailable(req.ownerId, assetId));
      const entries: LedgerPageEntry[] = [];
      for (const tx of ledger.journal() as LedgerTx[]) {
        for (const entry of tx.entries) {
          if (entry.accountId !== accountId) continue;
          if (req.assetId !== undefined && entry.assetId !== req.assetId) continue;
          entries.push({
            txId: tx.id,
            module: tx.module,
            reason: tx.reason,
            direction: entry.direction,
            amount: formatAmount(entry.amount),
            postedAt: tx.postedAt,
            assetId: entry.assetId,
            entryId: entry.id,
          });
        }
      }
      entries.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
      return { entries: entries.slice(0, req.limit), nextCursor: null };
    },
  };
}

describe('transfer notes on Postgres', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: BankServices;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    db = await createTestDatabase({ service: 'bank', url: dedicatedTestUrl(raw), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.activity_disputes, bank.activity_note_commands, bank.activity_notes,
               bank.transfer_messages, bank.personal_transfers, bank.personal_requests,
               bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      recipients: memoryRecipientState(),
      activity: { cursorSecret: SECRET, pages: historyPages(ledger) },
    });
  });

  function caller(userId: string) {
    const raw = encodePrincipal(principal(userId));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  async function fundedSpaces() {
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: randomUUID() }));
    const from = await bank.spaces.ensurePrimary(ALICE, 'USDT');
    const to = await bank.spaces.ensurePrimary(BOB, 'USDT');
    await bank.spaces.ensurePrimary(CARA, 'USDT');
    return { from, to };
  }

  it('keeps one note for transfers.create, shows it to the two parties, and hides it from a third', async () => {
    const { from, to } = await fundedSpaces();
    const alice = caller(ALICE);
    const posted = await alice.transfers.create({
      transferId: 'create-note-0001',
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '10',
      note: 'for lunch',
    });
    await expect(
      alice.transfers.create({
        transferId: 'create-note-0001',
        fromSpaceId: from.id,
        toSpaceId: to.id,
        amount: '10',
        note: 'a different note',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'bank.transfer_message_conflict' } });

    const bare = await alice.transfers.create({
      transferId: 'create-none-0001',
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '1',
    });
    await expect(
      alice.transfers.create({
        transferId: 'create-none-0001',
        fromSpaceId: from.id,
        toSpaceId: to.id,
        amount: '1',
        note: 'too late',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'bank.transfer_message_conflict' } });
    expect(bare.ledgerTxId).not.toBe(posted.ledgerTxId);

    const aliceFeed = await alice.activity.list({ limit: 50 });
    const bobFeed = await caller(BOB).activity.list({ limit: 50 });
    const caraFeed = await caller(CARA).activity.list({ limit: 50 });
    expect(aliceFeed.items.some((item) => item.txId === posted.ledgerTxId && item.note === 'for lunch')).toBe(true);
    expect(bobFeed.items.some((item) => item.txId === posted.ledgerTxId && item.note === 'for lunch')).toBe(true);
    expect(caraFeed.items.some((item) => item.note === 'for lunch')).toBe(false);
    const hidden = await bank.activityRecords.forItems(CARA, [{ id: 'cara-line', txId: posted.ledgerTxId }]);
    expect(hidden.get('cara-line')?.note ?? null).toBeNull();
  });

  it('transfers.toUser with a note writes no bank.transfer_messages row', async () => {
    const { from } = await fundedSpaces();
    await sql`INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) VALUES ('USDT', 1000, 10000, 0) ON CONFLICT DO NOTHING`;
    const sent = await caller(ALICE).transfers.toUser({
      transferId: 'touser-note-01',
      fromSpaceId: from.id,
      toUserId: BOB,
      amount: '4',
      note: 'personal hello',
      reference: 'INV-1',
    });
    expect(sent.note).toBe('personal hello');
    expect(sent.reference).toBe('INV-1');
    const messages = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM bank.transfer_messages`;
    expect(messages[0]?.n).toBe('0');
    const stored = await sql<Array<{ note: string | null; reference: string | null }>>`
      SELECT note, reference FROM bank.personal_transfers WHERE transfer_id = 'touser-note-01'
    `;
    expect(stored).toEqual([{ note: 'personal hello', reference: 'INV-1' }]);
    const aliceFeed = await caller(ALICE).activity.list({ limit: 50 });
    const bobFeed = await caller(BOB).activity.list({ limit: 50 });
    expect(
      aliceFeed.items.some((item) => item.txId === sent.ledgerTxId && item.note === 'personal hello' && item.reference === 'INV-1'),
    ).toBe(true);
    expect(
      bobFeed.items.some((item) => item.txId === sent.ledgerTxId && item.note === 'personal hello' && item.reference === 'INV-1'),
    ).toBe(true);
  });
});
