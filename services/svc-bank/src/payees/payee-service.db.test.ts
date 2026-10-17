import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, resolveTestDatabaseUrl, type TestDatabase } from '@intafaced/db';
import { PayeeService } from './payee-service.js';

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
const CARA = '33333333-3333-4333-8333-333333333333';

const db: TestDatabase = available
  ? await createTestDatabase({ service: 'bank', url: ADMIN_URL, migrations })
  : (undefined as unknown as TestDatabase);

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(!available)('bank.payees on Postgres', () => {
  it('saves, lists, replays and removes per customer', async () => {
    const payees = new PayeeService(db.sql);
    const saved = await payees.add(ALICE, { commandId: 'cmd-add-bob-01', userId: BOB, nickname: 'Bob' });
    expect(saved).toMatchObject({ userId: BOB, nickname: 'Bob', handle: null });
    const again = await payees.add(ALICE, { commandId: 'cmd-add-bob-01', userId: BOB, nickname: 'Bob' });
    expect(again.addedAt).toBe(saved.addedAt);
    await expect(payees.add(ALICE, { commandId: 'cmd-add-bob-01', userId: BOB, nickname: 'Robert' })).rejects.toMatchObject({
      code: 'bank.payee_command_conflict',
    });
    await expect(payees.add(ALICE, { commandId: 'cmd-add-self-1', userId: ALICE, nickname: null })).rejects.toMatchObject({
      code: 'bank.payee_self',
    });
    expect(await payees.list(ALICE)).toHaveLength(1);
    expect(await payees.list(BOB)).toEqual([]);
    expect(await payees.remove(ALICE, { commandId: 'cmd-rm-bob-01', userId: BOB })).toEqual({ removed: true });
    expect(await payees.remove(ALICE, { commandId: 'cmd-rm-bob-01', userId: BOB })).toEqual({ removed: true });
    expect(await payees.list(ALICE)).toEqual([]);
    expect(await payees.remove(ALICE, { commandId: 'cmd-rm-cara-1', userId: CARA })).toEqual({ removed: false });
  });
});
