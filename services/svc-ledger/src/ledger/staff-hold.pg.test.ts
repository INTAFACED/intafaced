import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  InsufficientFundsError,
  formatAmount,
  parseAmount as amt,
  recipes,
  staffHoldAccount,
  staffHoldConfirmAccount,
  userAvailable,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';

/**
 * Staff holds on funds (ops ENGINE LC-8, OPS-accounts-desk-01) on the real
 * ledger: J-ops-console-04's TEST amounts (hold 40.00 of 100.00, release 15.00,
 * confirm the remaining 25.00 once), each key posts once, releases plus confirms
 * never exceed the placed amount, and a release racing a confirm for the same
 * remainder leaves exactly one winner. No migration: the pot is a user hold row
 * with its own purpose `ops:hold:<holdNo>`, upserted by the first hold.
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

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_staff_hold_test')
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
      `H8a: staff holds are PG-hard (no skip-green). ` + `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('staff holds on the real ledger', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_staff_hold', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const bal = async (account: Parameters<PostgresLedger['balance']>[0]): Promise<string> =>
    formatAmount((await engine.balance(account)).amount);

  /** Each test funds its own customer with TEST 100.00 and confirms to its own slug, so it runs alone or in any order. */
  async function customer(userId: string) {
    await engine.post(recipes.deposit({ userId, assetId: 'USD', amount: amt('100'), rail: 'bank-sandbox', railRef: `dep-sh-${userId}` }));
    const slug = `held-funds-${userId.slice(0, 1)}`;
    return {
      available: () => bal(userAvailable(userId, 'USD')),
      held: (holdNo: number) => bal(staffHoldAccount(userId, 'USD', holdNo)),
      confirmed: () => bal(staffHoldConfirmAccount(slug, 'USD')),
      place: (holdNo: number, amount: string) => recipes.staffHoldPlace({ holdNo, userId, assetId: 'USD', amount: amt(amount) }),
      release: (holdNo: number, releaseNo: number, amount: string) =>
        recipes.staffHoldRelease({
          holdNo,
          releaseNo,
          cause: { kind: 'approval', approvalId: `appr-${holdNo}-${releaseNo}` },
          userId,
          assetId: 'USD',
          amount: amt(amount),
        }),
      confirm: (holdNo: number, attempt: number, amount: string) =>
        recipes.staffHoldConfirm({
          holdNo,
          attempt,
          approvalId: `appr-confirm-${holdNo}`,
          confirmAccount: slug,
          userId,
          assetId: 'USD',
          amount: amt(amount),
          heldRemaining: amt(amount),
        }),
    };
  }

  it('hold 40.00 of 100.00, release 15.00, confirm the remaining 25.00 once', async () => {
    const c = await customer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await engine.post(c.place(1, '40'));
    await engine.post(c.place(1, '40'));
    expect(await c.available()).toBe('60');
    expect(await c.held(1)).toBe('40');

    await engine.post(c.release(1, 1, '15'));
    await engine.post(c.release(1, 1, '15'));
    expect(await c.held(1)).toBe('25');
    expect(await c.available()).toBe('75');

    await engine.post(c.confirm(1, 1, '25'));
    await engine.post(c.confirm(1, 1, '25'));
    expect(await c.held(1)).toBe('0');
    expect(await c.confirmed()).toBe('25');
    expect(await c.available()).toBe('75');

    await expect(engine.post(c.release(1, 2, '0.01'))).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(engine.post(c.confirm(1, 2, '0.01'))).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('a release and a confirm racing for the same remainder: exactly one posts', async () => {
    const c = await customer('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await engine.post(c.place(2, '25'));
    expect(await c.available()).toBe('75');
    const outcomes = await Promise.allSettled([engine.post(c.release(2, 1, '25')), engine.post(c.confirm(2, 1, '25'))]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === 'rejected');
    expect(refused?.status === 'rejected' ? refused.reason : undefined).toBeInstanceOf(InsufficientFundsError);
    expect(await c.held(2)).toBe('0');
    const released = outcomes[0]!.status === 'fulfilled';
    expect(await c.available()).toBe(released ? '100' : '75');
    expect(await c.confirmed()).toBe(released ? '0' : '25');
  });

  it('one hold never draws on another', async () => {
    const c = await customer('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await engine.post(c.place(3, '10'));
    await engine.post(c.place(4, '5'));
    await expect(engine.post(c.release(3, 1, '15'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await c.held(3)).toBe('10');
    expect(await c.held(4)).toBe('5');
    expect(await c.available()).toBe('85');
  });
});
