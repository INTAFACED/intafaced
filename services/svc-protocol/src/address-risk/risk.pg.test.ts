import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresAddressRiskStore } from './risk.pg.js';
import { readAddressRisk, submitReport } from './risk.js';

/** `protocol.address_labels` and `protocol.address_reports` (20261107073648) on a real test database. Deletes only this file's rows. */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '20261107073648_protocol_address_risk.sql');
const available = URL ? await postgresAvailable(URL) : false;
const db = URL && available ? createDb({ url: URL, schema: 'protocol', max: 2 }, {}) : null;
const sql: Sql | null = db?.sql ?? null;
const CHAIN_ID = 84532;
const SUSPECT = '0x000000000000000000000000000000000000bAD1' as Address;
const REPORTER = '44444444-4444-4444-8444-444444444444';

if (!sql) {
  describe.skip('address risk store (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('address risk store (Postgres)', () => {
    const cleanup = async () => {
      await sql!`DELETE FROM protocol.address_reports WHERE address = ${SUSPECT}`;
      await sql!`DELETE FROM protocol.address_labels WHERE address = ${SUSPECT}`;
    };
    beforeAll(async () => {
      await assertTestDatabase(sql!, 'svc-protocol risk.pg.test');
      await sql!`CREATE SCHEMA IF NOT EXISTS protocol`;
      await sql!.unsafe(readFileSync(migration, 'utf8'));
      await cleanup();
    });
    afterAll(async () => {
      await cleanup();
      await db!.close();
    });

    it('one open report per person and address, enforced by the database; the count reads it', async () => {
      const store = new PostgresAddressRiskStore(sql!);
      const input = { chainId: CHAIN_ID, reporterId: REPORTER, address: SUSPECT.toLowerCase(), kind: 'scam' as const };
      const receipt = await submitReport(store, input);
      expect(receipt.address).toBe(SUSPECT);
      await expect(submitReport(store, input)).rejects.toMatchObject({ code: 'protocol.reports.duplicate' });
      // Two at once still leave one row.
      await Promise.allSettled([submitReport(store, input), submitReport(store, input)]);
      expect((await readAddressRisk(store, { chainId: CHAIN_ID, address: SUSPECT, screeningLoaded: false })).openReports).toBe(1);
    });

    it('reads a published label with its reason', async () => {
      await sql!`
        INSERT INTO protocol.address_labels (chain_id, address, kind, value, source, reputation, reason, set_by)
        VALUES (${CHAIN_ID}, ${SUSPECT}, 'phishing', 'TEST phishing', 'curator', 'UNSAFE', 'TEST: drains approvals', 'TEST')`;
      const risk = await readAddressRisk(new PostgresAddressRiskStore(sql!), {
        chainId: CHAIN_ID,
        address: SUSPECT,
        screeningLoaded: false,
      });
      expect(risk.reputation).toBe('UNSAFE');
      expect(risk.labels[0]).toMatchObject({ kind: 'phishing', reason: 'TEST: drains approvals', version: 1 });
      expect(Number.isNaN(Date.parse(risk.labels[0]!.setAt))).toBe(false);
    });
  });
}
