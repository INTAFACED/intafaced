import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
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

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:u:USDT:out';

if (!process.env.TEST_DATABASE_URL?.trim()) {
  throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
}

describe('activity notes, disputes and transfer messages', () => {
  let db!: TestDatabase;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    db = await createTestDatabase({ service: 'bank', url: dedicatedTestUrl(raw), migrations });
  }, 120_000);

  afterAll(() => db?.drop());

  it('stores a report description beside the note, keeps what a write leaves out, and replays one press once', async () => {
    const records = new ActivityRecordService(db.sql);
    const line = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:u:USDT:out';
    await expect(records.setNote(ALICE, { activityId: line, commandId: 'desc-cmd-0000' })).rejects.toMatchObject({
      code: 'bank.activity_note_empty',
    });
    const first = await records.setNote(ALICE, { activityId: line, reportDescription: 'Office rent', commandId: 'desc-cmd-0001' });
    expect(first).toMatchObject({ text: null, reportDescription: 'Office rent' });
    const replay = await records.setNote(ALICE, { activityId: line, reportDescription: 'Office rent', commandId: 'desc-cmd-0001' });
    expect(replay.updatedAt).toBe(first.updatedAt);
    await expect(
      records.setNote(ALICE, { activityId: line, reportDescription: 'Different', commandId: 'desc-cmd-0001' }),
    ).rejects.toMatchObject({ code: 'bank.activity_note_conflict' });
    // A later note keeps the description.
    const both = await records.setNote(ALICE, { activityId: line, text: 'rent', commandId: 'desc-cmd-0002' });
    expect(both).toMatchObject({ text: 'rent', reportDescription: 'Office rent' });
    const read = (await records.forItems(ALICE, [{ id: line, txId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])).get(line);
    expect(read).toMatchObject({ privateNote: 'rent', reportDescription: 'Office rent' });
    // Another customer sees neither.
    expect((await records.forItems(BOB, [{ id: line, txId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])).get(line)).toBeUndefined();
  });

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

  it('names the crypto address of a withdrawal by each of its ledger transactions, for its owner only', async () => {
    const records = new ActivityRecordService(db.sql);
    const address = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    await db.sql`
      INSERT INTO bank.ramp_offramps (user_id, asset_id, amount, kind, rail, destination_ref, client_ref, status, hold_ledger_tx_id, settle_ledger_tx_id)
      VALUES (${ALICE}, 'USDT', 5, 'crypto', 'test', ${address}, 'wd-address-1', 'settled', 'tx-hold-1', 'tx-settle-1')
    `;
    const found = await records.addressesFor(ALICE, ['tx-hold-1', 'tx-settle-1', 'tx-other']);
    expect([...found.entries()].sort()).toEqual([
      ['tx-hold-1', address],
      ['tx-settle-1', address],
    ]);
    // Someone else's withdrawal is never reported for this customer.
    expect((await records.addressesFor(BOB, ['tx-hold-1'])).size).toBe(0);
    expect((await records.addressesFor(ALICE, [])).size).toBe(0);
  });
});
