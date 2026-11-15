/**
 * The operator's partner stop, its state and its changes, against Postgres (project-state #1790). Which partner
 * instructions it refuses is proven where they are made: `partner-moves.db.test.ts` (bank moves) and
 * `cards/card-partner-held.money.test.ts` (card holds, captures, releases and refunds).
 *
 * PG-hard: TEST_DATABASE_URL is required; no skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BankError } from '../errors.js';
import { PartnerStopService, TEST_PARTNER_ID, partnerStopChangeKey, type PartnerStopChange } from './partner-stops.js';

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) throw new Error('TEST_DATABASE_URL is unset: this suite never skips');

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function codeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
  } catch (err) {
    return err instanceof BankError ? err.code : String(err);
  }
  return null;
}

describe('the partner stop (PG)', () => {
  let db: TestDatabase;
  let stops: PartnerStopService;
  let approvals: number;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: DB_URL, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE bank.partner_stops, bank.partner_stop_history`;
    stops = new PartnerStopService(db.sql);
    approvals = 0;
  });

  const change = (over: Partial<PartnerStopChange> = {}): PartnerStopChange => ({
    partnerId: TEST_PARTNER_ID,
    stoppedKinds: ['card_capture', 'bank_move'],
    expectedRevision: 0,
    reason: 'TEST wrong instructions seen',
    consume: async () => {
      approvals += 1;
      return 'approver-2';
    },
    ...over,
  });

  it('never stopped reads open at revision 0; a stop refuses only the kinds it names', async () => {
    expect(await stops.state(TEST_PARTNER_ID)).toMatchObject({ stoppedKinds: [], revision: 0, reason: null });
    await expect(stops.assertOpen(TEST_PARTNER_ID, 'bank_move')).resolves.toBeUndefined();
    const set = await stops.set(change());
    expect(set).toMatchObject({ stoppedKinds: ['bank_move', 'card_capture'], revision: 1, approvedBy: 'approver-2', replayed: false });
    await expect(codeOf(stops.assertOpen(TEST_PARTNER_ID, 'bank_move'))).resolves.toBe('bank.partner_stopped');
    await expect(codeOf(stops.assertOpen(TEST_PARTNER_ID, 'card_capture'))).resolves.toBe('bank.partner_stopped');
    await expect(stops.assertOpen(TEST_PARTNER_ID, 'card_hold')).resolves.toBeUndefined();
    // Another partner is not stopped by this one's row.
    await expect(stops.assertOpen('other-partner', 'bank_move')).resolves.toBeUndefined();
  });

  it('a change needs the second person: a failed approval writes nothing', async () => {
    const refused = stops.set(
      change({
        consume: async () => {
          throw new Error('no second person approved this change');
        },
      }),
    );
    await expect(codeOf(refused)).resolves.toBe('Error: no second person approved this change');
    expect(await stops.state(TEST_PARTNER_ID)).toMatchObject({ revision: 0, stoppedKinds: [] });
  });

  it('the same change replays without a second approval; a different change on the same revision conflicts', async () => {
    await stops.set(change());
    const replay = await stops.set(change({ stoppedKinds: ['bank_move', 'card_capture'] }));
    expect(replay).toMatchObject({ revision: 1, replayed: true });
    expect(approvals).toBe(1);
    await expect(codeOf(stops.set(change({ stoppedKinds: ['card_hold'] })))).resolves.toBe('bank.ops_revision_conflict');
    await expect(codeOf(stops.set(change({ expectedRevision: 5 })))).resolves.toBe('bank.ops_revision_conflict');
  });

  it('two operators on the same revision make one change and one conflict', async () => {
    const results = await Promise.allSettled([
      stops.set(change({ stoppedKinds: ['bank_move'] })),
      stops.set(change({ stoppedKinds: ['card_hold'] })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as BankError).code).toBe('bank.ops_revision_conflict');
    expect((await stops.state(TEST_PARTNER_ID)).revision).toBe(1);
  });

  it('refuses a short reason and an unknown kind before asking for approval', async () => {
    await expect(codeOf(stops.set(change({ reason: 'short' })))).resolves.toBe('bank.ops_reason_too_short');
    await expect(codeOf(stops.set(change({ stoppedKinds: ['wire' as never] })))).resolves.toBe('bank.validation_failed');
    expect(approvals).toBe(0);
  });

  it('lifting is a change too, and the history keeps each one under its business key, newest first', async () => {
    await stops.set(change());
    await stops.set(change({ stoppedKinds: [], expectedRevision: 1, reason: 'TEST partner confirmed the fix' }));
    await expect(stops.assertOpen(TEST_PARTNER_ID, 'bank_move')).resolves.toBeUndefined();
    const history = await stops.historyOf(TEST_PARTNER_ID, 10);
    expect(history.map((h) => [h.revision, h.changeKey, h.stoppedKinds])).toEqual([
      [2, partnerStopChangeKey(TEST_PARTNER_ID, 2), []],
      [1, partnerStopChangeKey(TEST_PARTNER_ID, 1), ['bank_move', 'card_capture']],
    ]);
  });
});
