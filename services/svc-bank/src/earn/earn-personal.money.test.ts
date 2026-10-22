/**
 * BK-earn-01 — personal earn: partial withdraw (deallocating), derived waiting_accrual, per-pool availability,
 * settings and the auto program. Postgres-hard: no skip; a missing TEST_DATABASE_URL fails the suite.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { LedgerError, MemoryLedger, earnStakeAccount, parseAmount as amount, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { accruesFrom, earnWithdrawKey, evaluateAvailability, positionState, type EarnPersonal } from './earn-personal.js';

const SECRET = 'bank-earn-personal-boundary-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

describe('earn-personal (pure)', () => {
  it('position is waiting_accrual until the next UTC day', () => {
    const openedAt = new Date('2026-10-22T03:00:00Z');
    expect(positionState({ status: 'active', openedAt }, new Date('2026-10-22T23:59:59Z'))).toBe('waiting_accrual');
    expect(positionState({ status: 'active', openedAt }, new Date('2026-10-23T00:00:00Z'))).toBe('active');
    expect(positionState({ status: 'deallocating', openedAt }, new Date('2026-10-22T05:00:00Z'))).toBe('deallocating');
    expect(accruesFrom(openedAt).toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });

  it('availability: no rule follows the module gate; unknown country fails closed; tier is ordered', () => {
    const open = { status: 'open' as const };
    expect(evaluateAvailability(open, null, { country: null, tier: 'none' })).toEqual({ offered: true });
    expect(evaluateAvailability(open, { allowedCountries: ['DE'], minVerificationTier: null }, { country: null, tier: 'full' })).toEqual({
      offered: false,
      reason: 'country',
    });
    expect(evaluateAvailability(open, { allowedCountries: ['DE'], minVerificationTier: null }, { country: 'de', tier: 'none' })).toEqual({
      offered: true,
    });
    expect(evaluateAvailability(open, { allowedCountries: null, minVerificationTier: 2 }, { country: null, tier: 'basic' })).toEqual({
      offered: false,
      reason: 'verification_tier',
    });
    expect(evaluateAvailability({ status: 'closed' }, null, { country: null, tier: 'full' })).toEqual({
      offered: false,
      reason: 'pool_closed',
    });
  });

  it('suite is not skip-green', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(new RegExp('describe\\.skip' + 'If|\\bit\\.skip\\(|describe\\.skip\\('));
  });
});

describe('earn-personal (Postgres)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: ReturnType<typeof createBankServices>;
  let personal: EarnPersonal;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('earn-personal is Postgres-hard: TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE bank.earn_withdrawals, bank.earn_auto_programs, bank.earn_settings_commands, bank.earn_pool_availability,
      bank.interest_accruals, bank.earn_positions, bank.earn_pools RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    personal = bank.earnPersonal!;
  });

  function caller(userId: string, tier: Principal['tier'] = 'full') {
    const actor = {
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes: ['bank:read', 'bank:write'],
      tier,
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(actor);
    return createBankRouter(bank).createCaller({
      ...edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
      service: null,
    });
  }

  async function fund(userId: string, value: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId: 'USDT', amount: amount(value), rail: 'test', railRef: `${userId}:${randomUUID()}` }),
    );
  }

  async function openPosition(value = '10') {
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flex', aprBps: 400, minDeposit: amount('1') });
    await fund(USER, '100');
    const positionId = randomUUID();
    await bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amount(value), positionId });
    return { pool, positionId };
  }

  const available = async (u: string) => (await ledger.balance(userAvailable(u, 'USDT'))).amount;

  it('deposit below minimum -> bank.below_minimum', async () => {
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flex', aprBps: 400, minDeposit: amount('5') });
    await fund(USER, '100');
    await expect(
      personal.deposit({ country: null, tier: 'full' }, { poolId: pool.id, userId: USER, amount: amount('1'), positionId: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'bank.below_minimum',
    });
  });

  it('partial withdraw 4 of 10 leaves 6 and posts one earnWithdraw', async () => {
    const { positionId } = await openPosition('10');
    const before = await available(USER);
    const r = await personal.withdraw({ positionId, userId: USER, amount: amount('4'), clientEventId: 'evt-00001' });
    expect(r).toMatchObject({ withdrawn: amount('4'), remaining: amount('6'), state: 'active' });
    expect((await available(USER)) - before).toBe(amount('4'));
    expect((await ledger.balance(earnStakeAccount(USER, 'USDT', positionId))).amount).toBe(amount('6'));
    expect(await bank.earn.principalOf(USER, 'USDT')).toBe(amount('6'));
    const pos = await bank.earn.position(positionId);
    // The column stays the deposit record (§0.6); the open principal is derived.
    expect(pos).toMatchObject({ status: 'active', principal: amount('10') });
    expect(await personal.openPrincipal(positionId)).toBe(amount('6'));
    await expect(bank.earn.poolSize(pos.poolId)).resolves.toBe(amount('6'));
    const rows = await sql<Array<{ status: string; ledger_tx_id: string | null }>>`SELECT status, ledger_tx_id FROM bank.earn_withdrawals`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('posted');
  });

  it('partial withdraw retry same key posts once; same key with another amount conflicts', async () => {
    const { positionId } = await openPosition('10');
    const before = await available(USER);
    const a = await personal.withdraw({ positionId, userId: USER, amount: amount('4'), clientEventId: 'evt-00001' });
    const b = await personal.withdraw({ positionId, userId: USER, amount: amount('4'), clientEventId: 'evt-00001' });
    expect(b).toEqual(a);
    expect((await available(USER)) - before).toBe(amount('4'));
    await expect(personal.withdraw({ positionId, userId: USER, amount: amount('3'), clientEventId: 'evt-00001' })).rejects.toMatchObject({
      code: 'bank.position_conflict',
    });
    const c = await personal.withdraw({ positionId, userId: USER, amount: amount('6'), clientEventId: 'evt-00002' });
    expect(c).toMatchObject({ remaining: 0n, state: 'closed' });
    expect((await bank.earn.position(positionId)).status).toBe('closed');
  });

  it('more than the principal refuses and nothing moves', async () => {
    const { positionId } = await openPosition('10');
    await expect(personal.withdraw({ positionId, userId: USER, amount: amount('11'), clientEventId: 'evt-00003' })).rejects.toMatchObject({
      code: 'bank.earn_withdraw_exceeds_principal',
    });
    expect((await bank.earn.position(positionId)).status).toBe('active');
  });

  it('lost reply: claim stays deallocating, another key and the whole withdraw refuse, the same key finishes once', async () => {
    const { positionId } = await openPosition('10');
    const realPost = ledger.post.bind(ledger);
    let drop = true;
    ledger.post = (async (req: Parameters<MemoryLedger['post']>[0]) => {
      const tx = await realPost(req);
      if (drop && req.idempotencyKey === earnWithdrawKey(positionId, 'evt-lost-01')) {
        drop = false;
        throw new Error('socket hang up');
      }
      return tx;
    }) as MemoryLedger['post'];
    const before = await available(USER);
    await expect(personal.withdraw({ positionId, userId: USER, amount: amount('4'), clientEventId: 'evt-lost-01' })).rejects.toThrow(
      'socket hang up',
    );
    expect((await bank.earn.position(positionId)).status).toBe('deallocating');
    await expect(personal.withdraw({ positionId, userId: USER, amount: amount('1'), clientEventId: 'evt-other-1' })).rejects.toMatchObject({
      code: 'bank.position_deallocating',
    });
    await expect(bank.earn.withdraw(positionId)).rejects.toMatchObject({ code: 'bank.position_deallocating' });
    const resumed = await personal.resumeDeallocating(10);
    expect(resumed).toEqual([{ positionId, outcome: 'completed' }]);
    expect((await available(USER)) - before).toBe(amount('4'));
    expect((await bank.earn.position(positionId)).status).toBe('active');
    expect(await personal.openPrincipal(positionId)).toBe(amount('6'));
    // The whole-position path after a partial returns only the open 6.
    const closed = await bank.earn.withdraw(positionId);
    expect(closed.principal).toBe(amount('6'));
    expect((await available(USER)) - before).toBe(amount('10'));
  });

  it('definite ledger refusal releases the claim and the position stays active', async () => {
    const { positionId } = await openPosition('10');
    ledger.post = (async () => {
      throw new LedgerError('refused', 'ledger.insufficient_funds');
    }) as unknown as MemoryLedger['post'];
    await expect(personal.withdraw({ positionId, userId: USER, amount: amount('4'), clientEventId: 'evt-00004' })).rejects.toBeInstanceOf(
      LedgerError,
    );
    expect((await bank.earn.position(positionId)).status).toBe('active');
    expect(await sql`SELECT 1 FROM bank.earn_withdrawals`).toHaveLength(0);
  });

  it('another user cannot withdraw from the position', async () => {
    const { positionId } = await openPosition('10');
    await expect(caller(OTHER).earn.withdraw({ positionId, amount: '1', clientEventId: 'evt-00005' })).rejects.toThrow();
    expect(await personal.openPrincipal(positionId)).toBe(amount('10'));
  });

  it('router: partial withdraw through earn.withdraw with amount', async () => {
    const { positionId } = await openPosition('10');
    const out = await caller(USER).earn.withdraw({ positionId, amount: '2.5', clientEventId: 'evt-00006' });
    expect(out).toMatchObject({ positionId, withdrawn: '2.5', remaining: '7.5', state: 'active' });
  });

  it('pool not offered in region is hidden and deposit refused', async () => {
    const shown = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Open', aprBps: 300, minDeposit: amount('1') });
    const hidden = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'FR only', aprBps: 500, minDeposit: amount('1') });
    await personal.setAvailabilityRule(hidden.id, { allowedCountries: ['FR'], minVerificationTier: null });
    const de = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'DE ok', aprBps: 200, minDeposit: amount('1') });
    await personal.setAvailabilityRule(de.id, { allowedCountries: ['DE'], minVerificationTier: null });
    await fund(USER, '100');
    const user = caller(USER);
    const pools = await user.earn.offeredPools({ limit: 50 });
    expect(pools.map((p) => p.id)).toEqual([shown.id, de.id]);
    expect(await user.earn.poolAvailability({ poolId: hidden.id })).toEqual({ offered: false, reason: 'country' });
    await expect(user.earn.depositOffered({ poolId: hidden.id, amount: '5', positionId: randomUUID() })).rejects.toThrow(/not offered/);
    expect(await bank.earn.principalOf(USER, 'USDT')).toBe(0n);
    const ok = await user.earn.depositOffered({ poolId: shown.id, amount: '5', positionId: randomUUID() });
    expect(ok.positionId).toBeTruthy();
    expect(await user.earn.offeredPools({ limit: 50, kind: 'fixed' })).toEqual([]);
  });

  it('verification tier rule hides a pool from a lower tier', async () => {
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Full only', aprBps: 500, minDeposit: amount('1') });
    await personal.setAvailabilityRule(pool.id, { allowedCountries: null, minVerificationTier: 3 });
    expect(await caller(USER, 'full').earn.poolAvailability({ poolId: pool.id })).toEqual({ offered: false, reason: 'verification_tier' });
    expect(await caller(USER, 'institutional').earn.poolAvailability({ poolId: pool.id })).toEqual({ offered: true });
  });

  it('closed pool: deposit refused, withdraw works', async () => {
    const { pool, positionId } = await openPosition('10');
    await sql`UPDATE bank.earn_pools SET status = 'closed' WHERE id = ${pool.id}`;
    await expect(
      personal.deposit({ country: null, tier: 'full' }, { poolId: pool.id, userId: USER, amount: amount('5'), positionId: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'bank.pool_closed',
    });
    const r = await personal.withdraw({ positionId, userId: USER, amount: amount('10'), clientEventId: 'evt-00007' });
    expect(r.state).toBe('closed');
  });

  it('auto program with blank cap -> bank.autoearn_cap_unset; settings round-trip and replay', async () => {
    const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flex', aprBps: 400, minDeposit: amount('1') });
    const viewer = { country: null, tier: 'full' as const };
    await expect(
      personal.setSettings(viewer, {
        userId: USER,
        commandId: 'cmd-00001',
        autoPrograms: [{ assetId: 'USDT', poolId: pool.id, enabled: true, cap: null }],
      }),
    ).rejects.toMatchObject({ code: 'bank.autoearn_cap_unset' });
    expect(await sql`SELECT 1 FROM bank.earn_auto_programs`).toHaveLength(0);

    const user = caller(USER);
    const set = await user.earn.settingsSet({
      commandId: 'cmd-00002',
      settings: { autoPrograms: [{ assetId: 'USDT', poolId: pool.id, enabled: true, cap: '50' }] },
    });
    expect(set).toEqual({ autoPrograms: [{ assetId: 'USDT', poolId: pool.id, enabled: true, cap: '50' }] });
    expect(await user.earn.settingsGet()).toEqual(set);
    await expect(
      user.earn.settingsSet({
        commandId: 'cmd-00002',
        settings: { autoPrograms: [{ assetId: 'USDT', poolId: pool.id, enabled: false, cap: null }] },
      }),
    ).rejects.toThrow();
    expect(await user.earn.settingsGet()).toEqual(set);

    await fund(USER, '100');
    await bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amount('30'), positionId: randomUUID() });
    expect(await personal.autoSweepAmount(USER, 'USDT', amount('70'))).toBe(amount('20'));
    expect(await personal.autoSweepAmount(USER, 'USDT', amount('5'))).toBe(amount('5'));
    expect(await personal.autoSweepAmount(OTHER, 'USDT', amount('70'))).toBe(0n);
  });
});
