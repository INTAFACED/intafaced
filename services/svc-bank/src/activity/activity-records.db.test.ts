import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, resolveTestDatabaseUrl, type TestDatabase } from '@intafaced/db';
import { ActivityRecordService } from './activity-records.js';
import { attachTransferMessageTx, bindTransferMessage } from '../transfers/transfer-message.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

/** The shared env names database `test`. The harness only accepts a name ending in `_test`. `intafaced_test` is that database on the same server. */
function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const ADMIN_URL = dedicatedTestUrl(
  resolveTestDatabaseUrl(undefined, 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test'),
);
const available = await postgresAvailable(ADMIN_URL);
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:u:USDT:out';

const db: TestDatabase = available
  ? await createTestDatabase({ service: 'bank', url: ADMIN_URL, migrations })
  : (undefined as unknown as TestDatabase);

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(!available)('activity notes, disputes and transfer messages', () => {
  it('replays a note, keeps one open dispute, and shows a transfer note to both parties', async () => {
    const records = new ActivityRecordService(db.sql);
    const note = await records.setNote(ALICE, { activityId: LINE, text: 'rent', commandId: 'note-cmd-0001' });
    expect(note.text).toBe('rent');
    expect((await records.setNote(ALICE, { activityId: LINE, text: 'rent', commandId: 'note-cmd-0001' })).updatedAt).toBe(note.updatedAt);
    await expect(records.setNote(ALICE, { activityId: LINE, text: 'other', commandId: 'note-cmd-0001' })).rejects.toMatchObject({
      code: 'bank.activity_note_conflict',
    });

    const disputeId = '44444444-4444-4444-8444-444444444444';
    const opened = await records.openDispute(ALICE, { activityId: LINE, reason: 'I did not send this', disputeId });
    expect(opened.status).toBe('open');
    expect((await records.openDispute(ALICE, { activityId: LINE, reason: 'I did not send this', disputeId })).createdAt).toBe(
      opened.createdAt,
    );
    await expect(
      records.openDispute(ALICE, {
        activityId: LINE,
        reason: 'different',
        disputeId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toMatchObject({ code: 'bank.activity_dispute_exists' });

    const ledger = { getTxByKey: async () => null };
    await bindTransferMessage(db.sql, ledger, {
      transferId: 'transfer-0001',
      fromUserId: ALICE,
      toUserId: BOB,
      note: 'for lunch',
      reference: 'LUNCH',
    });
    await attachTransferMessageTx(db.sql, 'transfer-0001', 'tx-lunch');
    await expect(
      bindTransferMessage(
        db.sql,
        { getTxByKey: async () => ({ id: 'tx-lunch' }) },
        {
          transferId: 'transfer-0001',
          fromUserId: ALICE,
          toUserId: BOB,
          note: 'changed',
          reference: 'LUNCH',
        },
      ),
    ).rejects.toMatchObject({ code: 'bank.transfer_message_conflict' });

    const alice = await records.forItems(ALICE, [{ id: LINE, txId: 'tx-lunch' }]);
    const bob = await records.forItems(BOB, [{ id: 'other-line', txId: 'tx-lunch' }]);
    expect(alice.get(LINE)?.note).toBe('for lunch');
    expect(alice.get(LINE)?.privateNote).toBe('rent');
    expect(bob.get('other-line')?.note).toBe('for lunch');
    expect(bob.get('other-line')?.privateNote).toBeNull();
    expect(bob.get('other-line')?.dispute).toBeNull();
  });
});
