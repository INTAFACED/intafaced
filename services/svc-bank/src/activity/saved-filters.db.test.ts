/**
 * BK-acct-07: saved activity filters, self-only.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { canonicalFilter } from './saved-filters.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';

function principal(userId: string, scopes: string[]): Principal {
  return { sub: userId, userId, sid: SID, scopes, tier: 'full', mfa: true, expiresAt: new Date(Date.now() + 60_000) } as Principal;
}

function caller(bank: BankServices, userId: string, scopes: string[]) {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

describe('saved activity filters (BK-acct-07)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let bank!: BankServices;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.activity_saved_filters`;
    const ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  });

  const rw = ['bank:read', 'bank:write'];
  const filter = { kind: ['deposit' as const], direction: 'in' as const, minAmount: '10' };

  it('saves, lists and removes a filter, and the list is self-only', async () => {
    const me = caller(bank, OWNER, rw);
    const saved = await me.activity.savedFilters.save({ name: 'TEST big deposits', filter });
    expect(saved).toMatchObject({ name: 'TEST big deposits', filter, replayed: false });
    expect(await me.activity.savedFilters.list({ limit: 10 })).toEqual([expect.objectContaining({ name: 'TEST big deposits', filter })]);
    expect(await caller(bank, OTHER, rw).activity.savedFilters.list({ limit: 10 })).toEqual([]);
    // Another customer may use the same name for their own filter.
    await caller(bank, OTHER, rw).activity.savedFilters.save({ name: 'TEST big deposits', filter: { direction: 'out' } });
    expect(await caller(bank, OTHER, rw).activity.savedFilters.remove({ name: 'TEST big deposits' })).toEqual({ deleted: true });
    expect(await me.activity.savedFilters.list({ limit: 10 })).toHaveLength(1);
    expect(await me.activity.savedFilters.remove({ name: 'TEST big deposits' })).toEqual({ deleted: true });
    expect(await me.activity.savedFilters.remove({ name: 'TEST big deposits' })).toEqual({ deleted: false });
  });

  it('the same name and filter replays; the same name with another filter conflicts', async () => {
    const me = caller(bank, OWNER, rw);
    await me.activity.savedFilters.save({ name: 'TEST mine', filter });
    const again = await me.activity.savedFilters.save({
      name: 'TEST mine',
      filter: { minAmount: '10', direction: 'in', kind: ['deposit'] },
    });
    expect(again.replayed).toBe(true);
    await expect(me.activity.savedFilters.save({ name: 'TEST mine', filter: { direction: 'out' } })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await sql`SELECT 1 FROM bank.activity_saved_filters`).toHaveLength(1);
  });

  it('refuses a blank name, an empty filter, an unknown filter key and a missing page size', async () => {
    const me = caller(bank, OWNER, rw);
    await expect(me.activity.savedFilters.save({ name: '   ', filter })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(me.activity.savedFilters.save({ name: 'TEST empty', filter: {} })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      me.activity.savedFilters.save({ name: 'TEST smuggle', filter: { ...filter, userId: OTHER } as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(me.activity.savedFilters.save({ name: 'x'.repeat(61), filter })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(me.activity.savedFilters.list({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await sql`SELECT 1 FROM bank.activity_saved_filters`).toHaveLength(0);
  });

  it('a read-only principal cannot save or remove', async () => {
    const ro = caller(bank, OWNER, ['bank:read']);
    await expect(ro.activity.savedFilters.save({ name: 'TEST ro', filter })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(ro.activity.savedFilters.remove({ name: 'TEST ro' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('canonical form ignores key order, array order and absent keys', () => {
    expect(canonicalFilter({ b: 1, a: ['y', 'x'], c: undefined })).toBe(canonicalFilter({ a: ['x', 'y'], b: 1 }));
  });
});
