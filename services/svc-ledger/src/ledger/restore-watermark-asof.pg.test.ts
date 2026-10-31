import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { LedgerError, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { MemoryEventBus } from '@intafaced/events';
import { restoreWatermarkReadSchema } from '@intafaced/contracts';
import { LedgerService } from '../service.js';
import { PostgresLedger } from './postgres-ledger.js';

/**
 * The ledger's restore watermark as of a cut-off (OPS-ledger-desk-05, RS-3) on the real ledger: the newest seq posted at
 * or before the instant, unmoved by posts after it, and refused for a cut-off that has not passed.
 *
 * H8a PG-hard: this file never skips. CI uses TEST_DATABASE_URL. Local without
 * that env starts Testcontainers postgres:16-alpine.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const H8A_IMAGE = 'postgres:16-alpine';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** A TEST clock skew bound: the cut-off must be more than this far past before it is answered. */
const BOUND = 50;

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_restore_watermark_asof_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: the as-of watermark is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('restore watermark as of a cut-off on the real ledger', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_restore_watermark_asof', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql, { clockSkewBoundMs: BOUND });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const deposit = (n: number) =>
    engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1'), rail: 'crypto-native', railRef: `tx-wm-${n}` }));
  const pause = (ms = BOUND + 20) => new Promise((r) => setTimeout(r, ms));

  it('answers the genesis tip before any post, and the newest seq at or before the cut-off after', async () => {
    const before = new Date();
    await pause();
    expect((await engine.restoreWatermarkAsOf(before)).position).toBe('0');

    await deposit(1);
    await deposit(2);
    await pause();
    const cutOff = new Date();
    await pause();
    const atCut = await engine.restoreWatermarkAsOf(cutOff);
    expect(atCut.position).toBe((await engine.restoreWatermark()).position);

    // Posts after the cut-off move the live tip, never the position as of the cut-off.
    await deposit(3);
    await deposit(4);
    const live = await engine.restoreWatermark();
    expect(BigInt(live.position)).toBeGreaterThan(BigInt(atCut.position));
    expect((await engine.restoreWatermarkAsOf(cutOff)).position).toBe(atCut.position);
    expect((await engine.restoreWatermarkAsOf(cutOff)).lastWriteAt?.getTime()).toBe(live.lastWriteAt?.getTime());
  });

  it('refuses a cut-off not yet more than the skew bound past, and any cut-off while the bound is blank', async () => {
    const future = new Date(Date.now() + 60_000);
    await expect(engine.restoreWatermarkAsOf(future)).rejects.toMatchObject({ code: 'ledger.restore_asof_unanswerable' });
    await expect(engine.restoreWatermarkAsOf(new Date())).rejects.toMatchObject({ code: 'ledger.restore_asof_unanswerable' });
    await expect(engine.restoreWatermarkAsOf(future)).rejects.toBeInstanceOf(LedgerError);
    const unbounded = new PostgresLedger(db!.sql);
    await expect(unbounded.restoreWatermarkAsOf(new Date(Date.now() - 60_000))).rejects.toMatchObject({ code: 'ledger.skew_bound_unset' });
  });

  it('waits out a post holding the chain tip, so a post in flight is counted, not missed', async () => {
    const cutOff = new Date(Date.now() - 1000);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db!.sql.begin(async (tx) => {
      await tx`SELECT seq FROM chain_tip WHERE id = true FOR UPDATE`;
      locked();
      await held;
    });
    await isLocked;
    let settled = false;
    const read = engine.restoreWatermarkAsOf(cutOff).finally(() => (settled = true));
    await pause(200);
    expect(settled, 'the read waits while a post holds the tip').toBe(false);
    release();
    await holder;
    await expect(read).resolves.toMatchObject({ position: expect.stringMatching(/^\d+$/) });
  });

  it('the service answers live for an empty body, as of the instant for { asOf } with it echoed, and refuses a bad one', async () => {
    const service = new LedgerService(db!.sql, new MemoryEventBus('restore-watermark-asof'), { clockSkewBoundMs: BOUND });
    const live = restoreWatermarkReadSchema.parse(await service.restoreWatermark({}));
    expect(live.asOf).toBeUndefined();
    const cutOff = new Date(Date.now() - 1000).toISOString();
    const asOf = restoreWatermarkReadSchema.parse(await service.restoreWatermark({ asOf: cutOff }));
    expect(asOf).toMatchObject({ service: 'ledger', kind: 'chain_tip.seq', asOf: cutOff });
    await expect(service.restoreWatermark({ asOf: 'yesterday' })).rejects.toMatchObject({ code: 'ledger.restore_asof_invalid' });
    await expect(service.restoreWatermark({ asOf: cutOff, live: true })).rejects.toMatchObject({ code: 'ledger.restore_asof_invalid' });
    await expect(service.restoreWatermark(cutOff)).rejects.toMatchObject({ code: 'ledger.restore_asof_invalid' });
    await expect(service.restoreWatermark([])).rejects.toMatchObject({ code: 'ledger.restore_asof_invalid' });
  });
});
