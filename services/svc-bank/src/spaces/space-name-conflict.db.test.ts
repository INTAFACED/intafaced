/**
 * Regression: creating a named space with a name the caller already uses in that asset was a raw 23505
 * (spaces_user_asset_name_idx) surfacing as a 500 "Bank operation failed". It is now `bank.space_name_taken` (409).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { SpaceService } from './space-service.js';
import { BankError } from '../errors.js';
import { toTrpcError } from '../router/errors.js';

const ALICE = '55555555-5555-4555-8555-555555555555';
const BOB = '66666666-6666-4666-8666-666666666666';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('bank.spaces.create name conflict (Postgres)', () => {
  let db: TestDatabase;
  let spaces: SpaceService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: DB_URL, migrations });
    spaces = new SpaceService(db.sql, new MemoryLedger());
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('a second space with the same name in the same asset refuses bank.space_name_taken (409), one row stored', async () => {
    await spaces.create({ userId: ALICE, assetId: 'USDT', name: 'Holiday' });
    const err = await spaces.create({ userId: ALICE, assetId: 'USDT', name: 'Holiday' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankError);
    expect(err).toMatchObject({ code: 'bank.space_name_taken' });
    expect(toTrpcError(err).code).toBe('CONFLICT');
    const rows = await db.sql`SELECT 1 FROM bank.spaces WHERE user_id = ${ALICE} AND asset_id = 'USDT' AND name = 'Holiday'`;
    expect(rows).toHaveLength(1);
  });

  it('an archived space still holds its name: the refusal is the same typed conflict', async () => {
    const old = await spaces.create({ userId: ALICE, assetId: 'USDT', name: 'Car' });
    await db.sql`UPDATE bank.spaces SET archived_at = now() WHERE id = ${old.id}`;
    const err = await spaces.create({ userId: ALICE, assetId: 'USDT', name: 'Car' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'bank.space_name_taken' });
  });

  it('the same name in another asset or for another user is allowed', async () => {
    await expect(spaces.create({ userId: ALICE, assetId: 'BTC', name: 'Holiday' })).resolves.toMatchObject({ name: 'Holiday' });
    await expect(spaces.create({ userId: BOB, assetId: 'USDT', name: 'Holiday' })).resolves.toMatchObject({ name: 'Holiday' });
  });
});

describe('bank.spaces.create rethrows any other insert error unchanged (stub sql)', () => {
  function rejectingSql(err: unknown): ConstructorParameters<typeof SpaceService>[0] {
    const fn = () => Promise.reject(err);
    return fn as unknown as ConstructorParameters<typeof SpaceService>[0];
  }

  it('a 23505 on another constraint is rethrown as the same object, not bank.space_name_taken', async () => {
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'other_idx' });
    const spaces = new SpaceService(rejectingSql(pgErr), new MemoryLedger());
    const err = await spaces.create({ userId: ALICE, assetId: 'USDT', name: 'Holiday' }).catch((e: unknown) => e);
    expect(err).toBe(pgErr);
  });

  it('a different error code (23503) is rethrown as the same object', async () => {
    const pgErr = Object.assign(new Error('fk violation'), { code: '23503', constraint_name: 'spaces_user_asset_name_idx' });
    const spaces = new SpaceService(rejectingSql(pgErr), new MemoryLedger());
    const err = await spaces.create({ userId: ALICE, assetId: 'USDT', name: 'Holiday' }).catch((e: unknown) => e);
    expect(err).toBe(pgErr);
  });
});
