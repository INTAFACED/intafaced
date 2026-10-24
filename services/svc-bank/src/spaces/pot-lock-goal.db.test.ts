/**
 * BK-pots-02 (J-bank-07 #1 and #2): a pot's goal and lock, changed by its owner. A goal is set, changed and cleared and
 * never moves value; a lock only gets longer; an early unlock waits out the owner's window (blank refuses and writes
 * nothing) and debits refuse `bank.space_locked` until it opens. Enters through the router. Uses TEST_DATABASE_URL.
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
import { lockEnd, requireUnlockWaitHours } from './space-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'p'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';
const HOUR = 3_600_000;

function caller(bank: BankServices, userId: string) {
  const principal = { sub: userId, userId, sid: SID, scopes: ['bank:read', 'bank:write'], tier: 'full', mfa: true } as unknown as Principal;
  const raw = encodePrincipal({ ...principal, expiresAt: new Date(Date.now() + 60_000) } as Principal);
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

describe('pot goal and lock (BK-pots-02)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let wait: string | undefined;
  let bank: BankServices;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE bank.spaces RESTART IDENTITY CASCADE`;
    wait = '24';
    const ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      spaceLimit: '5',
      get spaceUnlockWaitHours() {
        return wait;
      },
    });
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const pot = async (lockedUntil?: Date) =>
    bank.spaces.create({ userId: ADA, assetId: 'USDT', name: 'TEST holiday', lockedUntil: lockedUntil ?? null });
  const row = async (id: string) => (await caller(bank, ADA).spaces.list({ assetId: 'USDT', limit: 50 })).find((space) => space.id === id)!;

  it('sets, changes and clears a goal, and refuses a goal of zero, the primary space and another owner', async () => {
    const holiday = await pot();
    const ada = caller(bank, ADA);
    await expect(ada.spaces.setGoal({ spaceId: holiday.id, goalTarget: '50' })).resolves.toMatchObject({ goalTarget: '50' });
    await expect(ada.spaces.setGoal({ spaceId: holiday.id, goalTarget: '15.5' })).resolves.toMatchObject({ goalTarget: '15.5' });
    expect((await row(holiday.id)).goalTarget).toBe('15.5');
    await expect(ada.spaces.setGoal({ spaceId: holiday.id, goalTarget: null })).resolves.toMatchObject({ goalTarget: null });
    expect((await row(holiday.id)).goalTarget).toBeNull();

    await expect(ada.spaces.setGoal({ spaceId: holiday.id, goalTarget: '0' })).rejects.toMatchObject({
      cause: { code: 'bank.space_change_invalid' },
    });
    const main = await bank.spaces.ensurePrimary(ADA, 'USDT');
    await expect(ada.spaces.setGoal({ spaceId: main.id, goalTarget: '5' })).rejects.toMatchObject({
      cause: { code: 'bank.space_change_invalid' },
    });
    await expect(caller(bank, BO).spaces.setGoal({ spaceId: holiday.id, goalTarget: '5' })).rejects.toMatchObject({
      cause: { code: 'bank.space_not_found' },
    });
    expect((await row(holiday.id)).goalTarget).toBeNull();
  });

  it('locks a pot, keeps it locked longer, and refuses a shorter lock or a past date', async () => {
    const holiday = await pot();
    const ada = caller(bank, ADA);
    const in10 = new Date(Date.now() + 10 * 24 * HOUR);
    const in20 = new Date(Date.now() + 20 * 24 * HOUR);
    await expect(ada.spaces.setLock({ spaceId: holiday.id, lockedUntil: in10.toISOString() })).resolves.toMatchObject({
      lockedUntil: in10.toISOString(),
      unlocksAt: null,
    });
    await expect(bank.spaces.resolveForDebit(holiday.id, new Date())).rejects.toMatchObject({ code: 'bank.space_locked' });

    await expect(ada.spaces.setLock({ spaceId: holiday.id, lockedUntil: in20.toISOString() })).resolves.toMatchObject({
      lockedUntil: in20.toISOString(),
    });
    await expect(ada.spaces.setLock({ spaceId: holiday.id, lockedUntil: in10.toISOString() })).rejects.toMatchObject({
      cause: { code: 'bank.space_change_invalid' },
    });
    await expect(ada.spaces.setLock({ spaceId: holiday.id, lockedUntil: new Date(Date.now() - HOUR).toISOString() })).rejects.toMatchObject(
      { cause: { code: 'bank.space_change_invalid' } },
    );
    expect((await row(holiday.id)).lockedUntil).toBe(in20.toISOString());
  });

  it('opens a locked pot early only after the owner’s wait, and asking again keeps the first opening time', async () => {
    const until = new Date(Date.now() + 30 * 24 * HOUR);
    const holiday = await pot(until);
    const ada = caller(bank, ADA);
    const before = Date.now();
    const asked = await ada.spaces.requestUnlock({ spaceId: holiday.id });
    const opens = Date.parse(asked.unlocksAt!);
    expect(opens).toBeGreaterThanOrEqual(before + 24 * HOUR);
    expect(opens).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
    expect(asked.lockedUntil).toBe(until.toISOString());
    expect(asked.unlockRequestedAt).not.toBeNull();

    // Still locked during the wait: the debit refuses and names when it opens.
    await expect(bank.spaces.resolveForDebit(holiday.id, new Date())).rejects.toMatchObject({
      code: 'bank.space_locked',
      message: expect.stringContaining(asked.unlocksAt!),
    });
    await expect(ada.spaces.requestUnlock({ spaceId: holiday.id })).resolves.toEqual(asked);
    expect(await row(holiday.id)).toMatchObject({ unlocksAt: asked.unlocksAt, lockedUntil: until.toISOString() });

    // After the wait the pot is open: the debit resolves and the list shows no lock.
    const after = new Date(opens + 1);
    await expect(bank.spaces.resolveForDebit(holiday.id, after)).resolves.toMatchObject({ id: holiday.id });
    const [stored] = await sql<{ locked_until: Date; unlocks_at: Date }[]>`
      SELECT locked_until, unlocks_at FROM bank.spaces WHERE id = ${holiday.id}`;
    expect(lockEnd({ lockedUntil: stored!.locked_until, unlocksAt: stored!.unlocks_at }, after)).toBeNull();
  });

  it('never opens later than the lock date, and a wait of 0 opens at once', async () => {
    const soon = new Date(Date.now() + 2 * HOUR);
    const holiday = await pot(soon);
    const ada = caller(bank, ADA);
    await expect(ada.spaces.requestUnlock({ spaceId: holiday.id })).resolves.toMatchObject({ unlocksAt: soon.toISOString() });

    const other = await bank.spaces.create({
      userId: ADA,
      assetId: 'USDT',
      name: 'TEST other',
      lockedUntil: new Date(Date.now() + 24 * HOUR),
    });
    wait = '0';
    await expect(ada.spaces.requestUnlock({ spaceId: other.id })).resolves.toMatchObject({ lockedUntil: null, unlocksAt: null });
    await expect(bank.spaces.resolveForDebit(other.id, new Date(Date.now() + 1))).resolves.toMatchObject({ id: other.id });
  });

  it('refuses an early unlock with no owner wait and writes nothing, and refuses one on an unlocked pot', async () => {
    const until = new Date(Date.now() + 5 * 24 * HOUR);
    const holiday = await pot(until);
    const ada = caller(bank, ADA);
    for (const blank of [undefined, '', ' ', 'soon', '-1', '8761']) {
      wait = blank;
      await expect(ada.spaces.requestUnlock({ spaceId: holiday.id })).rejects.toMatchObject({
        cause: { code: 'bank.space_unlock_rule_unset' },
      });
    }
    expect(await row(holiday.id)).toMatchObject({ lockedUntil: until.toISOString(), unlocksAt: null, unlockRequestedAt: null });

    const open = await bank.spaces.create({ userId: ADA, assetId: 'USDT', name: 'TEST open' });
    wait = '24';
    await expect(ada.spaces.requestUnlock({ spaceId: open.id })).rejects.toMatchObject({ cause: { code: 'bank.space_not_locked' } });
    await expect(caller(bank, BO).spaces.requestUnlock({ spaceId: holiday.id })).rejects.toMatchObject({
      cause: { code: 'bank.space_not_found' },
    });
  });

  it('withdraws a waiting early unlock, and a new lock date replaces one', async () => {
    const until = new Date(Date.now() + 5 * 24 * HOUR);
    const holiday = await pot(until);
    const ada = caller(bank, ADA);
    await ada.spaces.requestUnlock({ spaceId: holiday.id });
    await expect(ada.spaces.cancelUnlock({ spaceId: holiday.id })).resolves.toMatchObject({
      lockedUntil: until.toISOString(),
      unlocksAt: null,
    });
    await expect(ada.spaces.cancelUnlock({ spaceId: holiday.id })).resolves.toMatchObject({ unlocksAt: null });

    await ada.spaces.requestUnlock({ spaceId: holiday.id });
    const later = new Date(until.getTime() + 24 * HOUR);
    await expect(ada.spaces.setLock({ spaceId: holiday.id, lockedUntil: later.toISOString() })).resolves.toMatchObject({
      lockedUntil: later.toISOString(),
      unlocksAt: null,
      unlockRequestedAt: null,
    });
  });

  it('keeps the early-unlock columns consistent in the table', async () => {
    const holiday = await pot(new Date(Date.now() + 24 * HOUR));
    await expect(sql`UPDATE bank.spaces SET unlocks_at = now() WHERE id = ${holiday.id}`).rejects.toThrow(/spaces_early_unlock_ck/);
    await expect(
      sql`UPDATE bank.spaces SET unlock_requested_at = now(), unlocks_at = locked_until + interval '1 hour' WHERE id = ${holiday.id}`,
    ).rejects.toThrow(/spaces_early_unlock_ck/);
  });

  it('reads the owner wait as whole hours from 0 to 8760 and nothing else', () => {
    expect(requireUnlockWaitHours('0')).toBe(0);
    expect(requireUnlockWaitHours(' 72 ')).toBe(72);
    expect(requireUnlockWaitHours('8760')).toBe(8760);
    for (const bad of [undefined, '', '1.5', '1e3', '8761', '-2']) {
      expect(() => requireUnlockWaitHours(bad)).toThrow(expect.objectContaining({ code: 'bank.space_unlock_rule_unset' }));
    }
  });
});
