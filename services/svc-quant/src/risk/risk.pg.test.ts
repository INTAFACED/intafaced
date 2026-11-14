import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAvailable } from '@intafaced/db/testing';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresRiskRepository } from './postgres-repository.js';

// AL-risk-01: a strategy's caps and trading switch on Postgres.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qrisk_${process.pid}_${Date.now().toString(36)}`;
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const databaseUrl = process.env.TEST_DATABASE_URL_QUANT?.trim() || process.env.TEST_DATABASE_URL?.trim();
const ready = await postgresAvailable(databaseUrl);

if (!ready) {
  describe.skip('strategy risk store (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('strategy risk store on Postgres (AL-risk-01)', () => {
    const sql = postgres(databaseUrl!, { max: 4, onnotice: () => undefined });
    const repo = createPostgresRiskRepository(sql, SCHEMA);

    beforeAll(async () => {
      const lock: Sql = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
      await lock`SELECT pg_advisory_lock(hashtext('svc-quant.AL-risk-01.migrate'))`;
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
        const migration = readFileSync(join(SERVICE, 'drizzle/20261115130000_quant_strategy_risk.sql'), 'utf8').replaceAll(
          '"quant"',
          `"${SCHEMA}"`,
        );
        await sql.unsafe(migration);
      } finally {
        await lock`SELECT pg_advisory_unlock(hashtext('svc-quant.AL-risk-01.migrate'))`;
        await lock.end({ timeout: 5 });
      }
    });

    afterAll(async () => {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await sql.end({ timeout: 5 });
    });

    it('keeps blank caps blank, reads saved caps back as the decimals they were, and keeps the switch apart from the caps', async () => {
      expect(await repo.get({ accountId: ACCOUNT_A, strategyId: 's1' })).toBeNull();
      const on = await repo.setTrading({ accountId: ACCOUNT_A, strategyId: 's1', version: 3 });
      expect(on).toMatchObject({ caps: { depositPercent: null, equityFloor: null }, floorPolicy: null, tradingVersion: 3 });
      const caps = { depositPercent: '12.5', maxPositionNotional: '500', maxDailyLoss: null, equityFloor: '999.99' };
      const saved = await repo.saveCaps({ accountId: ACCOUNT_A, strategyId: 's1', caps, floorPolicy: 'close_out' });
      expect(saved).toMatchObject({ caps, floorPolicy: 'close_out', tradingVersion: 3 });
      expect(await repo.get({ accountId: ACCOUNT_A, strategyId: 's1' })).toMatchObject({ caps, tradingVersion: 3 });
      expect((await repo.setTrading({ accountId: ACCOUNT_A, strategyId: 's1', version: null })).caps).toEqual(caps);
      expect(await repo.get({ accountId: ACCOUNT_B, strategyId: 's1' })).toBeNull();
    });

    it('refuses a policy the screen does not offer at the table', async () => {
      await expect(
        sql.unsafe(`INSERT INTO "${SCHEMA}"."strategy_risk" (account_id, strategy_id, floor_policy) VALUES ($1::uuid, 's2', 'liquidate')`, [
          ACCOUNT_A,
        ]),
      ).rejects.toThrow(/strategy_risk_policy_ck/);
    });
  });
}
