import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlScreeningCaseStore, screeningSubjectKey } from './store.js';

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle', '0062_pay_screening_cases.sql'),
  'utf8',
);

describe('screening case row', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'pay', migrations: [migration] });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('stores one unavailable case for a repeated payout key', async () => {
    const store = createSqlScreeningCaseStore(db.sql);
    const key = screeningSubjectKey('payout', ['11111111-1111-4111-8111-111111111111', '0']);
    const record = {
      subjectKind: 'payout' as const,
      subjectKey: key,
      status: 'unavailable' as const,
      factors: [{ code: 'no_result' }],
    };
    await store.save(record);
    await store.save(record);
    expect(await store.read('payout', key)).toEqual(record);
    const rows = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.screening_cases`;
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('stores clear, review, refuse, and unavailable as those statuses', async () => {
    const store = createSqlScreeningCaseStore(db.sql);
    for (const status of ['clear', 'review', 'refuse', 'unavailable'] as const) {
      const key = screeningSubjectKey('withdrawal', [status]);
      await store.save({ subjectKind: 'withdrawal', subjectKey: key, status, factors: [{ code: `provider_${status}` }] });
      expect((await store.read('withdrawal', key))?.status).toBe(status);
    }
  });
});
