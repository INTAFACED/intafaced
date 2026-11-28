import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P2P_INSTRUMENTS_CREATE } from '@intafaced/contracts/p2p-procedures';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { recordingSql } from './testing/sql-recorder-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const OWNER = '11111111-1111-4111-8111-111111111111';
const GIVEN = '66666666-6666-4666-8666-666666666666';

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  let url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    const container = await testPostgres('postgres:16-alpine')
      .withDatabase('intafaced_instrument_id_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    url = container.getConnectionUri();
    stop = async () => void (await container.stop());
  }
  db = await createTestDatabase({ service: 'p2p', url, migrations });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);

describe('instruments.create requires a caller instrumentId', () => {
  it('does not mint a UUID on add', async () => {
    // Blank is refused by name before anything is read.
    const { sql, calls } = recordingSql();
    const add = { ownerId: OWNER, methodId: 'sepa', country: 'DE', fiatCurrency: 'USD', details: { account_reference: 'ref-1' } };
    for (const instrumentId of ['', '   ']) {
      await expect(new InstrumentService(sql).createInstrument({ ...add, instrumentId })).rejects.toMatchObject({
        code: 'p2p.instrument_id_required',
      });
    }
    expect(calls).toHaveLength(0);

    // A given id is the stored instrument's id, read back by it.
    const instruments = new InstrumentService(db!.sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Bank transfer (test fixture)',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    await expect(instruments.createInstrument({ ...add, instrumentId: ` ${GIVEN} ` })).resolves.toMatchObject({ id: GIVEN });
    expect((await instruments.listInstruments(OWNER, false, 10)).map((row) => row.id)).toEqual([GIVEN]);
  });

  it('the create record refuses a missing or non-UUID instrumentId (the mounted door: router.mount.test.ts)', () => {
    const add = { methodId: 'sepa', country: 'DE', fiatCurrency: 'EUR', details: { iban: 'DE00' } };
    expect(P2P_INSTRUMENTS_CREATE.input.safeParse(add).success).toBe(false);
    expect(P2P_INSTRUMENTS_CREATE.input.safeParse({ ...add, instrumentId: 'not-a-uuid' }).success).toBe(false);
    expect(P2P_INSTRUMENTS_CREATE.input.safeParse({ ...add, instrumentId: '66666666-6666-4666-8666-666666666666' }).success).toBe(true);
  });
});
