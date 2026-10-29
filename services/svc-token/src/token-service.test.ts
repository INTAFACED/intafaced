import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { trace } from '@opentelemetry/api';
import { MemoryEventBus } from '@intafaced/events';
import {
  MemoryLedger,
  InsufficientFundsError,
  LedgerError,
  formatAmount,
  parseAmount as amt,
  recipes,
  burnAccount,
  houseFees,
  rewardsEngine,
  userAvailable,
  type PostRequest,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { createLedgerClient } from './ledger-client.js';
import { TokenService, TokenError, foldTally, assertProposalListLimit, assertStakesListLimit } from './token-service.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { TEST_VOTE_SIGNATURE, testVoteSignatures } from './vote-signature.testkit.js';

/**
 * svc-token money paths.
 *
 * The ledger here is `MemoryLedger` — the reference implementation, which the
 * conformance suite proves behaves identically to svc-ledger's Postgres engine
 * (§4.4). That equivalence is what makes it legitimate to use here: these tests
 * are about svc-token's recipes and ordering, not about the ledger.
 *
 * Postgres is real, because the stake row / ledger interaction is exactly where
 * a bug would hide.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
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
      `H8a: svc-token money is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-token money (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('compares balances as scaled bigint — never parseFloat / Number()', () => {
    const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const prodSrc = readFileSync(join(here, 'token-service.ts'), 'utf8');
    expect(testSrc).not.toMatch(/\bparseFloat\s*\(/);
    expect(prodSrc).not.toMatch(/\bparseFloat\s*\(/);
    expect(prodSrc).not.toMatch(/function parseDecimal/);
    expect(prodSrc).not.toMatch(/const n = Number\(/);

    const pastSafe = '9007199254740993';
    const justSafe = '9007199254740992';
    expect(amt(pastSafe) > amt(justSafe)).toBe(true);
    expect(Number(pastSafe)).toBe(Number(justSafe));
  });
});

describe('svc-token money PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let token: TokenService;

  const options = {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
    feeScheduleTtlMs: 0,
    // Gate OFF for the shared fixture: most emission tests walk several epochs in
    // a row. The `emission time gate` block below turns it on with a real 1-day length.
    emissionEpochMs: 0,
    // Test fixture only — production env has no default bar.
    governanceQuorumBps: 1000,
    governanceThresholdBps: 5000,
    // Test fixture only — production env has no default vote rule.
    voteRule: 'power:0',
    voteSignatures: testVoteSignatures(),
  };

  /** Put real IFC in a user's available balance so a stake has something behind it. */
  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId: 'IFC', amount: amt(amount), rail: 'test', railRef: `${userId}:${amount}:${Math.random()}` }),
    );
  }

  /** Accrue fees into a module's house account, the way a real fee charge would. */
  async function accrueFees(module: string, amount: string) {
    const payer = '99999999-9999-4999-8999-999999999999';
    await fund(payer, amount);
    await ledger.post(
      recipes.feeCharge({
        chargeId: `${module}:${Math.random()}`,
        userId: payer,
        module,
        mode: 'asset',
        assetId: 'IFC',
        amount: amt(amount),
      }),
    );
  }

  const balanceOf = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'IFC'))).amount);
  const stakedOf = async (userId: string) => {
    const all = await ledger.balances('user', userId);
    const total = all.filter((b) => b.account.kind === 'stake' && b.account.assetId === 'IFC').reduce((acc, b) => acc + b.amount, 0n);
    return formatAmount(total);
  };
  const engineIfC = async () => (await ledger.balance(rewardsEngine('IFC'))).amount;
  const burnIfC = async () => (await ledger.balance(burnAccount('IFC'))).amount;

  /** A test-written ladder. The migration leaves the column null. */
  async function publishFeeSchedule(schedule: unknown = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] }) {
    await sql`
      UPDATE token.token_params
         SET fee_discount_schedule = ${sql.json(schedule as never)}
       WHERE id = true
    `;
  }

  async function restoreFeeSchedule(schedule: unknown) {
    if (schedule == null) {
      await sql`UPDATE token.token_params SET fee_discount_schedule = NULL WHERE id = true`;
      return;
    }
    await sql`UPDATE token.token_params SET fee_discount_schedule = ${sql.json(schedule as never)} WHERE id = true`;
  }

  async function seedBuybackRun(input: {
    runId: string;
    window: { from: Date; to: Date };
    tokensBought?: string;
    toBurn?: string;
    toRewards?: string;
    status?: 'pending' | 'settled';
    /** Age of the claim row (`created_at`). Default 1 hour. Not the quiet-period clock. */
    ageSeconds?: number;
    /** Age of the last burn/post attempt (`last_post_at`). Defaults to ageSeconds. */
    lastPostAgeSeconds?: number;
  }) {
    const tokensBought = input.tokensBought ?? '1000';
    const toBurn = input.toBurn ?? '600';
    const toRewards = input.toRewards ?? '400';
    const ageSeconds = input.ageSeconds ?? 3600;
    const lastPostAgeSeconds = input.lastPostAgeSeconds ?? ageSeconds;
    await sql`
      INSERT INTO token.buyback_runs (
        id, revenue_window_from, revenue_window_to, revenue_total,
        tokens_bought, tokens_burned, tokens_to_rewards, status, executed_at, created_at, last_post_at
      ) VALUES (
        ${input.runId}, ${input.window.from}, ${input.window.to}, ${sql.json({ IFC: '1000' } as never)},
        ${tokensBought}::numeric, ${toBurn}::numeric, ${toRewards}::numeric,
        ${input.status ?? 'settled'}, now(),
        now() - make_interval(secs => ${ageSeconds}),
        now() - make_interval(secs => ${lastPostAgeSeconds})
      )
    `;
  }

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'token', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE token.governance_votes, token.proposals, token.stakes, token.buyback_runs, token.emission_epochs, token.yield_payouts, token.yield_windows RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-token');
    token = new TokenService(sql, ledger, bus, options);
  });

  it('0009 preserves existing token parameters while relaxing old column constraints', async () => {
    const rollback = new Error('rollback migration fixture');
    let observed: Array<{ column_name: string; is_nullable: string; column_default: string | null }> = [];
    let saved:
      | { total_supply: string; buyback_bps: string; burn_split_bps: string; emission_curve: unknown; fee_discount_schedule: unknown }
      | undefined;

    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE token.token_params
             SET total_supply = '987654321.125'::numeric,
                 emission_curve = ${tx.json({ initialEpochReward: '321.5' } as never)},
                 halving_interval = 77,
                 fee_discount_schedule = ${tx.json({ basis: 'staked', tiers: [] } as never)},
                 buyback_bps = 123,
                 burn_split_bps = 456
           WHERE id = true
        `;
        await tx`ALTER TABLE token.token_params ALTER COLUMN total_supply SET NOT NULL`;
        await tx`ALTER TABLE token.token_params ALTER COLUMN emission_curve SET NOT NULL`;
        await tx`ALTER TABLE token.token_params ALTER COLUMN emission_curve SET DEFAULT '{}'::jsonb`;
        await tx`ALTER TABLE token.token_params ALTER COLUMN halving_interval SET NOT NULL`;
        await tx`ALTER TABLE token.token_params ALTER COLUMN fee_discount_schedule SET NOT NULL`;
        await tx`ALTER TABLE token.token_params ALTER COLUMN fee_discount_schedule SET DEFAULT '{}'::jsonb`;
        await tx`ALTER TABLE token.token_params ALTER COLUMN buyback_bps SET NOT NULL`;
        await tx`ALTER TABLE token.token_params ALTER COLUMN burn_split_bps SET NOT NULL`;

        await tx.unsafe(readFileSync(join(drizzle, '0009_token_params_blank_preserving.sql'), 'utf8'));
        const rows = await tx<
          Array<{
            total_supply: string;
            buyback_bps: string;
            burn_split_bps: string;
            emission_curve: unknown;
            fee_discount_schedule: unknown;
          }>
        >`
          SELECT total_supply::text, buyback_bps::text, burn_split_bps::text, emission_curve, fee_discount_schedule
            FROM token.token_params WHERE id = true
        `;
        saved = rows[0];
        observed = await tx<Array<{ column_name: string; is_nullable: string; column_default: string | null }>>`
          SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
           WHERE table_schema = 'token' AND table_name = 'token_params'
             AND column_name IN ('total_supply', 'emission_curve', 'halving_interval', 'fee_discount_schedule', 'buyback_bps', 'burn_split_bps')
           ORDER BY column_name
        `;
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(saved).toEqual({
      total_supply: '987654321.125000000000000000',
      buyback_bps: '123',
      burn_split_bps: '456',
      emission_curve: { initialEpochReward: '321.5' },
      fee_discount_schedule: { basis: 'staked', tiers: [] },
    });
    expect(observed).toHaveLength(6);
    expect(observed.every((row) => row.is_nullable === 'YES')).toBe(true);
    expect(observed.find((row) => row.column_name === 'emission_curve')?.column_default).toBeNull();
    expect(observed.find((row) => row.column_name === 'fee_discount_schedule')?.column_default).toBeNull();
  });

  // ── Staking ───────────────────────────────────────────────────────────────

  describe('staking', () => {
    it('moves value into the ledger stake account and records the stake', async () => {
      await fund(USER_A, '10000');
      const stake = await token.stake({
        userId: USER_A,
        amount: amt('4000'),
        tier: 'm12',
        stakeId: crypto.randomUUID(),
      });

      expect(await balanceOf(USER_A)).toBe('6000');
      expect(await stakedOf(USER_A)).toBe('4000');

      const rows = await sql<Array<{ id: string; status: string; tier: string }>>`SELECT id, status, tier FROM token.stakes`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: stake.id, status: 'active', tier: 'm12' });
    });

    it('omit/blank stakeId refuses token.stake_id_required and posts nothing', async () => {
      await fund(USER_A, '1000');
      await expect(token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: '' })).rejects.toMatchObject({
        code: 'token.stake_id_required',
      });
      await expect(token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex' } as never)).rejects.toMatchObject({
        code: 'token.stake_id_required',
      });
      const rows = await sql`SELECT id FROM token.stakes`;
      expect(rows).toHaveLength(0);
      expect(await stakedOf(USER_A)).toBe('0');
      expect(await balanceOf(USER_A)).toBe('1000');
    });

    it('refuses to stake more than the user holds', async () => {
      await fund(USER_A, '100');
      await expect(token.stake({ userId: USER_A, amount: amt('101'), tier: 'flex', stakeId: crypto.randomUUID() })).rejects.toThrow();

      // L3-2: pending claim is deleted when ledger refuses — no stake row left
      // (and never an active unfunded stake).
      const rows = await sql`SELECT id FROM token.stakes`;
      expect(rows).toHaveLength(0);
    });

    it('L3-2 activates a pending claim after ledger funds it (retry-safe)', async () => {
      await fund(USER_A, '5000');
      const stakeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId });
      expect(stake.status).toBe('active');
      // Idempotent re-entry with same stakeId: ledger no-op, still active.
      const again = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId });
      expect(again.id).toBe(stakeId);
      expect(await stakedOf(USER_A)).toBe('1000');
      const rows = await sql<Array<{ status: string }>>`SELECT status FROM token.stakes WHERE id = ${stakeId}`;
      expect(rows[0]?.status).toBe('active');
    });

    it('M-02 recovers a stake that crashed after ledger post and before activate', async () => {
      // Crash window: pending claim + principal already in the stake account.
      // stakeOf must stay zero until activate; retry must not double-debit.
      await fund(USER_A, '5000');
      const stakeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      await sql`
        INSERT INTO token.stakes (id, user_id, amount, tier, multiplier_bps, started_at, unlocks_at, status)
        VALUES (
          ${stakeId}, ${USER_A}, ${'1000'}::numeric, 'flex', 10000,
          now(), null, 'pending'
        )
      `;
      await ledger.post(
        recipes.stake({
          stakeId,
          userId: USER_A,
          assetId: 'IFC',
          amount: amt('1000'),
          tier: 'flex',
        }),
      );

      expect(formatAmount(await token.stakeOf(USER_A))).toBe('0');
      expect(await stakedOf(USER_A)).toBe('1000');
      expect(await balanceOf(USER_A)).toBe('4000');

      const recovered = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId });
      expect(recovered.status).toBe('active');
      expect(recovered.id).toBe(stakeId);
      expect(formatAmount(await token.stakeOf(USER_A))).toBe('1000');
      expect(await stakedOf(USER_A)).toBe('1000');
      expect(await balanceOf(USER_A)).toBe('4000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('keeps the pending claim when ledger post fails after applying (no post-without-claim)', async () => {
      // Ambiguous failure class: MemoryLedger applied the stake, then the client
      // saw a transport error. Old fail-path DELETEd pending on any catch →
      // principal stuck in stake account with no row to unstake.
      await fund(USER_A, '5000');
      const stakeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const realPost = ledger.post.bind(ledger);
      let stakePosts = 0;
      ledger.post = async (tx) => {
        const result = await realPost(tx);
        const isStake = typeof tx === 'object' && tx !== null && 'reason' in tx && (tx as { reason?: string }).reason === 'token.stake';
        if (isStake) {
          stakePosts += 1;
          if (stakePosts === 1) {
            throw new Error('simulated network flake after ledger apply');
          }
        }
        return result;
      };

      await expect(token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId })).rejects.toThrow(/network flake/);

      const rows = await sql<Array<{ status: string }>>`SELECT status FROM token.stakes WHERE id = ${stakeId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('pending');
      expect(await stakedOf(USER_A)).toBe('1000');
      expect(await balanceOf(USER_A)).toBe('4000');
      expect(formatAmount(await token.stakeOf(USER_A))).toBe('0');

      // Same stakeId recovers: ledger key no-ops, activate lands once.
      const recovered = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId });
      expect(recovered.status).toBe('active');
      expect(formatAmount(await token.stakeOf(USER_A))).toBe('1000');
      expect(await stakedOf(USER_A)).toBe('1000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('does not report active when the claim row vanished after the ledger post', async () => {
      await fund(USER_A, '5000');
      const stakeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const realPost = ledger.post.bind(ledger);
      ledger.post = async (tx) => {
        const result = await realPost(tx);
        const isStake = typeof tx === 'object' && tx !== null && 'reason' in tx && (tx as { reason?: string }).reason === 'token.stake';
        if (isStake) {
          // Hostile race: claim deleted after apply (old fail-path / dual flight).
          await sql`DELETE FROM token.stakes WHERE id = ${stakeId}`;
        }
        return result;
      };

      await expect(token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId })).rejects.toMatchObject({
        code: 'token.stake_claim_missing',
      });
      expect(await stakedOf(USER_A)).toBe('1000');
      const rows = await sql`SELECT id FROM token.stakes WHERE id = ${stakeId}`;
      expect(rows).toHaveLength(0);
    });

    it('M-01 refuses stakeId reuse with a different amount or user', async () => {
      await fund(USER_A, '5000');
      await fund(USER_B, '5000');
      const stakeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId });

      await expect(token.stake({ userId: USER_A, amount: amt('2000'), tier: 'flex', stakeId })).rejects.toMatchObject({
        code: 'token.stake_conflict',
      });
      await expect(token.stake({ userId: USER_B, amount: amt('1000'), tier: 'flex', stakeId })).rejects.toMatchObject({
        code: 'token.stake_conflict',
      });
      expect(await stakedOf(USER_A)).toBe('1000');
      expect(await stakedOf(USER_B)).toBe('0');
    });

    it('never records a stake the ledger did not fund', async () => {
      await fund(USER_A, '50');
      await expect(token.stake({ userId: USER_A, amount: amt('999'), tier: 'm3', stakeId: crypto.randomUUID() })).rejects.toThrow();

      const staked = await token.stakeOf(USER_A);
      expect(formatAmount(staked)).toBe('0');
      expect(await stakedOf(USER_A)).toBe('0');
    });

    it('emits stakeCreated', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'm3', stakeId: crypto.randomUUID() });
      const emitted = bus.emitted('stakeCreated');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({ stakeId: stake.id, amount: '1000', tier: 'm3' });
    });

    it('sums active stakes and ignores closed ones', async () => {
      await fund(USER_A, '10000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const second = await token.stake({ userId: USER_A, amount: amt('2500'), tier: 'flex', stakeId: crypto.randomUUID() });

      expect(formatAmount(await token.stakeOf(USER_A))).toBe('3500');

      await token.unstake(second.id);
      expect(formatAmount(await token.stakeOf(USER_A))).toBe('1000');
    });

    it("listStakes returns only the caller's active stakes by default", async () => {
      await fund(USER_A, '5000');
      await fund(USER_B, '5000');
      const a1 = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const a2 = await token.stake({ userId: USER_A, amount: amt('2000'), tier: 'm3', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('5000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.unstake(a1.id);

      const active = await token.listStakes(USER_A, 'active', 50);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(a2.id);
      expect(formatAmount(active[0]!.amount)).toBe('2000');

      const all = await token.listStakes(USER_A, 'all', 50);
      expect(all.map((s) => s.id).sort()).toEqual([a1.id, a2.id].sort());

      const closed = await token.listStakes(USER_A, 'closed', 50);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.id).toBe(a1.id);
    });

    it('refuses listStakes without limit — never invents 50', async () => {
      await expect(token.listStakes(USER_A)).rejects.toMatchObject({ code: 'token.stakes_list_limit_unset' });
      await expect(token.listStakes(USER_A, 'active')).rejects.toMatchObject({
        code: 'token.stakes_list_limit_unset',
      });
      await expect(token.listStakes(USER_A, 'all')).rejects.toMatchObject({ code: 'token.stakes_list_limit_unset' });
      expect(assertStakesListLimit(50)).toBe(50);
      expect(await token.listStakes(USER_A, 'active', 50)).toEqual([]);
    });

    it('getStake returns null for unknown ids and returns active stakes', async () => {
      expect(await token.getStake('44444444-4444-4444-8444-444444444444')).toBeNull();

      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const got = await token.getStake(stake.id);
      expect(got?.userId).toBe(USER_A);
      expect(formatAmount(got!.amount)).toBe('1000');
    });
  });

  describe('unstaking and lock enforcement', () => {
    it('returns the principal for an unlocked flex stake', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      await token.unstake(stake.id);

      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await stakedOf(USER_A)).toBe('0');
    });

    it('refuses to unstake a locked stake, and moves no value', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'm12', stakeId: crypto.randomUUID() });

      await expect(token.unstake(stake.id)).rejects.toMatchObject({ code: 'token.stake_locked' });

      expect(await balanceOf(USER_A)).toBe('0');
      expect(await stakedOf(USER_A)).toBe('1000');
    });

    it('allows the unstake once the lock has elapsed', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'm3', stakeId: crypto.randomUUID() });

      const afterLock = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
      await token.unstake(stake.id, afterLock);

      expect(await balanceOf(USER_A)).toBe('1000');
    });

    it('refuses to unstake twice — the principal is returned exactly once', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      await token.unstake(stake.id);
      await expect(token.unstake(stake.id)).rejects.toMatchObject({ code: 'token.stake_closed' });

      expect(await balanceOf(USER_A)).toBe('1000');
    });

    it('survives concurrent unstake attempts without double-paying', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          token
            .unstake(stake.id)
            .then(() => 'ok' as const)
            .catch(() => 'rejected' as const),
        ),
      );

      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(await balanceOf(USER_A)).toBe('1000');
    });

    it('M-04 recovers an unstake that crashed after claim and before ledger post', async () => {
      // Crash window: status=unstaking so stakeOf already dropped the row, but
      // principal still sits in the ledger stake account. Retry must return it
      // exactly once and close the row.
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await sql`UPDATE token.stakes SET status = 'unstaking' WHERE id = ${stake.id} AND status = 'active'`;

      expect(formatAmount(await token.stakeOf(USER_A))).toBe('0');
      expect(await stakedOf(USER_A)).toBe('1000');
      expect(await balanceOf(USER_A)).toBe('0');

      const closed = await token.unstake(stake.id);
      expect(closed.status).toBe('closed');
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await stakedOf(USER_A)).toBe('0');
      expect(formatAmount(await token.stakeOf(USER_A))).toBe('0');

      await expect(token.unstake(stake.id)).rejects.toMatchObject({ code: 'token.stake_closed' });
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('recovers an unstake whose ledger post committed but its acknowledgement was lost', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const realPost = ledger.post.bind(ledger);
      let loseAck = true;
      ledger.post = async (request) => {
        const result = await realPost(request);
        if (request.reason === 'token.unstake' && loseAck) {
          loseAck = false;
          throw new Error('simulated socket close after unstake commit');
        }
        return result;
      };

      await expect(token.unstake(stake.id)).rejects.toThrow(/socket close after unstake commit/);
      expect(await sql`SELECT status FROM token.stakes WHERE id = ${stake.id}`).toMatchObject([{ status: 'unstaking' }]);
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await stakedOf(USER_A)).toBe('0');

      ledger.post = realPost;
      const recovered = await token.unstake(stake.id);
      expect(recovered.status).toBe('closed');
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await stakedOf(USER_A)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('recovers an unstake after the ledger reply and before the close write', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      let failClose = true;
      const closeFailingSql = new Proxy(sql, {
        apply(target, thisArg, args) {
          const template = args[0];
          const statement = Array.isArray(template) ? template.join(' ') : '';
          if (failClose && statement.includes('UPDATE token.stakes') && statement.includes("SET status = 'closed'")) {
            failClose = false;
            throw new Error('simulated process failure before stake close');
          }
          return Reflect.apply(target, thisArg, args);
        },
        get(target, property) {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const recoveringToken = new TokenService(closeFailingSql, ledger, bus, options);

      await expect(recoveringToken.unstake(stake.id)).rejects.toThrow(/process failure before stake close/);
      expect(await sql`SELECT status FROM token.stakes WHERE id = ${stake.id}`).toMatchObject([{ status: 'unstaking' }]);
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await stakedOf(USER_A)).toBe('0');

      const recovered = await recoveringToken.unstake(stake.id);
      expect(recovered.status).toBe('closed');
      expect(await balanceOf(USER_A)).toBe('1000');
      expect(await stakedOf(USER_A)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses an active stake whose ledger pot differs before claiming unstaking', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await sql`UPDATE token.stakes SET amount = ${'2000'}::numeric WHERE id = ${stake.id}`;

      await expect(token.unstake(stake.id)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });
      expect(await sql`SELECT status FROM token.stakes WHERE id = ${stake.id}`).toMatchObject([{ status: 'active' }]);
      expect(await balanceOf(USER_A)).toBe('0');
      expect(await stakedOf(USER_A)).toBe('1000');
    });

    it('rejects an unknown stake', async () => {
      await expect(token.unstake('44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({
        code: 'token.stake_not_found',
      });
    });

    it('refuses to unstake a pending (unfunded) claim and moves no value', async () => {
      // The throw exists for status=pending; only the time-lock branch was
      // executed. A pending row is a claim without ledger principal behind it —
      // unstaking it must not invent a return of funds.
      const stakeId = '55555555-5555-4555-8555-555555555555';
      await sql`
        INSERT INTO token.stakes (id, user_id, amount, tier, multiplier_bps, started_at, unlocks_at, status)
        VALUES (
          ${stakeId}, ${USER_A}, ${'1000'}::numeric, 'flex', 10000,
          now(), null, 'pending'
        )
      `;

      await expect(token.unstake(stakeId)).rejects.toMatchObject({ code: 'token.stake_locked' });

      const rows = await sql<Array<{ status: string }>>`SELECT status FROM token.stakes WHERE id = ${stakeId}`;
      expect(rows[0]?.status).toBe('pending');
      expect(await balanceOf(USER_A)).toBe('0');
      expect(await stakedOf(USER_A)).toBe('0');
    });
  });

  // ── Fee discount (§4.3) ───────────────────────────────────────────────────

  describe('fee discount — token_params is the authority', () => {
    /** The seeded row, restored after any test that edits it. */
    const readSchedule = async () =>
      (await sql<Array<{ fee_discount_schedule: unknown }>>`SELECT fee_discount_schedule FROM token.token_params WHERE id = true`)[0]!
        .fee_discount_schedule;

    it('refuses access when the fee schedule is blank — no invented discount', async () => {
      await fund(USER_A, '10000');
      await token.stake({ userId: USER_A, amount: amt('10000'), tier: 'flex', stakeId: crypto.randomUUID() });

      await expect(token.accessOf(USER_A)).rejects.toMatchObject({
        code: 'token.params_unset',
        config: 'token_params.fee_discount_schedule',
      });
    });

    it('follows a governance edit to the row without a redeploy (§4.3 fee_param)', async () => {
      const original = await readSchedule();
      try {
        await sql`
          UPDATE token.token_params
             SET fee_discount_schedule = ${sql.json({
               basis: 'staked',
               tiers: [
                 { minStake: '0', discountBps: 0 },
                 { minStake: '10000', discountBps: 4_200 },
               ],
             } as never)}
           WHERE id = true
        `;

        await fund(USER_A, '10000');
        await token.stake({ userId: USER_A, amount: amt('10000'), tier: 'flex', stakeId: crypto.randomUUID() });

        // ttl 0 so the read is not answered from a cache filled before the edit.
        const fresh = new TokenService(sql, ledger, bus, { ...options, feeScheduleTtlMs: 0 });
        expect((await fresh.accessOf(USER_A)).feeDiscountBps).toBe(4_200);
      } finally {
        await restoreFeeSchedule(original);
      }
    });

    it('publishes the owner ladder over the version it names, and the next discount read charges it', async () => {
      const original = await readSchedule();
      try {
        await restoreFeeSchedule(null);
        // A cache filled before the publish must not answer after it: the TTL here is the production one.
        const cached = new TokenService(sql, ledger, bus, { ...options, feeScheduleTtlMs: 60_000 });
        await publishFeeSchedule();
        await fund(USER_A, '10000');
        await token.stake({ userId: USER_A, amount: amt('10000'), tier: 'flex', stakeId: crypto.randomUUID() });
        expect((await cached.accessOf(USER_A)).feeDiscountBps).toBe(0);

        const before = await cached.feeDiscountScheduleRow();
        expect(before.version).toMatch(/^sha256:/);
        const ladder = {
          basis: 'staked',
          tiers: [
            { minStake: '0', discountBps: 0 },
            { minStake: '5000.0', discountBps: 1_500 },
          ],
        };
        const published = await cached.publishFeeDiscountSchedule({ schedule: ladder, expectedVersion: before.version });
        expect(published.previousVersion).toBe(before.version);
        expect(published.schedule.tiers[1]).toEqual({ minStake: '5000', discountBps: 1_500 });
        expect(await readSchedule()).toEqual(published.schedule);
        expect(await cached.feeDiscountScheduleRow()).toEqual({ schedule: published.schedule, version: published.version });
        expect((await cached.accessOf(USER_A)).feeDiscountBps).toBe(1_500);
      } finally {
        await restoreFeeSchedule(original);
      }
    });

    it('refuses a publish over a version that is no longer stored, and writes nothing', async () => {
      const original = await readSchedule();
      try {
        await restoreFeeSchedule(null);
        expect(await token.feeDiscountScheduleRow()).toEqual({ schedule: null, version: 'unset' });
        const first = await token.publishFeeDiscountSchedule({
          schedule: { basis: 'staked', tiers: [{ minStake: '0', discountBps: 100 }] },
          expectedVersion: 'unset',
        });
        // A second owner pair approved their ladder against the blank row too: theirs lost the race.
        await expect(
          token.publishFeeDiscountSchedule({
            schedule: { basis: 'staked', tiers: [{ minStake: '0', discountBps: 900 }] },
            expectedVersion: 'unset',
          }),
        ).rejects.toMatchObject({ code: 'token.fee_discount_stale' });
        expect((await token.feeDiscountScheduleRow()).version).toBe(first.version);
        expect(await readSchedule()).toEqual(first.schedule);
      } finally {
        await restoreFeeSchedule(original);
      }
    });

    it('refuses a ladder the door does not accept before it reads or writes the row', async () => {
      const original = await readSchedule();
      try {
        await restoreFeeSchedule(null);
        await expect(
          token.publishFeeDiscountSchedule({
            schedule: {
              basis: 'staked',
              tiers: [
                { minStake: '0', discountBps: 2_000 },
                { minStake: '1000', discountBps: 1_000 },
              ],
            },
            expectedVersion: 'unset',
          }),
        ).rejects.toMatchObject({ code: 'token.fee_discount_invalid' });
        expect(await readSchedule()).toBeNull();
        // A row that does not parse is shown as stored, with its version, so the owner can replace it.
        await sql`UPDATE token.token_params SET fee_discount_schedule = '{"basis":"balance","tiers":[]}'::jsonb WHERE id = true`;
        const row = await token.feeDiscountScheduleRow();
        expect(row.schedule).toEqual({ basis: 'balance', tiers: [] });
        const replaced = await token.publishFeeDiscountSchedule({
          schedule: { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] },
          expectedVersion: row.version,
        });
        expect(replaced.previousVersion).toBe(row.version);
      } finally {
        await restoreFeeSchedule(original);
      }
    });

    it('refuses to serve a discount at all when the row is unreadable', async () => {
      // No fallback to the compiled-in default, deliberately: falling back would charge a
      // discount the database does not hold, silently — the exact failure being fixed here.
      const original = await readSchedule();
      try {
        await sql`UPDATE token.token_params SET fee_discount_schedule = '{"basis":"balance","tiers":[]}'::jsonb WHERE id = true`;
        const fresh = new TokenService(sql, ledger, bus, { ...options, feeScheduleTtlMs: 0 });
        await expect(fresh.accessOf(USER_A)).rejects.toMatchObject({ code: 'token.params_invalid' });
      } finally {
        await restoreFeeSchedule(original);
      }
    });
  });

  // ── Real yield ────────────────────────────────────────────────────────────

  describe('real-yield distribution', () => {
    it('pays revenue to stakers and the books still close', async () => {
      await fund(USER_A, '1000');
      await fund(USER_B, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      await accrueFees('trade', '100');

      const result = await token.distributeRevenue({ windowId: 'w1', sources: [{ module: 'trade', amount: amt('100') }] });

      expect(result.recipients).toBe(2);
      expect(formatAmount(result.distributed)).toBe('100');
      // Equal stakes, equal tier — equal split.
      expect(await balanceOf(USER_A)).toBe('50');
      expect(await balanceOf(USER_B)).toBe('50');

      expect(ledger.totalsByAsset().IFC).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('weights by tier multiplier, not just by amount', async () => {
      await fund(USER_A, '1000');
      await fund(USER_B, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('1000'), tier: 'm12', stakeId: crypto.randomUUID() });

      await accrueFees('trade', '100');
      await token.distributeRevenue({ windowId: 'w-tier', sources: [{ module: 'trade', amount: amt('100') }] });

      // Same principal, longer lock — B must receive strictly more.
      const a = amt(await balanceOf(USER_A));
      const b = amt(await balanceOf(USER_B));
      expect(b > a).toBe(true);
      expect(formatAmount(a + b)).toBe('100');
    });

    it('pays a user holding TWO stakes the sum of both shares', async () => {
      // The bug this covers: `distributeYield` returns one share PER STAKE, but
      // the reward key is per (window, user). Posting each share separately made
      // the second a silent idempotency no-op — the user was underpaid and the
      // remainder sat in the rewards engine. Found by partner audit; there was
      // no test, which is exactly why it survived.
      await fund(USER_A, '2000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'm12', stakeId: crypto.randomUUID() });

      await accrueFees('trade', '100');
      const result = await token.distributeRevenue({ windowId: 'w-multi', sources: [{ module: 'trade', amount: amt('100') }] });

      // One recipient, one payout — and the WHOLE window distributed.
      expect(result.recipients).toBe(1);
      expect(formatAmount(result.distributed)).toBe('100');
      expect(await balanceOf(USER_A)).toBe('100');

      // Nothing stranded in the rewards engine.
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('0');
      expect(ledger.totalsByAsset().IFC).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('weights by the multiplier stored on the stake, not by today’s ladder', async () => {
      // `multiplier_bps` was written at stake time and then never read — yield
      // used the live STAKE_TIERS table instead. A staker who locked for twelve
      // months bought THAT multiplier; re-tuning the ladder afterwards must not
      // retroactively change what they earn.
      await fund(USER_A, '1000');
      await fund(USER_B, '1000');
      const a = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      // A stake opened under a more generous historical ladder.
      await sql`UPDATE token.stakes SET multiplier_bps = 30000 WHERE id = ${a.id}`;

      await accrueFees('trade', '100');
      await token.distributeRevenue({ windowId: 'w-snapshot', sources: [{ module: 'trade', amount: amt('100') }] });

      // 3× weight against 1× → 75/25, not the 50/50 the live ladder would give.
      expect(await balanceOf(USER_A)).toBe('75');
      expect(await balanceOf(USER_B)).toBe('25');
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });

    it('distributes the exact total with no dust lost across uneven stakes', async () => {
      const users = [USER_A, USER_B, USER_C];
      const amounts = ['333.333333333333333333', '1000', '7'];

      for (const [i, user] of users.entries()) {
        await fund(user, amounts[i]!);
        await token.stake({ userId: user, amount: amt(amounts[i]!), tier: 'flex', stakeId: crypto.randomUUID() });
      }

      const revenue = '100.000000000000000001';
      await accrueFees('trade', revenue);
      const result = await token.distributeRevenue({ windowId: 'w-dust', sources: [{ module: 'trade', amount: amt(revenue) }] });

      expect(formatAmount(result.distributed)).toBe(revenue);
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });

    it('is resumable — re-running a window pays nobody twice', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await accrueFees('trade', '100');

      await token.distributeRevenue({ windowId: 'w-retry', sources: [{ module: 'trade', amount: amt('100') }] });
      const again = await token.distributeRevenue({ windowId: 'w-retry', sources: [{ module: 'trade', amount: amt('100') }] });

      expect(await balanceOf(USER_A)).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });

      // And the RE-RUN SAYS SO. It used to report `distributed: 100,
      // recipients: 1` — counting a post the ledger had turned into a no-op —
      // so the operator's only feedback channel said the window had paid out
      // twice.
      expect(formatAmount(again.distributed)).toBe('0');
      expect(again.recipients).toBe(0);
      expect(again.alreadyPaid).toBe(1);
    });

    it('collapses duplicate source modules so the plan total matches what was swept', async () => {
      // Sweep key is per (window, module). Two legs of 50 used to plan 100 while
      // only the first 50 moved — plan underfunded, payouts fail mid-loop or
      // drain another window's residual in the rewards engine.
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await accrueFees('trade', '100');

      const result = await token.distributeRevenue({
        windowId: 'w-dup-module',
        sources: [
          { module: 'trade', amount: amt('50') },
          { module: 'trade', amount: amt('50') },
        ],
      });

      expect(formatAmount(result.distributed)).toBe('100');
      expect(result.recipients).toBe(1);
      expect(await balanceOf(USER_A)).toBe('100');
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('concurrent re-settles of the same unpaid plan report one payout, not two', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await accrueFees('trade', '100');

      // First call plans + pays. Second wave of concurrent retries must not
      // each report distributed=100 (money is ledger-safe; the operator channel
      // used to lie).
      await token.distributeRevenue({ windowId: 'w-conc', sources: [{ module: 'trade', amount: amt('100') }] });

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          token.distributeRevenue({ windowId: 'w-conc', sources: [{ module: 'trade', amount: amt('100') }] }),
        ),
      );

      expect(results.every((r) => formatAmount(r.distributed) === '0')).toBe(true);
      expect(results.every((r) => r.recipients === 0)).toBe(true);
      expect(results.every((r) => r.alreadyPaid === 1)).toBe(true);
      expect(await balanceOf(USER_A)).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * ═════════════════════════════════════════════════════════════════════════
     * A WINDOW PAYS THE STAKERS IT HAD, NOT THE STAKERS IT HAS
     * ═════════════════════════════════════════════════════════════════════════
     *
     * `distributeRevenue` documents itself as resumable — "re-running pays only
     * whoever was missed". That was true only while the staker set stood still,
     * and the staker set moves continuously.
     *
     * The recipient list was recomputed from `status = 'active'` on every call.
     * Re-run a fully-settled window after ONE new stake opened and the list
     * grew: the users already paid had spent their `(window, user)` reward keys
     * so their posts became silent no-ops, and the newcomer's key was fresh —
     * so the newcomer was paid in full out of a window whose revenue was
     * already gone. `rewardsEngine` is a `house` account and §4.2 makes every
     * non-treasury account hard non-negative, so that value comes out of some
     * OTHER window's undistributed revenue, or the run dies mid-loop and leaves
     * the window half paid.
     */
    it('does not pay a staker who joined AFTER the window was distributed', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await accrueFees('trade', '100');

      const first = await token.distributeRevenue({ windowId: 'w-late', sources: [{ module: 'trade', amount: amt('100') }] });
      expect(formatAmount(first.distributed)).toBe('100');
      expect(await balanceOf(USER_A)).toBe('100');
      // The window is settled to the attounit — nothing is left behind it.
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('0');

      // A newcomer stakes, and the operator re-runs the window — the operation
      // the method's own docstring calls safe.
      await fund(USER_B, '1000');
      await token.stake({ userId: USER_B, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      const again = await token.distributeRevenue({ windowId: 'w-late', sources: [{ module: 'trade', amount: amt('100') }] });

      // B was not staked when this window was planned, so this window owes B
      // nothing. B earns from the NEXT window, like everybody else who joined.
      expect(await balanceOf(USER_B)).toBe('0');
      expect(formatAmount(again.distributed)).toBe('0');
      expect(again.recipients).toBe(0);
      expect(again.alreadyPaid).toBe(1);

      // And nothing was conjured: A keeps exactly the window, the engine is
      // still empty, and the books close.
      expect(await balanceOf(USER_A)).toBe('100');
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('0');
      expect(ledger.totalsByAsset().IFC).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('finishes a window that crashed halfway, paying only whoever was missed', async () => {
      // The promise the frozen plan has to keep: resumability is the REASON
      // each payout is its own transaction, and it must survive the plan being
      // frozen.
      for (const user of [USER_A, USER_B]) {
        await fund(user, '1000');
        await token.stake({ userId: user, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      }
      await accrueFees('trade', '100');

      // First run pays both. Then forget that B was paid, exactly as a crash
      // between the ledger post and the row update would leave it.
      await token.distributeRevenue({ windowId: 'w-crash', sources: [{ module: 'trade', amount: amt('100') }] });
      await sql`UPDATE token.yield_payouts SET ledger_tx_id = NULL, paid_at = NULL WHERE window_id = 'w-crash' AND user_id = ${USER_B}`;

      const resumed = await token.distributeRevenue({ windowId: 'w-crash', sources: [{ module: 'trade', amount: amt('100') }] });

      // B's post is re-driven and the ledger's key makes it a no-op, so nobody
      // is paid twice — and A, whose row still says paid, is not re-posted.
      expect(resumed.alreadyPaid).toBe(1);
      expect(resumed.recipients).toBe(1);
      expect(await balanceOf(USER_A)).toBe('50');
      expect(await balanceOf(USER_B)).toBe('50');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses a re-run that names a different revenue total for the same window', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await accrueFees('trade', '100');
      await token.distributeRevenue({ windowId: 'w-changed', sources: [{ module: 'trade', amount: amt('100') }] });

      // `sources` is operator-typed. Paying the frozen plan while the operator
      // asks for a different figure answers a request nobody made; re-planning
      // pays the difference to whoever is staked today. Saying so beats both.
      await accrueFees('trade', '900');
      await expect(
        token.distributeRevenue({ windowId: 'w-changed', sources: [{ module: 'trade', amount: amt('1000') }] }),
      ).rejects.toMatchObject({ code: 'token.yield_window_mismatch' });

      expect(await balanceOf(USER_A)).toBe('100');
    });

    it('does not pay a staker who joined AFTER an empty window was claimed', async () => {
      // W4 residual / 0004: empty distribute used to write no plan row, so a
      // later stake + re-run of the same window id planned the newcomer.
      // Header freezes the empty answer. Fees still sweep into the engine
      // (buyback and residual scheduling); late joiners need a NEW window id
      // with NEW fees — the frozen id never invents recipients.
      await accrueFees('trade', '100');
      const empty = await token.distributeRevenue({ windowId: 'w-later', sources: [{ module: 'trade', amount: amt('100') }] });
      expect(empty.recipients).toBe(0);
      expect(formatAmount(empty.distributed)).toBe('0');

      const headers = await sql<Array<{ window_id: string; total_amount: string }>>`
        SELECT window_id, total_amount FROM token.yield_windows WHERE window_id = 'w-later'
      `;
      expect(headers).toHaveLength(1);
      expect(amt(headers[0]!.total_amount)).toBe(amt('100'));
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('100');

      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      const again = await token.distributeRevenue({ windowId: 'w-later', sources: [{ module: 'trade', amount: amt('100') }] });
      expect(formatAmount(again.distributed)).toBe('0');
      expect(again.recipients).toBe(0);
      expect(await balanceOf(USER_A)).toBe('0');

      // New window needs its own fees in houseFees (first window already swept).
      await accrueFees('trade', '100');
      const next = await token.distributeRevenue({ windowId: 'w-later-2', sources: [{ module: 'trade', amount: amt('100') }] });
      expect(formatAmount(next.distributed)).toBe('100');
      expect(await balanceOf(USER_A)).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses a different total on a previously empty window', async () => {
      await accrueFees('trade', '100');
      await token.distributeRevenue({ windowId: 'w-empty-mismatch', sources: [{ module: 'trade', amount: amt('100') }] });

      await accrueFees('trade', '50');
      await expect(
        token.distributeRevenue({ windowId: 'w-empty-mismatch', sources: [{ module: 'trade', amount: amt('150') }] }),
      ).rejects.toMatchObject({ code: 'token.yield_window_mismatch' });

      // Header total frozen; no payouts invented.
      const headers = await sql<Array<{ total_amount: string }>>`
        SELECT total_amount FROM token.yield_windows WHERE window_id = 'w-empty-mismatch'
      `;
      expect(amt(headers[0]!.total_amount)).toBe(amt('100'));
      expect(await sql`SELECT user_id FROM token.yield_payouts WHERE window_id = 'w-empty-mismatch'`).toHaveLength(0);
    });

    it('sweeps into the rewards engine when nobody is staked and freezes the window id', async () => {
      await accrueFees('trade', '100');
      const result = await token.distributeRevenue({ windowId: 'w-empty', sources: [{ module: 'trade', amount: amt('100') }] });

      expect(result.recipients).toBe(0);
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('100');
      expect(ledger.totalsByAsset().IFC).toBe('0');
      expect(await sql`SELECT window_id FROM token.yield_windows WHERE window_id = 'w-empty'`).toHaveLength(1);
    });

    it('refuses a window with no revenue rather than posting nothing quietly', async () => {
      await expect(token.distributeRevenue({ windowId: 'w-zero', sources: [] })).rejects.toMatchObject({
        code: 'token.nothing_to_distribute',
      });
    });

    it('refuses a fee source larger than the houseFees pot before claiming the window', async () => {
      // T-03 residual: operator-typed sources used to skip the balance check.
      // Over-claim then either underfunded the plan or died mid-sweep after the
      // header was already claimed. Fail closed on the pot that actually holds
      // the fees — under-claim (leaving fees behind) is still allowed.
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await accrueFees('trade', '50');

      await expect(
        token.distributeRevenue({ windowId: 'w-overclaim', sources: [{ module: 'trade', amount: amt('100') }] }),
      ).rejects.toMatchObject({ code: 'token.yield_source_underfunded' });

      // No header claimed, no fees moved.
      expect(await sql`SELECT window_id FROM token.yield_windows WHERE window_id = 'w-overclaim'`).toHaveLength(0);
      expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe('50');
      expect(await balanceOf(USER_A)).toBe('0');
    });

    it('drains the source module fee account', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await accrueFees('trade', '100');

      expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe('100');
      await token.distributeRevenue({ windowId: 'w-drain', sources: [{ module: 'trade', amount: amt('100') }] });
      expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe('0');
    });
  });

  // ── Buyback & burn ────────────────────────────────────────────────────────

  describe('buyback and burn', () => {
    it('settleBuybackFill burns the fill split from the rewards engine', async () => {
      await ledger.post(recipes.mintEmission({ epoch: 0, assetId: 'IFC', amount: amt('10'), destination: rewardsEngine('IFC') }));
      const runId = crypto.randomUUID();
      const result = await token.settleBuybackFill({
        runId,
        revenueWindow: { from: new Date('2026-07-01T00:00:00.000Z'), to: new Date('2026-07-08T00:00:00.000Z') },
        revenueTotal: { USDT: '100' },
        tokensBought: amt('10'),
      });
      expect(result).toEqual({ runId, burned: amt('6'), toRewards: amt('4') });
      expect(await burnIfC()).toBe(amt('6'));
      expect(await engineIfC()).toBe(amt('4'));
      const rows = await sql<Array<{ status: string }>>`SELECT status FROM token.buyback_runs WHERE id = ${runId}`;
      expect(rows[0]?.status).toBe('settled');
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('settled recordBuyback(tokensBought=1000) moves that many on the ledger (buy into engine + burn toBurn)', async () => {
      await accrueFees('trade', '1000');
      await token.distributeRevenue({ windowId: 'w-bb-delta', sources: [{ module: 'trade', amount: amt('1000') }] });

      const engineBefore = await engineIfC();
      const burnBefore = await burnIfC();
      const input = {
        runId: crypto.randomUUID(),
        revenueWindow: { from: new Date('2026-07-01'), to: new Date('2026-07-07') },
        revenueTotal: { IFC: '1000' },
        tokensBought: amt('1000'),
      };

      let settled: { runId: string; burned: bigint; toRewards: bigint } | undefined;
      try {
        settled = await token.recordBuyback(input);
      } catch (err) {
        // Refuse-closed is legal: no recipe books the buy-in, so we must not
        // settle a DB-only tokensBought (today the engine only dropped by toBurn).
        expect(err).toMatchObject({ name: 'TokenError', code: 'token.buyback_tokens_unmoved' });
        expect(await engineIfC()).toBe(engineBefore);
        expect(await burnIfC()).toBe(burnBefore);
        expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
        expect(bus.emitted('buybackExecuted')).toHaveLength(0);
        expect(ledger.reconcile()).toEqual({ ok: true });
        return;
      }

      const engineDelta = (await engineIfC()) - engineBefore;
      const burnDelta = (await burnIfC()) - burnBefore;
      // Buy into engine (+tokensBought) plus burn toBurn (−toBurn engine, +toBurn burn)
      // nets engineΔ + burnΔ === tokensBought. Today's path only burns toBurn from
      // the engine, so the sum is 0 and this fails until the book matches the row.
      expect(engineDelta + burnDelta).toBe(input.tokensBought);
      expect(settled.burned + settled.toRewards).toBe(input.tokensBought);
    });

    it('refuses to settle a positive tokensBought when the burn split is zero — zero posts is not a buy', async () => {
      const zeroBurn = new TokenService(sql, ledger, bus, {
        ...options,
        buyback: { buybackBps: 5_000, burnSplitBps: 0 },
      });
      await accrueFees('trade', '1000');
      await zeroBurn.distributeRevenue({ windowId: 'w-bb-zero-split', sources: [{ module: 'trade', amount: amt('1000') }] });

      const engineBefore = await engineIfC();
      await expect(
        zeroBurn.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: { from: new Date('2026-07-01'), to: new Date('2026-07-07') },
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ name: 'TokenError', code: 'token.buyback_tokens_unmoved' });

      expect(await engineIfC()).toBe(engineBefore);
      expect(await burnIfC()).toBe(0n);
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
    });

    it("resumes a pending claim with the burn it recorded, not one recomputed from today's split", async () => {
      await ledger.post(recipes.mintEmission({ epoch: 0, assetId: 'IFC', amount: amt('1000'), destination: rewardsEngine('IFC') }));
      const runId = crypto.randomUUID();
      const window = { from: new Date('2026-09-01'), to: new Date('2026-09-07') };
      // Claimed when the split was 60%: 300 of 500 to burn, 200 to rewards.
      await seedBuybackRun({ runId, window, tokensBought: '500', toBurn: '300', toRewards: '200', status: 'pending', ageSeconds: 3600 });

      // The split has since moved to 80%. The resume must not burn 400 against a row that says 300.
      const moved = new TokenService(sql, ledger, bus, { ...options, buyback: { buybackBps: 5_000, burnSplitBps: 8_000 } });
      const result = await moved.settleBuybackFill({
        runId,
        revenueWindow: window,
        revenueTotal: { IFC: '1000' },
        tokensBought: amt('500'),
      });

      expect(result).toEqual({ runId, burned: amt('300'), toRewards: amt('200') });
      expect(await burnIfC()).toBe(amt('300'));
      const rows = await sql<Array<{ status: string; tokens_burned: string }>>`
        SELECT status, tokens_burned::text FROM token.buyback_runs WHERE id = ${runId}
      `;
      expect(rows[0]?.status).toBe('settled');
      expect(amt(rows[0]!.tokens_burned)).toBe(amt('300'));
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('retries a settled run without re-posting', async () => {
      const runId = crypto.randomUUID();
      const window = { from: new Date('2026-08-01'), to: new Date('2026-08-07') };
      await seedBuybackRun({ runId, window, tokensBought: '500', toBurn: '300', toRewards: '200' });

      const input = {
        runId,
        revenueWindow: window,
        revenueTotal: { IFC: '1000' },
        tokensBought: amt('500'),
      };

      const first = await token.recordBuyback(input);
      const burnedAfterFirst = await token.burnedSupply();
      const second = await token.recordBuyback(input);

      const rows = await sql`SELECT id FROM token.buyback_runs WHERE id = ${runId}`;
      expect(rows).toHaveLength(1);
      expect(await token.burnedSupply()).toBe(burnedAfterFirst);
      expect(second).toEqual(first);
      expect(first).toEqual({ runId, burned: amt('300'), toRewards: amt('200') });
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('does not emit buybackExecuted when the buy never moved on the ledger', async () => {
      await accrueFees('trade', '777');
      await token.distributeRevenue({ windowId: 'w-bb3', sources: [{ module: 'trade', amount: amt('777') }] });

      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: { from: new Date('2026-09-01'), to: new Date('2026-09-07') },
          revenueTotal: { IFC: '777' },
          tokensBought: amt('777'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });

      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
    });

    it('refuses tokensBought=0 before claiming the window — zero must not spend the interval', async () => {
      const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-08T00:00:00Z') };

      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '0' },
          tokensBought: amt('0'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_revenue_invalid' });

      // No claim row — a later real buy for the same window must still be free.
      const rows = await sql`SELECT id FROM token.buyback_runs`;
      expect(rows).toHaveLength(0);
      expect(await token.burnedSupply()).toBe(0n);

      await accrueFees('trade', '500');
      await token.distributeRevenue({ windowId: 'w-bb-zero-then-real', sources: [{ module: 'trade', amount: amt('500') }] });
      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '500' },
          tokensBought: amt('500'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect(await token.burnedSupply()).toBe(0n);
    });

    it('treasury.burned is burnedSupply, and lastBuyback is the latest settled run', async () => {
      const empty = await token.treasuryView();
      expect(empty).toEqual({
        minted: null,
        burned: '0',
        bought: null,
        toRewards: null,
        distributed: null,
        lastBuyback: null,
      });
      expect(empty.burned).toBe(formatAmount(await token.burnedSupply()));

      await sql`
        INSERT INTO token.emission_epochs (epoch, scheduled_amount, mined_amount, closed)
        VALUES (0, 100, 12.5, true), (1, 100, 50, false)
      `;
      await sql`
        INSERT INTO token.yield_payouts (window_id, user_id, amount, ledger_tx_id, paid_at)
        VALUES
          ('w-paid', ${USER_A}::uuid, 3.25, 'tx-treasury', now()),
          ('w-planned', ${USER_A}::uuid, 9, NULL, NULL)
      `;
      await sql`
        INSERT INTO token.buyback_runs (
          id, revenue_window_from, revenue_window_to, revenue_total,
          tokens_bought, tokens_burned, tokens_to_rewards, status, executed_at
        ) VALUES
          (
            '11111111-1111-4111-8111-111111111111',
            '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', ${sql.json({ IFC: '10' } as never)},
            10, 4, 6, 'settled', '2026-01-15T00:00:00Z'
          ),
          (
            '00000000-0000-4000-8000-000000000001',
            '2026-06-01T00:00:00Z', '2026-06-15T00:00:00Z', ${sql.json({ IFC: '2' } as never)},
            2, 1, 1, 'settled', '2026-06-01T00:00:00Z'
          ),
          (
            'ffffffff-ffff-4fff-8fff-ffffffffffff',
            '2026-06-15T00:00:00Z', '2026-07-01T00:00:00Z', ${sql.json({ IFC: '5' } as never)},
            5, 3, 2, 'settled', '2026-06-01T00:00:00Z'
          ),
          (
            '22222222-2222-4222-8222-222222222222',
            '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', ${sql.json({ IFC: '100' } as never)},
            100, 80, 20, 'pending', '2026-12-15T00:00:00Z'
          )
      `;
      await ledger.post(recipes.mintEmission({ epoch: 90, assetId: 'IFC', amount: amt('7'), destination: rewardsEngine('IFC') }));
      await ledger.post(recipes.burn({ runId: 'treasury-not-a-buyback', assetId: 'IFC', amount: amt('7'), from: rewardsEngine('IFC') }));

      const view = await token.treasuryView();
      expect(view.burned).toBe(formatAmount(await token.burnedSupply()));
      expect(view.burned).toBe('7');
      expect(view.burned).not.toBe('8');
      expect(view.minted).toBe('12.5');
      expect(view.bought).toBe('17');
      expect(view.toRewards).toBe('9');
      expect(view.distributed).toBe('3.25');
      expect(view.lastBuyback).toEqual({
        bought: '5',
        burned: '3',
        toRewards: '2',
        executedAt: '2026-06-01T00:00:00.000Z',
      });
    });
  });

  // ── Buyback: the window is claimed BEFORE the burn ─────────────────────────
  //
  // The burn is irreversible. Before 0002, `recordBuyback` posted it and only
  // then inserted the run row `ON CONFLICT (id) DO NOTHING`, while the guard was
  // a unique index on the WINDOW. A new run id over a spent window therefore
  // burned for real and then failed on an index its conflict clause did not
  // name — no row, no event, and an opaque 500.
  //
  // Every test in this block reads the BURN ACCOUNT. Asserting that an error was
  // thrown proves nothing here: the old code threw too, after the money moved.

  describe('buyback window claim (irreversible-leg ordering)', () => {
    /** Fund the rewards engine so a burn has something behind it. */
    async function fundRewards(amount: string, windowId: string) {
      await accrueFees('trade', amount);
      await token.distributeRevenue({ windowId, sources: [{ module: 'trade', amount: amt(amount) }] });
    }

    const JULY = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') };

    it('refuses a NEW run id over an identical window and burns nothing the second time', async () => {
      await fundRewards('4000', 'w-claim-identical');
      const heldId = crypto.randomUUID();
      await seedBuybackRun({ runId: heldId, window: JULY });
      const burnedAfterFirst = await token.burnedSupply();

      // A DIFFERENT run id over the SAME window. `ON CONFLICT (id)` never saw
      // this, which is precisely how the burn used to get out.
      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ name: 'TokenError', code: 'token.buyback_window_overlap' });

      // THE POINT. Read the BURN ACCOUNT, not the exception.
      expect(await token.burnedSupply()).toBe(burnedAfterFirst);
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(1);
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    // The failure the ADR describes verbatim: "neither a TokenError nor a
    // LedgerError, so it falls through to an opaque INTERNAL_SERVER_ERROR".
    // The raw PostgresError that used to escape here carried code '23505'.
    it('refuses by NAME, never as a raw Postgres error', async () => {
      await fundRewards('4000', 'w-claim-named');
      const heldId = crypto.randomUUID();
      await seedBuybackRun({ runId: heldId, window: JULY });

      const err = await token
        .recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(TokenError);
      expect((err as TokenError).code).toBe('token.buyback_window_overlap');
      // Not a bare PG SQLSTATE leaking through as a 500.
      expect((err as { code: string }).code).not.toBe('23505');
      expect((err as { code: string }).code).not.toBe('23P01');
      // And it names the run that actually holds the window, so an operator can act.
      expect((err as Error).message).toContain(heldId);
    });

    // The unique index matched only exact equality of BOTH timestamps, so every
    // one of these burned the same revenue a second time with no error at all.
    it.each([
      ['nested inside', { from: new Date('2026-07-10T00:00:00Z'), to: new Date('2026-07-20T00:00:00Z') }],
      ['strictly containing', { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') }],
      ['overlapping the tail by a day', { from: new Date('2026-07-31T00:00:00Z'), to: new Date('2026-08-15T00:00:00Z') }],
      ['overlapping the head by a day', { from: new Date('2026-06-20T00:00:00Z'), to: new Date('2026-07-02T00:00:00Z') }],
      ['one second short of the end', { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T23:59:59Z') }],
      ['one second past the start', { from: new Date('2026-07-01T00:00:01Z'), to: new Date('2026-08-01T00:00:00Z') }],
    ])('refuses a window %s an already-claimed one, and burns nothing', async (_label, overlapping) => {
      await fundRewards('4000', `w-claim-${_label.replace(/\s+/g, '-')}`);
      await seedBuybackRun({ runId: crypto.randomUUID(), window: JULY });
      const burnedAfterFirst = await token.burnedSupply();

      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: overlapping,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ name: 'TokenError', code: 'token.buyback_window_overlap' });

      expect(formatAmount(await token.burnedSupply())).toBe(formatAmount(burnedAfterFirst));
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    // Half-open `[from, to)` is what makes a contiguous series settleable at
    // all: `to` belongs to the next window. Under closed `[from, to]` these two
    // would collide on the shared instant and a gapless series would be
    // impossible. This fixes the BOUNDARY rule only — window length, cadence and
    // whether the series must be gapless remain the owner's.
    it('allows contiguous half-open windows — [a, b) then [b, c)', async () => {
      await fundRewards('4000', 'w-claim-contiguous');

      const julyWindow = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') };
      const augustWindow = { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') };
      await seedBuybackRun({ runId: crypto.randomUUID(), window: julyWindow });
      // Starts at exactly the instant July ended. Not an overlap.
      await seedBuybackRun({ runId: crypto.randomUUID(), window: augustWindow });

      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(2);
      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: augustWindow,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_window_overlap' });
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('concurrent same-window claims: each unmoved or overlap, never a buy or a raw PG crash', async () => {
      const results = await Promise.allSettled([
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ]);

      // Fulfilled would invent a buy. A non-TokenError is the unmapped GiST
      // deadlock. Do not require one of each: winner DELETE-releases pending,
      // so the other INSERT can also land as unmoved.
      expect(results.every((r) => r.status === 'rejected' && r.reason instanceof TokenError)).toBe(true);
      for (const r of results) {
        const code = r.status === 'rejected' ? (r.reason as TokenError).code : 'ok';
        expect(['token.buyback_tokens_unmoved', 'token.buyback_window_overlap']).toContain(code);
      }
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect(formatAmount(await token.burnedSupply())).toBe('0');
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('leaves no claim behind when tokensBought cannot move, so the window stays available', async () => {
      const runId = crypto.randomUUID();
      await expect(
        token.recordBuyback({
          runId,
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });

      // The claim was released: a run that booked nothing must not hold a
      // window hostage forever.
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect(formatAmount(await token.burnedSupply())).toBe('0');

      await fundRewards('2000', 'w-claim-released');
      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('releases a pending crash that never posted, rather than completing a fee-funded burn', async () => {
      await fundRewards('2000', 'w-claim-crash');

      // Exactly the state a crash after CLAIM but before POST leaves behind.
      const runId = crypto.randomUUID();
      await seedBuybackRun({ runId, window: JULY, status: 'pending' });
      expect(formatAmount(await token.burnedSupply())).toBe('0');

      await expect(
        token.recordBuyback({
          runId,
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });

      expect(await token.burnedSupply()).toBe(0n);
      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${runId}`).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('keeps a YOUNG pending claim even when the ledger says the burn is not booked (a late burn may still land)', async () => {
      await fundRewards('2000', 'w-claim-young');
      const runId = crypto.randomUUID();
      await seedBuybackRun({ runId, window: JULY, status: 'pending', ageSeconds: 5 });

      await expect(
        token.recordBuyback({ runId, revenueWindow: JULY, revenueTotal: { IFC: '1000' }, tokensBought: amt('1000') }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });

      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${runId}`).toHaveLength(1);
    });

    it('keeps a claim with an old created_at when the last burn attempt is still inside the quiet period', async () => {
      await fundRewards('2000', 'w-claim-last-post');
      const runId = crypto.randomUUID();
      await seedBuybackRun({ runId, window: JULY, status: 'pending', ageSeconds: 3600, lastPostAgeSeconds: 5 });

      await expect(
        token.recordBuyback({ runId, revenueWindow: JULY, revenueTotal: { IFC: '1000' }, tokensBought: amt('1000') }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });

      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${runId}`).toHaveLength(1);
      expect(await token.burnedSupply()).toBe(0n);
    });

    it('a late burn and recordBuyback cannot both pass the quiet period', async () => {
      await ledger.post(recipes.mintEmission({ epoch: 0, assetId: 'IFC', amount: amt('1000'), destination: rewardsEngine('IFC') }));
      const runId = crypto.randomUUID();
      await seedBuybackRun({ runId, window: JULY, status: 'pending', ageSeconds: 3600, lastPostAgeSeconds: 3600 });
      const input = {
        runId,
        revenueWindow: JULY,
        revenueTotal: { IFC: '1000' },
        tokensBought: amt('1000'),
      };

      let releaseGate!: () => void;
      const releaseDone = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let burnEntered!: () => void;
      const burnInPost = new Promise<void>((resolve) => {
        burnEntered = resolve;
      });
      const realPost = ledger.post.bind(ledger);
      ledger.post = async (tx) => {
        const [clock] = await sql<Array<{ created_old: boolean; post_young: boolean }>>`
          SELECT
            (clock_timestamp() - created_at) > make_interval(secs => 120) AS created_old,
            last_post_at IS NOT NULL AND (clock_timestamp() - last_post_at) < make_interval(secs => 120) AS post_young
            FROM token.buyback_runs WHERE id = ${runId}
        `;
        expect(clock?.created_old).toBe(true);
        expect(clock?.post_young).toBe(true);
        burnEntered();
        await releaseDone;
        return realPost(tx);
      };

      const burning = token.settleBuybackFill(input);
      await burnInPost;
      await expect(token.recordBuyback(input)).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });
      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${runId}`).toHaveLength(1);
      expect(await token.burnedSupply()).toBe(0n);
      releaseGate();

      await expect(burning).resolves.toMatchObject({ runId, burned: amt('600'), toRewards: amt('400') });
      expect(await burnIfC()).toBe(amt('600'));
      const rows = await sql<Array<{ status: string }>>`SELECT status FROM token.buyback_runs WHERE id = ${runId}`;
      expect(rows[0]?.status).toBe('settled');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * Live svc-token HTTP client throws on getTxByKey — S2S has no such door.
     * Production recordBuyback must still be TokenError, never that throw.
     */
    function s2sShapedLedger(inner: MemoryLedger): LedgerClient {
      return {
        post: inner.post.bind(inner),
        balance: inner.balance.bind(inner),
        balances: inner.balances.bind(inner),
        getTx: async () => {
          throw new Error('getTx is not exposed over the internal ledger API — query svc-ledger directly');
        },
        getTxByKey: async () => {
          throw new Error('getTxByKey is not exposed over the internal ledger API — query svc-ledger directly');
        },
      };
    }

    it('keeps a pending claim if the old fee-funded burn already landed — does not hide it, does not settle', async () => {
      await fundRewards('2000', 'w-claim-orphan-burn');
      const runId = crypto.randomUUID();
      await seedBuybackRun({ runId, window: JULY, status: 'pending' });
      await ledger.post(recipes.burn({ runId, assetId: 'IFC', amount: amt('600'), from: rewardsEngine('IFC') }));
      const burnedAfterPost = await token.burnedSupply();
      expect(burnedAfterPost).toBe(amt('600'));

      await expect(
        token.recordBuyback({
          runId,
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });

      expect(await token.burnedSupply()).toBe(burnedAfterPost);
      const rows = await sql<Array<{ status: string }>>`SELECT status FROM token.buyback_runs WHERE id = ${runId}`;
      expect(rows[0]?.status).toBe('pending');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('live getTxByKey throw on a FRESH run is token.buyback_tokens_unmoved, not a 500 — claim released', async () => {
      const live = new TokenService(sql, s2sShapedLedger(ledger), bus, options);
      const runId = crypto.randomUUID();
      const err = await live
        .recordBuyback({
          runId,
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(TokenError);
      expect((err as TokenError).code).toBe('token.buyback_tokens_unmoved');
      expect((err as Error).message).not.toMatch(/getTxByKey/);
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
    });

    it('live getTxByKey throw on a pending retry stays TokenError — unknown lookup does not hide or settle', async () => {
      const live = new TokenService(sql, s2sShapedLedger(ledger), bus, options);
      const runId = crypto.randomUUID();
      await seedBuybackRun({ runId, window: JULY, status: 'pending' });

      const err = await live
        .recordBuyback({
          runId,
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(TokenError);
      expect((err as TokenError).code).toBe('token.buyback_tokens_unmoved');
      expect((err as Error).message).not.toMatch(/getTxByKey/);
      const rows = await sql<Array<{ status: string }>>`SELECT status FROM token.buyback_runs WHERE id = ${runId}`;
      expect(rows[0]?.status).toBe('pending');
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
    });

    it('does not settle from coincidental engine+burn deltas — this run posted no recipe', async () => {
      const inner = ledger;
      const reads = new Map<string, number>();
      const lying: LedgerClient = {
        post: inner.post.bind(inner),
        balances: inner.balances.bind(inner),
        getTx: inner.getTx.bind(inner),
        getTxByKey: inner.getTxByKey.bind(inner),
        async balance(ref) {
          const real = await inner.balance(ref);
          const n = (reads.get(ref.ownerId) ?? 0) + 1;
          reads.set(ref.ownerId, n);
          // Second engine snapshot looks like +tokensBought arrived. Must not settle.
          if (ref.ownerId === 'rewards-engine' && n >= 2) return { ...real, amount: real.amount + amt('1000') };
          return real;
        },
      };
      const paper = new TokenService(sql, lying, bus, options);
      await expect(
        paper.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: JULY,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ name: 'TokenError', code: 'token.buyback_tokens_unmoved' });
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
    });

    it('refuses to post one run id against another run id’s window, and burns nothing', async () => {
      await fundRewards('4000', 'w-claim-mismatch');

      const runId = crypto.randomUUID();
      await seedBuybackRun({ runId, window: JULY });
      const burnedAfterFirst = await token.burnedSupply();

      // Same run id, different window. Never post the caller's figures against
      // another row's identity (same class as token.stake_conflict).
      await expect(
        token.recordBuyback({
          runId,
          revenueWindow: { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ name: 'TokenError', code: 'token.buyback_run_conflict' });

      expect(formatAmount(await token.burnedSupply())).toBe(formatAmount(burnedAfterFirst));
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(1);
    });

    it('refuses an empty or inverted window by name, before anything is claimed', async () => {
      await fundRewards('2000', 'w-claim-inverted');
      const instant = new Date('2026-07-01T00:00:00Z');

      for (const bad of [
        { from: instant, to: instant },
        { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-07-01T00:00:00Z') },
      ]) {
        await expect(
          token.recordBuyback({
            runId: crypto.randomUUID(),
            revenueWindow: bad,
            revenueTotal: { IFC: '1000' },
            tokensBought: amt('1000'),
          }),
        ).rejects.toMatchObject({ name: 'TokenError', code: 'token.buyback_window_invalid' });
      }

      expect(formatAmount(await token.burnedSupply())).toBe('0');
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
    });
  });

  // ── Buyback: revenueTotal is the audit record, so it must parse ────────────

  describe('buyback revenueTotal validation', () => {
    const WINDOW = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') };

    async function attempt(revenueTotal: Record<string, string>) {
      await accrueFees('trade', '2000');
      await token.distributeRevenue({ windowId: `w-rt-${Math.random()}`, sources: [{ module: 'trade', amount: amt('2000') }] });
      return token.recordBuyback({
        runId: crypto.randomUUID(),
        revenueWindow: WINDOW,
        revenueTotal,
        tokensBought: amt('1000'),
      });
    }

    it.each([
      ['not a number at all', { IFC: 'not-a-number' }],
      ['negative revenue', { IFC: '-999' }],
      ['exponent notation', { BTC: '1e400' }],
      ['more precision than the ledger carries', { IFC: '1.0000000000000000001' }],
      ['an empty asset id', { '': '100' }],
      ['whitespace in the asset id', { 'IF C': '100' }],
      ['a number, not a decimal string (§0.6)', { IFC: 1000 as unknown as string }],
    ])('refuses %s, and burns nothing', async (_label, revenueTotal) => {
      await expect(attempt(revenueTotal)).rejects.toMatchObject({
        name: 'TokenError',
        code: 'token.buyback_revenue_invalid',
      });

      expect(formatAmount(await token.burnedSupply())).toBe('0');
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
    });

    it('accepts one canonical spelling of each amount far enough to refuse unmoved, not revenue_invalid', async () => {
      await expect(attempt({ IFC: '1000.000', USDT: '0.50', BTC: '0' })).rejects.toMatchObject({
        name: 'TokenError',
        code: 'token.buyback_tokens_unmoved',
      });
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect(formatAmount(await token.burnedSupply())).toBe('0');
    });
  });

  // ── Every money method is traced (§14 DoD) ────────────────────────────────
  //
  // `recordBuyback` was the ONLY money method in this service not wrapped in
  // `withMoneySpan` — stake, unstake, distributeRevenue and mintEpoch all were.
  // An untraced burn is an irreversible movement with no span to find it by.
  //
  // The tracer in tracing.ts is resolved at import time, but @opentelemetry/api
  // hands out a proxy that resolves the global provider on each call, so a
  // provider registered here is still seen.

  describe('money-path tracing', () => {
    // Registered exactly ONCE, and never disabled. `trace.disable()` swaps the
    // global proxy provider for a fresh one, which orphans the proxy tracer
    // tracing.ts grabbed at import — after a disable, nothing records again.
    // So the buffer is cleared per test instead of the provider being reset.
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

    const span = {
      setAttribute(k: string, v: unknown) {
        spans[spans.length - 1]!.attributes[k] = v;
        return span;
      },
      setAttributes() {
        return span;
      },
      setStatus() {
        return span;
      },
      recordException() {
        return span;
      },
      addEvent() {
        return span;
      },
      updateName() {
        return span;
      },
      isRecording() {
        return true;
      },
      spanContext() {
        return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 };
      },
      end() {},
    };

    const tracer = {
      startActiveSpan(name: string, ...rest: unknown[]) {
        const fn = rest.find((r) => typeof r === 'function') as (s: unknown) => unknown;
        spans.push({ name, attributes: {} });
        return fn(span);
      },
      startSpan(name: string) {
        spans.push({ name, attributes: {} });
        return span;
      },
    };

    trace.setGlobalTracerProvider({ getTracer: () => tracer } as never);

    beforeEach(() => {
      spans.length = 0;
    });

    afterAll(() => {
      trace.disable();
    });

    it('traces recordBuyback as a money path, like every other money method', async () => {
      await accrueFees('trade', '2000');
      await token.distributeRevenue({ windowId: 'w-trace', sources: [{ module: 'trade', amount: amt('2000') }] });
      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') },
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_tokens_unmoved' });

      const buyback = spans.find((s) => s.name === 'token.recordBuyback');
      expect(buyback, `no token.recordBuyback span — saw ${spans.map((s) => s.name).join(', ')}`).toBeDefined();
      expect(buyback!.attributes['intafaced.money_path']).toBe(true);
      expect(buyback!.attributes['intafaced.operation']).toBe('buyback');
      // Amounts go on spans as decimal STRINGS, never numbers (tracing.ts).
      expect(typeof buyback!.attributes['intafaced.amount']).toBe('string');
      expect(buyback!.attributes['intafaced.error_code']).toBe('token.buyback_tokens_unmoved');
    });

    it('keeps the refusal on the span rather than losing it', async () => {
      const window = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') };

      await accrueFees('trade', '4000');
      await token.distributeRevenue({ windowId: 'w-trace-2', sources: [{ module: 'trade', amount: amt('4000') }] });
      await seedBuybackRun({ runId: crypto.randomUUID(), window });

      await expect(
        token.recordBuyback({
          runId: crypto.randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '1000' },
          tokensBought: amt('1000'),
        }),
      ).rejects.toMatchObject({ code: 'token.buyback_window_overlap' });

      const buyback = spans.find((s) => s.name === 'token.recordBuyback');
      expect(spans.filter((s) => s.name === 'token.recordBuyback')).toHaveLength(1);
      expect(buyback!.attributes['intafaced.error_code']).toBe('token.buyback_window_overlap');
    });
  });

  // ── The economy row itself ────────────────────────────────────────────────
  //
  // `token_params` is the singleton every rate, curve and cap is read from. The
  // service refuses when it is missing rather than falling back to the constants
  // compiled into source — deliberately, because a deployment charging a
  // discount the database does not hold is the exact divergence that refusal was
  // added to close. Three throw sites, and no test named the code.

  describe('a deployment whose token_params row is missing', () => {
    let saved: Array<Record<string, unknown>>;

    beforeEach(async () => {
      saved = await sql<Array<Record<string, unknown>>>`SELECT * FROM token.token_params WHERE id = true`;
      await sql`DELETE FROM token.token_params WHERE id = true`;
    });

    afterEach(async () => {
      await sql`DELETE FROM token.token_params WHERE id = true`;
      if (saved[0]) await sql`INSERT INTO token.token_params ${sql(saved[0] as never)}`;
    });

    const dbToken = () => new TokenService(sql, ledger, bus, { ...options, loadParamsFromDb: true, feeScheduleTtlMs: 0 });

    it('refuses to price a fee discount rather than falling back to the compiled schedule', async () => {
      await expect(dbToken().feeDiscountSchedule()).rejects.toMatchObject({ code: 'token.params_missing' });
    });

    it('refuses to split a buyback rather than inventing the split', async () => {
      await expect(dbToken().buybackParams()).rejects.toMatchObject({ code: 'token.params_missing' });
    });

    it('refuses to mint rather than emitting against a curve nobody configured', async () => {
      await expect(dbToken().mintEpoch(0)).rejects.toMatchObject({ code: 'token.params_missing' });

      const rows = await sql`SELECT epoch FROM token.emission_epochs`;
      expect(rows).toHaveLength(0);
      // Nothing was minted anywhere. `totalsByAsset()` is not the check here:
      // this ledger has never seen IFC at all, so the asset has no key in it —
      // which is a stronger statement than a zero, and asserting '0' against it
      // was this test's own bug on its first CI run.
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('0');
    });
  });

  describe('a deployment whose token_params values are invalid', () => {
    let original: {
      buyback_bps: string;
      burn_split_bps: string;
      total_supply: string;
      halving_interval: number;
      emission_curve: unknown;
    };

    beforeEach(async () => {
      const rows = await sql<
        Array<{
          buyback_bps: string;
          burn_split_bps: string;
          total_supply: string;
          halving_interval: number;
          emission_curve: unknown;
        }>
      >`SELECT buyback_bps::text, burn_split_bps::text, total_supply::text, halving_interval, emission_curve FROM token.token_params WHERE id = true`;
      original = rows[0]!;
    });

    afterEach(async () => {
      await sql`
        UPDATE token.token_params SET
          buyback_bps = ${original.buyback_bps}::numeric,
          burn_split_bps = ${original.burn_split_bps}::numeric,
          total_supply = ${original.total_supply}::numeric,
          halving_interval = ${original.halving_interval},
          emission_curve = ${sql.json(original.emission_curve as never)}
        WHERE id = true
      `;
    });

    const dbToken = () => new TokenService(sql, ledger, bus, { ...options, loadParamsFromDb: true, feeScheduleTtlMs: 0 });

    it('refuses an emission_curve that is not an object before minting', async () => {
      // buyback_bps / halving_interval OOR are sealed by DB CHECK constraints
      // (token_params_buyback_bps_ck, token_params_halving_positive_ck) — the
      // UPDATE itself fails before the service can read. emission_curve is jsonb
      // with no shape CHECK, so the service-layer params_invalid is reachable.
      await sql`
        UPDATE token.token_params SET
          total_supply = 1000,
          halving_interval = 1,
          emission_curve = ${sql.json([] as never)}
        WHERE id = true
      `;
      await expect(dbToken().mintEpoch(0)).rejects.toMatchObject({ code: 'token.params_invalid' });
      const rows = await sql`SELECT epoch FROM token.emission_epochs`;
      expect(rows).toHaveLength(0);
    });

    it('refuses an emission_curve missing initialEpochReward before minting', async () => {
      await sql`
        UPDATE token.token_params SET
          total_supply = 1000,
          halving_interval = 1,
          emission_curve = ${sql.json({ kind: 'halving' } as never)}
        WHERE id = true
      `;
      await expect(dbToken().mintEpoch(0)).rejects.toMatchObject({
        code: 'token.params_unset',
        config: 'token_params.emission_curve.initialEpochReward',
      });
      const rows = await sql`SELECT epoch FROM token.emission_epochs`;
      expect(rows).toHaveLength(0);
    });

    it('refuses a JSON-number initialEpochReward before minting', async () => {
      await sql`
        UPDATE token.token_params SET
          total_supply = 1000,
          halving_interval = 1,
          emission_curve = ${sql.json({ initialEpochReward: 2500 } as never)}
        WHERE id = true
      `;
      await expect(dbToken().mintEpoch(0)).rejects.toMatchObject({ code: 'token.params_invalid' });
      const rows = await sql`SELECT epoch FROM token.emission_epochs`;
      expect(rows).toHaveLength(0);
    });
  });

  // ── Emissions ─────────────────────────────────────────────────────────────

  describe('emissions', () => {
    it('mints an epoch exactly once', async () => {
      const first = await token.mintEpoch(0);
      expect(first.minted).toBeGreaterThan(0n);

      await expect(token.mintEpoch(0)).rejects.toMatchObject({ code: 'token.epoch_closed' });

      const rows = await sql<Array<{ epoch: number; closed: boolean }>>`SELECT epoch, closed FROM token.emission_epochs`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closed).toBe(true);
    });

    it('mints into the destination and keeps the books closed', async () => {
      const { minted } = await token.mintEpoch(0);
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe(formatAmount(minted));
      // Minting creates supply at the treasury boundary — the book still nets to zero.
      expect(ledger.totalsByAsset().IFC).toBe('0');
    });

    it('emits less in a later halving era', async () => {
      const early = await token.mintEpoch(0);
      const later = await token.mintEpoch(DEFAULT_EMISSION_PARAMS.halvingIntervalEpochs);
      expect(later.minted).toBeLessThan(early.minted);
    });

    it('refuses to mint once the schedule is exhausted', async () => {
      // Far enough out that the reward has halved below one unit of precision.
      await expect(token.mintEpoch(10_000_000)).rejects.toMatchObject({ code: 'token.supply_exhausted' });
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE MINT CEILING WAS MEASURED AGAINST A PLAN THAT CAN BE EDITED
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `token.supply_exhausted` is the only thing between a mis-tuned curve and
     * permanent supply inflation, and it had NO test naming it — the one case
     * above asserted `TokenError` and nothing more, and it only ever reached the
     * schedule-exhausted branch.
     *
     * The cap branch was worse than untested. It compares
     * `cumulativeEmission(epoch, params)` — what the CURVE says should have been
     * emitted — against `params.maxSupply`. Both live in `token_params`, which
     * §4.3 hands to governance on purpose and which the README's kill-switch
     * argument assumes can be retuned. Lower the curve after minting under a
     * generous one and the cumulative recomputes small, the cap passes, and more
     * supply is created on top of what is already out. Nothing looked at what had
     * actually been minted.
     */
    describe('against a retuned curve', () => {
      /**
       * These two rewrite the `token_params` singleton, which `beforeEach` does
       * NOT truncate — so they put it back. A suite that leaves the economy row
       * edited is a flake waiting for whoever adds the next test below it.
       */
      let original: { total_supply: string; halving_interval: number; emission_curve: unknown };

      const dbToken = () => new TokenService(sql, ledger, bus, { ...options, loadParamsFromDb: true, feeScheduleTtlMs: 0 });

      const setParams = async (totalSupply: string, initialEpochReward: string) => {
        await sql`
          UPDATE token.token_params
             SET total_supply = ${totalSupply}::numeric, halving_interval = 1000,
                 emission_curve = ${sql.json({ initialEpochReward } as never)}
           WHERE id = true
        `;
      };

      beforeEach(async () => {
        const rows = await sql<Array<typeof original>>`
          SELECT total_supply::text, halving_interval, emission_curve FROM token.token_params WHERE id = true
        `;
        original = rows[0]!;
      });

      afterEach(async () => {
        await sql`
          UPDATE token.token_params
             SET total_supply = ${original.total_supply}::numeric,
                 halving_interval = ${original.halving_interval},
                 emission_curve = ${sql.json(original.emission_curve as never)}
           WHERE id = true
        `;
      });

      it('refuses to mint past the cap after the curve underneath it is retuned down', async () => {
        // A generous curve with a small cap: one epoch takes us to the ceiling.
        await setParams('100', '100');
        const first = await dbToken().mintEpoch(0);
        expect(formatAmount(first.minted)).toBe('100');

        // Now retune the curve DOWN — an operator "fixing" a curve they think
        // was too generous. Under the new curve `cumulativeEmission` for the
        // next epoch is a single unit, which sails past a cap of 100.
        await setParams('100', '1');

        await expect(dbToken().mintEpoch(1)).rejects.toMatchObject({ code: 'token.supply_exhausted' });

        // Nothing was created, and the books still close. Refusing BEFORE the
        // post is the whole point: a mint cannot be taken back.
        const rows = await sql<Array<{ total: string }>>`SELECT COALESCE(SUM(mined_amount), 0) AS total FROM token.emission_epochs`;
        expect(formatAmount(amt(rows[0]!.total))).toBe('100');
        expect(ledger.totalsByAsset().IFC).toBe('0');
      });

      it('refuses to mint past a cap that has been lowered under an already-emitted supply', async () => {
        await setParams('1000', '100');
        await dbToken().mintEpoch(0);
        await dbToken().mintEpoch(1);

        // The cap itself is a `token_params` column. Lowering it below what is
        // already out must stop further minting, not be quietly outvoted by a
        // curve that still thinks there is room.
        await sql`UPDATE token.token_params SET total_supply = 150 WHERE id = true`;

        await expect(dbToken().mintEpoch(2)).rejects.toMatchObject({ code: 'token.supply_exhausted' });
      });
    });

    // TOKEN_ASSET_ID is configurable (env.ts) so a testnet can run its own
    // symbol, but the mint destination defaulted to a hardcoded
    // `rewardsEngine('IFC')` — so such a deployment minted its own symbol into
    // an IFC-keyed account, splitting supply across two accounts nobody
    // reconciles.
    describe('with a deployment running its own symbol', () => {
      const withSymbol = () => new TokenService(sql, ledger, bus, { ...options, assetId: 'TST' });

      it('mints into the CONFIGURED asset’s rewards engine, not IFC', async () => {
        const { minted } = await withSymbol().mintEpoch(0);

        expect(formatAmount((await ledger.balance(rewardsEngine('TST'))).amount)).toBe(formatAmount(minted));
        expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('0');
        expect(ledger.totalsByAsset().TST).toBe('0');
      });

      it('mints the next epoch into the configured asset too', async () => {
        const { minted } = await withSymbol().mintNextEpoch();

        expect(formatAmount((await ledger.balance(rewardsEngine('TST'))).amount)).toBe(formatAmount(minted));
        expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('0');
      });

      it('refuses an explicit destination keyed to another asset', async () => {
        await expect(withSymbol().mintEpoch(0, rewardsEngine('IFC'))).rejects.toMatchObject({
          name: 'TokenError',
          code: 'token.params_invalid',
        });

        expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('0');
        expect(await sql`SELECT epoch FROM token.emission_epochs`).toHaveLength(0);
      });
    });

    describe('emission time gate (one epoch length between NEW epochs, database clock)', () => {
      const DAY = 86_400_000;
      const gated = () => new TokenService(sql, ledger, bus, { ...options, emissionEpochMs: DAY });
      const backdate = (interval: string) =>
        sql.unsafe(`UPDATE token.emission_epochs SET created_at = created_at - interval '${interval}'`);
      const ifc = async () => (await ledger.balance(rewardsEngine('IFC'))).amount;

      it('allows the very first epoch (no previous row)', async () => {
        const first = await gated().mintNextEpoch();
        expect(first.epoch).toBe(0);
        expect(first.minted).toBeGreaterThan(0n);
      });

      it('defaults to one day when no length is passed (gate is ON unless explicitly 0)', async () => {
        const dflt = new TokenService(sql, ledger, bus, { ...options, emissionEpochMs: undefined });
        await dflt.mintNextEpoch();
        await expect(dflt.mintNextEpoch()).rejects.toMatchObject({ code: 'token.epoch_too_early' });
      });

      it('rejects a bad length at construction', () => {
        expect(() => new TokenService(sql, ledger, bus, { ...options, emissionEpochMs: -1 })).toThrow(/emissionEpochMs/);
        expect(() => new TokenService(sql, ledger, bus, { ...options, emissionEpochMs: 1.5 })).toThrow(/emissionEpochMs/);
      });

      it('refuses a second epoch right away with token.epoch_too_early and the time left, and mints nothing', async () => {
        const svc = gated();
        const first = await svc.mintNextEpoch();
        const err = await svc.mintNextEpoch().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(TokenError);
        const te = err as TokenError;
        expect(te.code).toBe('token.epoch_too_early');
        expect(te.message).toMatch(/Epoch 1 cannot start yet/);
        expect(te.message).toMatch(/epoch 0 was claimed/);
        expect(te.message).toMatch(/wait 1d more/);
        expect(te.retryAfterMs).toBeGreaterThan(DAY - 60_000);
        expect(te.retryAfterMs).toBeLessThanOrEqual(DAY);
        // Nothing claimed, nothing minted.
        expect(await sql`SELECT epoch FROM token.emission_epochs`).toHaveLength(1);
        expect(await ifc()).toBe(first.minted);
        expect(await svc.nextEmissionEpoch()).toBe(1);
      });

      it('refuses just short of a day, allows once a day has passed on the database clock', async () => {
        const svc = gated();
        await svc.mintNextEpoch();
        await backdate('23 hours');
        const early = await svc.mintNextEpoch().then(
          () => null,
          (e: unknown) => e as TokenError,
        );
        expect(early?.code).toBe('token.epoch_too_early');
        expect(early?.retryAfterMs).toBeGreaterThan(3_600_000 - 60_000);
        expect(early?.retryAfterMs).toBeLessThanOrEqual(3_600_000);
        expect(early?.message).toMatch(/wait (59m|1h)/);

        await backdate('2 hours'); // now 25h ago
        const second = await svc.mintNextEpoch();
        expect(second.epoch).toBe(1);
        // …and the clock restarts from the new claim.
        await expect(svc.mintNextEpoch()).rejects.toMatchObject({ code: 'token.epoch_too_early' });
      });

      it('the gate reads the newest claim, not the first', async () => {
        const svc = gated();
        await svc.mintNextEpoch();
        await backdate('3 days');
        await svc.mintNextEpoch(); // epoch 1, created now
        await expect(svc.mintNextEpoch()).rejects.toMatchObject({ code: 'token.epoch_too_early' });
      });

      it('resuming a claimed-but-unclosed epoch right away is NOT refused and mints exactly once', async () => {
        const svc = gated();
        const first = await svc.mintNextEpoch();
        await backdate('1 day');

        // Epoch 1: claim commits, the ledger applies the mint, then the reply is lost.
        const realPost = ledger.post.bind(ledger);
        let failOnce = true;
        ledger.post = async (tx) => {
          const result = await realPost(tx);
          if (failOnce) {
            failOnce = false;
            throw new Error('simulated lost reply after ledger apply');
          }
          return result;
        };
        await expect(svc.mintNextEpoch()).rejects.toThrow(/lost reply/);
        ledger.post = realPost;
        const [open] = await sql<Array<{ epoch: number; closed: boolean; scheduled_amount: string }>>`
          SELECT epoch, closed, scheduled_amount FROM token.emission_epochs WHERE epoch = 1
        `;
        expect(open?.closed).toBe(false);

        // Immediate retry — well inside one epoch length of the claim — resumes epoch 1.
        const retried = await svc.mintNextEpoch();
        expect(retried.epoch).toBe(1);
        expect(formatAmount(retried.minted)).toBe(formatAmount(amt(open!.scheduled_amount)));
        expect(await sql`SELECT epoch FROM token.emission_epochs`).toHaveLength(2);
        // One mint per epoch: balance is epoch 0 + epoch 1, not three rewards.
        expect(await ifc()).toBe(first.minted + retried.minted);
        expect(ledger.reconcile()).toEqual({ ok: true });
        // The retry did not restart the clock for a THIRD epoch.
        await expect(svc.mintNextEpoch()).rejects.toMatchObject({ code: 'token.epoch_too_early' });
      });

      it('explicit epoch numbers behave as before: closed is epoch_closed; a skip-ahead is a NEW claim and is gated', async () => {
        const svc = gated();
        await svc.mintEpoch(0);
        await expect(svc.mintEpoch(0)).rejects.toMatchObject({ code: 'token.epoch_closed' });
        await expect(svc.mintEpoch(5)).rejects.toMatchObject({ code: 'token.epoch_too_early' });
        expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 5`).toHaveLength(0);
        await backdate('1 day');
        expect((await svc.mintEpoch(5)).epoch).toBe(5);
      });

      it('supply exhaustion is reported as such, not as "wait"', async () => {
        const svc = gated();
        await svc.mintNextEpoch();
        await expect(svc.mintEpoch(10_000_000)).rejects.toMatchObject({ code: 'token.supply_exhausted' });
      });

      it('two concurrent mints of DIFFERENT new epochs: exactly one lands, the other is epoch_too_early', async () => {
        const a = gated();
        const b = new TokenService(sql, ledger, bus, { ...options, emissionEpochMs: DAY });
        await a.mintNextEpoch();
        await backdate('1 day');
        const results = await Promise.allSettled([a.mintEpoch(1), b.mintEpoch(2)]);
        const ok = results.filter((r) => r.status === 'fulfilled');
        const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(bad).toHaveLength(1);
        expect(bad[0]!.reason).toMatchObject({ code: 'token.epoch_too_early' });
        expect(await sql`SELECT epoch FROM token.emission_epochs`).toHaveLength(2);
        expect(ledger.reconcile()).toEqual({ ok: true });
      });

      it('two concurrent mintNextEpoch both aiming at the next epoch mint it once — no second epoch opens', async () => {
        const a = gated();
        const b = new TokenService(sql, ledger, bus, { ...options, emissionEpochMs: DAY });
        const first = await a.mintNextEpoch();
        await backdate('1 day');
        const results = await Promise.allSettled([a.mintNextEpoch(), b.mintNextEpoch()]);
        const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ epoch: number; minted: bigint }> => r.status === 'fulfilled');
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
        // Every success is epoch 1 (the loser resumes/finds it closed — never opens epoch 2).
        for (const r of results) {
          if (r.status === 'fulfilled') expect(r.value.epoch).toBe(1);
          else expect((r.reason as TokenError).code).toMatch(/^token\.(epoch_closed|epoch_too_early)$/);
        }
        const rows = await sql<Array<{ epoch: number }>>`SELECT epoch FROM token.emission_epochs ORDER BY epoch`;
        expect(rows.map((r) => r.epoch)).toEqual([0, 1]);
        // Exactly two epochs' worth of supply.
        expect(await ifc()).toBe(first.minted + fulfilled[0]!.value.minted);
      });

      it('a retuned reward does not bypass the gate or change the resumed amount', async () => {
        const svc = gated();
        await svc.mintNextEpoch();
        const other = new TokenService(sql, ledger, bus, {
          ...options,
          emissionEpochMs: DAY,
          emission: { ...DEFAULT_EMISSION_PARAMS, initialEpochReward: amt('1') },
        });
        await expect(other.mintNextEpoch()).rejects.toMatchObject({ code: 'token.epoch_too_early' });
      });
    });

    it('mintNextEpoch walks the sequence and nextEmissionEpoch advances', async () => {
      expect(await token.nextEmissionEpoch()).toBe(0);

      const first = await token.mintNextEpoch();
      expect(first.epoch).toBe(0);
      expect(first.minted).toBeGreaterThan(0n);
      expect(await token.nextEmissionEpoch()).toBe(1);

      const second = await token.mintNextEpoch();
      expect(second.epoch).toBe(1);
      expect(await token.nextEmissionEpoch()).toBe(2);

      // Both epochs closed exactly once; books still close.
      const rows = await sql<Array<{ epoch: number }>>`SELECT epoch FROM token.emission_epochs ORDER BY epoch`;
      expect(rows.map((r) => r.epoch)).toEqual([0, 1]);
      expect(ledger.totalsByAsset().IFC).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('mintNextEpoch fails closed when the current epoch was already closed by mintEpoch', async () => {
      await token.mintEpoch(0);
      // next is 1 — not a re-mint of 0.
      const next = await token.mintNextEpoch();
      expect(next.epoch).toBe(1);
      await expect(token.mintEpoch(1)).rejects.toMatchObject({ code: 'token.epoch_closed' });
    });

    it('resumes an open claim with the snapshotted reward after a crash mid-flight', async () => {
      // Simulate: claim written, ledger post happened, close never ran.
      const reward = DEFAULT_EMISSION_PARAMS.initialEpochReward;
      await sql`
        INSERT INTO token.emission_epochs (epoch, scheduled_amount, mined_amount, closed)
        VALUES (0, ${formatAmount(reward)}::numeric, ${formatAmount(reward)}::numeric, false)
      `;
      await ledger.post(recipes.mintEmission({ epoch: 0, assetId: 'IFC', amount: reward, destination: rewardsEngine('IFC') }));

      // Retune would change epochReward(0) if we recomputed — prove we do not.
      const resumed = await token.mintEpoch(0);
      expect(resumed.minted).toBe(reward);

      const rows = await sql<Array<{ closed: boolean; mined_amount: string; scheduled_amount: string }>>`
        SELECT closed, mined_amount, scheduled_amount FROM token.emission_epochs WHERE epoch = 0
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.closed).toBe(true);
      expect(amt(rows[0]!.mined_amount)).toBe(reward);
      expect(amt(rows[0]!.scheduled_amount)).toBe(reward);
      // Ledger post was idempotent — balance is one reward, not two.
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe(formatAmount(reward));
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('open claim reserves supply so a concurrent epoch cannot under-book the ceiling', async () => {
      // Claim epoch 0 open at full reward without closing — ceiling must count it.
      const reward = DEFAULT_EMISSION_PARAMS.initialEpochReward;
      await sql`
        INSERT INTO token.emission_epochs (epoch, scheduled_amount, mined_amount, closed)
        VALUES (0, ${formatAmount(reward)}::numeric, ${formatAmount(reward)}::numeric, false)
      `;

      // Cap equals one epoch reward. Epoch 1 must refuse even though 0 is not closed.
      const tight = new TokenService(sql, ledger, bus, {
        ...options,
        emission: { ...DEFAULT_EMISSION_PARAMS, maxSupply: reward },
      });
      await expect(tight.mintEpoch(1)).rejects.toMatchObject({ code: 'token.supply_exhausted' });
      expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 1`).toHaveLength(0);
    });

    it('keeps a mint that timed out after applying in the mined sum so the next epoch cannot pass maxSupply', async () => {
      // Cap equals one epoch. The post applies, then the client times out.
      // Deleting the open claim drops that supply out of SUM(mined_amount).
      // cumulativeEmission is clamped to the cap, so the curve check does not
      // save the next epoch — only the mined sum does.
      const cap = amt('100');
      const tight = new TokenService(sql, ledger, bus, {
        ...options,
        emission: { initialEpochReward: cap, halvingIntervalEpochs: 1000, maxSupply: cap },
      });

      const realPost = ledger.post.bind(ledger);
      ledger.post = async (tx) => {
        const result = await realPost(tx);
        const isMint = typeof tx === 'object' && tx !== null && 'reason' in tx && (tx as { reason?: string }).reason === 'token.emission';
        if (isMint) throw new Error('simulated timeout after ledger apply');
        return result;
      };

      await expect(tight.mintEpoch(0)).rejects.toThrow(/timeout after ledger apply/);

      const summed = await sql<Array<{ total: string }>>`
        SELECT COALESCE(SUM(mined_amount), 0) AS total FROM token.emission_epochs
      `;
      expect(formatAmount(amt(summed[0]!.total))).toBe('100');
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('100');

      ledger.post = realPost;
      await expect(tight.mintEpoch(1)).rejects.toMatchObject({ code: 'token.supply_exhausted' });
      expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('100');
      expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 1`).toHaveLength(0);
    });

    it('keeps the claim on an unclassified structured server error', async () => {
      const tight = new TokenService(sql, ledger, bus, {
        ...options,
        emission: { initialEpochReward: amt('100'), halvingIntervalEpochs: 1000, maxSupply: amt('100') },
      });
      const realPost = ledger.post.bind(ledger);
      ledger.post = async () => {
        // The HTTP adapter rehydrates structured 5xx bodies as LedgerError.
        // An unrecognized code does not prove the transaction stayed unapplied.
        throw new LedgerError('ledger returned an unexpected server failure', 'ledger.post_internal');
      };

      await expect(tight.mintEpoch(0)).rejects.toMatchObject({ code: 'ledger.post_internal' });
      const rows = await sql<Array<{ closed: boolean; mined_amount: string; scheduled_amount: string }>>`
        SELECT closed, mined_amount, scheduled_amount FROM token.emission_epochs WHERE epoch = 0
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        closed: false,
        mined_amount: '100.000000000000000000',
        scheduled_amount: '100.000000000000000000',
      });

      ledger.post = realPost;
      const resumed = await tight.mintEpoch(0);
      expect(resumed.minted).toBe(amt('100'));
      expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 0 AND closed = true`).toHaveLength(1);
    });

    it('keeps a mint claim after a typed pre-effect validation refusal', async () => {
      const tight = new TokenService(sql, ledger, bus, {
        ...options,
        emission: { initialEpochReward: amt('100'), halvingIntervalEpochs: 1000, maxSupply: amt('100') },
      });
      const realPost = ledger.post.bind(ledger);
      ledger.post = async () => {
        throw new LedgerError('invalid ledger entry', 'ledger.invalid_entry');
      };

      await expect(tight.mintEpoch(0)).rejects.toMatchObject({ code: 'ledger.invalid_entry' });
      expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 0 AND closed = false`).toHaveLength(1);

      ledger.post = realPost;
      const retry = await tight.mintEpoch(0);
      expect(retry.minted).toBe(amt('100'));
      expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 0 AND closed = true`).toHaveLength(1);
    });

    it('absorbs one lost response inside the client: the retry replays the same key and the mint lands once', async () => {
      const cap = amt('100');
      const tight = new TokenService(sql, createLedgerClient('http://ledger.test', 'fixture-secret-for-token-recovery-test'), bus, {
        ...options,
        emission: { initialEpochReward: cap, halvingIntervalEpochs: 1000, maxSupply: cap },
      });
      const nativeFetch = globalThis.fetch;
      const keys: string[] = [];
      let requests = 0;
      globalThis.fetch = async (_input, init) => {
        requests += 1;
        const body = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
          module: string;
          reason: string;
          meta: Record<string, unknown>;
          entries: Array<{ account: PostRequest['entries'][number]['account']; direction: 'debit' | 'credit'; amount: string }>;
        };
        keys.push(body.idempotencyKey);
        const tx = await ledger.post({
          idempotencyKey: body.idempotencyKey,
          module: body.module,
          reason: body.reason,
          meta: body.meta,
          entries: body.entries.map((entry) => ({ ...entry, amount: amt(entry.amount) })),
        });
        if (requests === 1) throw new TypeError('simulated socket close after commit');
        return new Response(JSON.stringify({ txId: tx.id, hash: tx.hash, postedAt: tx.postedAt.toISOString() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        const minted = await tight.mintEpoch(0);
        expect(minted.minted).toBe(cap);
        // Two attempts, one key: the emission key is what makes the retry safe.
        expect(requests).toBe(2);
        expect(new Set(keys)).toEqual(new Set(['token.emission:IFC:0']));
        expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 0 AND closed = true`).toHaveLength(1);
        // Minted once, not twice.
        expect(await ledger.balance(rewardsEngine('IFC'))).toMatchObject({ amount: cap });
        expect(ledger.reconcile()).toEqual({ ok: true });
      } finally {
        globalThis.fetch = nativeFetch;
      }
    });

    it('recovers a mint when the ledger commits and the HTTP response is lost on every attempt', async () => {
      const cap = amt('100');
      const tight = new TokenService(sql, createLedgerClient('http://ledger.test', 'fixture-secret-for-token-recovery-test'), bus, {
        ...options,
        emission: { initialEpochReward: cap, halvingIntervalEpochs: 1000, maxSupply: cap },
      });
      const nativeFetch = globalThis.fetch;
      // The client retries a network error twice, so the first call loses all three of its responses.
      let lostResponses = 3;
      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
          module: string;
          reason: string;
          meta: Record<string, unknown>;
          entries: Array<{ account: PostRequest['entries'][number]['account']; direction: 'debit' | 'credit'; amount: string }>;
        };
        const tx = await ledger.post({
          idempotencyKey: body.idempotencyKey,
          module: body.module,
          reason: body.reason,
          meta: body.meta,
          entries: body.entries.map((entry) => ({ ...entry, amount: amt(entry.amount) })),
        });
        if (lostResponses > 0) {
          lostResponses -= 1;
          throw new TypeError('simulated socket close after commit');
        }
        return new Response(JSON.stringify({ txId: tx.id, hash: tx.hash, postedAt: tx.postedAt.toISOString() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        await expect(tight.mintEpoch(0)).rejects.toThrow(/socket close after commit/);
        expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 0 AND closed = false`).toHaveLength(1);
        expect(await ledger.balance(rewardsEngine('IFC'))).toMatchObject({ amount: cap });

        const recovered = await tight.mintEpoch(0);
        expect(recovered.minted).toBe(cap);
        expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 0 AND closed = true`).toHaveLength(1);
        expect(await ledger.balance(rewardsEngine('IFC'))).toMatchObject({ amount: cap });
      } finally {
        globalThis.fetch = nativeFetch;
      }
    });

    it('keeps committed emission reserved when a later retry is rejected before ledger idempotency lookup', async () => {
      const cap = amt('100');
      const tight = new TokenService(sql, createLedgerClient('http://ledger.test', 'fixture-secret-for-token-recovery-test'), bus, {
        ...options,
        emission: { initialEpochReward: cap, halvingIntervalEpochs: 1000, maxSupply: cap },
      });
      const nativeFetch = globalThis.fetch;
      let requestCount = 0;
      let unauthenticatedRetry = true;
      globalThis.fetch = async (_input, init) => {
        requestCount += 1;
        // Requests 1-3 are the first call's three attempts (a lost response each); request 4 is the next call, refused.
        if (unauthenticatedRetry && requestCount === 4) {
          return new Response(JSON.stringify({ message: 'missing service identity', code: 'ledger.unauthenticated' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }

        const body = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
          module: string;
          reason: string;
          meta: Record<string, unknown>;
          entries: Array<{ account: PostRequest['entries'][number]['account']; direction: 'debit' | 'credit'; amount: string }>;
        };
        const tx = await ledger.post({
          idempotencyKey: body.idempotencyKey,
          module: body.module,
          reason: body.reason,
          meta: body.meta,
          entries: body.entries.map((entry) => ({ ...entry, amount: amt(entry.amount) })),
        });
        if (requestCount <= 3) throw new TypeError('simulated socket close after commit');
        return new Response(JSON.stringify({ txId: tx.id, hash: tx.hash, postedAt: tx.postedAt.toISOString() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        await expect(tight.mintEpoch(0)).rejects.toThrow(/socket close after commit/);
        await expect(tight.mintEpoch(0)).rejects.toMatchObject({ code: 'ledger.unauthenticated' });
        expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 0 AND closed = false`).toHaveLength(1);
        expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('100');

        await expect(tight.mintEpoch(1)).rejects.toMatchObject({ code: 'token.supply_exhausted' });
        expect(requestCount).toBe(4);

        unauthenticatedRetry = false;
        const recovered = await tight.mintEpoch(0);
        expect(recovered.minted).toBe(cap);
        expect(await sql`SELECT epoch FROM token.emission_epochs WHERE epoch = 0 AND closed = true`).toHaveLength(1);
        await expect(tight.mintEpoch(1)).rejects.toMatchObject({ code: 'token.supply_exhausted' });
        expect(requestCount).toBe(5);
        expect(formatAmount((await ledger.balance(rewardsEngine('IFC'))).amount)).toBe('100');
        expect(ledger.reconcile()).toEqual({ ok: true });
      } finally {
        globalThis.fetch = nativeFetch;
      }
    });
  });

  // ── Governance (§4.3) ─────────────────────────────────────────────────────

  describe('governance — proposals and IFC-weighted voting', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const opensAt = new Date('2026-07-15T00:00:00.000Z');
    const closesAt = new Date('2026-07-22T00:00:00.000Z');

    // Published TEST rule so these cases still exercise voting. Not a product default.
    let proposalHandle = 0;
    const propose = (service: TokenService, input: Omit<Parameters<TokenService['createProposal']>[0], 'handle'> & { handle?: string }) => {
      proposalHandle += 1;
      return service.createProposal({ ...input, handle: input.handle ?? `ballot-${proposalHandle}` });
    };
    beforeEach(async () => {
      proposalHandle = 0;
      await sql`
        UPDATE token.governance_proposer
           SET kind = 'stake',
               min_stake = '1000'::numeric,
               accounts = NULL,
               period_limit = 100,
               period_ms = ${7 * 86_400_000}
         WHERE id = true
      `;
    });

    it('lets a staked-tier holder open a proposal', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      const proposal = await propose(token, {
        kind: 'fee_param',
        body: { buybackBps: 1500 },
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });

      expect(proposal.status).toBe('open');
      expect(proposal.kind).toBe('fee_param');
      expect(proposal.body).toMatchObject({ buybackBps: 1500 });
    });

    it('refuses a zero-stake non-admin proposal', async () => {
      await expect(
        propose(token, {
          kind: 'listing',
          body: { symbol: 'X' },
          createdBy: USER_A,
          opensAt,
          closesAt,
          now,
        }),
      ).rejects.toMatchObject({ code: 'token.proposal_not_allowed' });
    });

    it('refuses a stake just below the Initiate threshold', async () => {
      await fund(USER_A, '999');
      await token.stake({ userId: USER_A, amount: amt('999'), tier: 'flex', stakeId: crypto.randomUUID() });
      await expect(
        propose(token, {
          kind: 'listing',
          body: { symbol: 'X' },
          createdBy: USER_A,
          opensAt,
          closesAt,
          now,
        }),
      ).rejects.toMatchObject({ code: 'token.proposal_not_allowed' });
    });

    it('refuses a proposal window that does not close after it opens', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await expect(
        propose(token, {
          kind: 'fee_param',
          body: {},
          createdBy: USER_A,
          opensAt: closesAt,
          closesAt: opensAt,
          now,
        }),
      ).rejects.toMatchObject({ code: 'token.proposal_window' });
    });

    it('allows a vote AT opensAt and refuses AT closesAt (half-open window)', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'curriculum',
        body: {},
        createdBy: USER_A,
        opensAt,
        closesAt,
        now: opensAt,
      });

      const atOpen = await token.castVote({
        signature: TEST_VOTE_SIGNATURE,
        proposalId: proposal.id,
        userId: USER_A,
        choice: 'for',
        now: opensAt,
      });
      expect(formatAmount(atOpen.weight)).toBe('1000');

      await fund(USER_B, '1000');
      await token.stake({ userId: USER_B, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await expect(
        token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_B, choice: 'against', now: closesAt }),
      ).rejects.toMatchObject({ code: 'token.proposal_window' });
    });

    it('survives concurrent double-votes — one ballot, one success', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'listing',
        body: {},
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          token
            .castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now })
            .then(() => 'ok' as const)
            .catch((err: { code?: string }) => (err?.code === 'token.already_voted' ? 'voted' : 'other')),
        ),
      );

      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'voted')).toHaveLength(7);
      const detail = await token.getProposal(proposal.id);
      expect(detail.tally.voterCount).toBe(1);
    });

    it('lets admin open a proposal without stake', async () => {
      const proposal = await propose(token, {
        kind: 'grant',
        body: { amount: '1' },
        createdBy: USER_A,
        asAdmin: true,
        opensAt,
        closesAt,
        now,
      });
      expect(proposal.status).toBe('open');
    });

    it('snapshots stakeOf as vote weight and tallies by choice', async () => {
      await fund(USER_A, '5000');
      await fund(USER_B, '2000');
      await token.stake({ userId: USER_A, amount: amt('5000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('2000'), tier: 'flex', stakeId: crypto.randomUUID() });

      const proposal = await propose(token, {
        kind: 'curriculum',
        body: { title: 'Core path' },
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });

      const aVote = await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });
      const bVote = await token.castVote({
        signature: TEST_VOTE_SIGNATURE,
        proposalId: proposal.id,
        userId: USER_B,
        choice: 'against',
        now,
      });

      expect(formatAmount(aVote.weight)).toBe('5000');
      expect(formatAmount(bVote.weight)).toBe('2000');

      // Unstake after voting must not rewrite the snapshotted weight.
      await token.unstake((await sql<Array<{ id: string }>>`SELECT id FROM token.stakes WHERE user_id = ${USER_A} LIMIT 1`)[0]!.id);
      expect(formatAmount(await token.stakeOf(USER_A))).toBe('0');

      const detail = await token.getProposal(proposal.id);
      expect(formatAmount(detail.tally.forWeight)).toBe('5000');
      expect(formatAmount(detail.tally.againstWeight)).toBe('2000');
      expect(formatAmount(detail.tally.totalWeight)).toBe('7000');
      expect(detail.tally.voterCount).toBe(2);
    });

    // The fold ASSIGNED weight (`forWeight = w`) while `voterCount` in the same
    // loop accumulated — two idioms in one loop, indistinguishable from outside
    // only because `GROUP BY choice` happens to return each choice once. That is
    // exactly why the fold is exported: with one row per choice no black-box
    // test can tell `=` from `+=`, so the bug had nowhere to fail.
    describe('tally fold', () => {
      it('accumulates weight across repeated rows for a choice', () => {
        const tally = foldTally([
          { choice: 'for', weight: '100', n: '1' },
          { choice: 'for', weight: '250', n: '2' },
          { choice: 'against', weight: '30', n: '1' },
          { choice: 'against', weight: '70', n: '3' },
          { choice: 'abstain', weight: '5', n: '1' },
          { choice: 'abstain', weight: '15', n: '1' },
        ]);

        // Under assignment these would be the LAST row of each group —
        // 250 / 70 / 15 — and 415 of the 470 cast would vanish.
        expect(formatAmount(tally.forWeight)).toBe('350');
        expect(formatAmount(tally.againstWeight)).toBe('100');
        expect(formatAmount(tally.abstainWeight)).toBe('20');
        expect(tally.voterCount).toBe(9);
      });

      it('counts weight and voters by the same rule', () => {
        const rows = [
          { choice: 'for' as const, weight: '10', n: '1' },
          { choice: 'for' as const, weight: '10', n: '1' },
        ];
        const tally = foldTally(rows);

        // The original loop accumulated voterCount and assigned weight, so these
        // two disagreed about how many rows existed.
        expect(tally.voterCount).toBe(2);
        expect(formatAmount(tally.forWeight)).toBe('20');
      });

      it('is empty for no votes', () => {
        const tally = foldTally([]);
        expect(formatAmount(tally.forWeight)).toBe('0');
        expect(tally.voterCount).toBe(0);
      });
    });

    it('refuses a second ballot from the same user', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'listing',
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });

      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });
      await expect(
        token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'against', now }),
      ).rejects.toMatchObject({
        code: 'token.already_voted',
      });
    });

    it('refuses a vote with zero stake', async () => {
      const proposal = await propose(token, {
        kind: 'grant',
        createdBy: USER_A,
        asAdmin: true,
        opensAt,
        closesAt,
        now,
      });

      await expect(
        token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_B, choice: 'for', now }),
      ).rejects.toMatchObject({
        code: 'token.no_voting_weight',
      });
    });

    it('refuses votes outside the window or on a non-open proposal', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      const future = await propose(token, {
        kind: 'listing',
        createdBy: USER_A,
        opensAt: new Date('2026-08-01T00:00:00.000Z'),
        closesAt: new Date('2026-08-08T00:00:00.000Z'),
        now,
      });
      expect(future.status).toBe('draft');
      await expect(
        token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: future.id, userId: USER_A, choice: 'for', now }),
      ).rejects.toMatchObject({
        code: 'token.proposal_not_open',
      });

      const open = await propose(token, {
        kind: 'listing',
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      const afterClose = new Date('2026-07-23T00:00:00.000Z');
      await expect(
        token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: open.id, userId: USER_A, choice: 'for', now: afterClose }),
      ).rejects.toMatchObject({
        code: 'token.proposal_window',
      });
    });

    it('draft stays terminal after opensAt — no silent open, no vote (socket honesty)', async () => {
      // §13 token.governance: draft is not a deferred open. Time passing must
      // not invent a status flip the service never wrote.
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      const draft = await propose(token, {
        kind: 'fee_param',
        body: { buybackBps: 1200 },
        createdBy: USER_A,
        opensAt: new Date('2026-08-01T00:00:00.000Z'),
        closesAt: new Date('2026-08-15T00:00:00.000Z'),
        now, // 2026-07-15 — window still in the future
      });
      expect(draft.status).toBe('draft');

      const afterOpen = new Date('2026-08-05T12:00:00.000Z');
      const reloaded = await token.getProposal(draft.id);
      expect(reloaded?.status).toBe('draft');
      await expect(
        token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: draft.id, userId: USER_A, choice: 'for', now: afterOpen }),
      ).rejects.toMatchObject({
        code: 'token.proposal_not_open',
      });

      const listed = await token.listProposals({ status: 'draft', limit: 50 });
      expect(listed.some((p) => p.id === draft.id)).toBe(true);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * A refusal nothing executes is a refusal nobody has checked still fires.
     * `token.proposal_not_found` had two throw sites and no test naming it —
     * the same shape as `token.supply_exhausted`, which turned out to be
     * guarding the wrong number (#1083).
     */
    it('refuses to vote on a proposal that does not exist, rather than recording a ballot against nothing', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const missing = '00000000-0000-4000-8000-0000000000ff';

      await expect(
        token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: missing, userId: USER_A, choice: 'for', now }),
      ).rejects.toMatchObject({
        code: 'token.proposal_not_found',
      });

      const votes = await sql`SELECT id FROM token.governance_votes`;
      expect(votes).toHaveLength(0);
    });

    it('reports an unknown proposal rather than an empty tally', async () => {
      // The dangerous alternative is a zero tally, which reads as "nobody
      // voted" for a proposal that was never opened.
      await expect(token.getProposal('00000000-0000-4000-8000-0000000000fe')).rejects.toMatchObject({
        code: 'token.proposal_not_found',
      });
    });

    it('lists proposals filtered by status and kind', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      await propose(token, { kind: 'listing', createdBy: USER_A, opensAt, closesAt, now });
      await propose(token, { kind: 'grant', createdBy: USER_A, opensAt, closesAt, now });
      await propose(token, {
        kind: 'listing',
        createdBy: USER_A,
        opensAt: new Date('2026-08-01T00:00:00.000Z'),
        closesAt: new Date('2026-08-08T00:00:00.000Z'),
        now,
      });

      const open = await token.listProposals({ status: 'open', limit: 50 });
      expect(open).toHaveLength(2);
      const listings = await token.listProposals({ kind: 'listing', limit: 50 });
      expect(listings).toHaveLength(2);
      const openListings = await token.listProposals({ status: 'open', kind: 'listing', limit: 50 });
      expect(openListings).toHaveLength(1);
    });

    it('refuses listProposals without limit — never invents 50', async () => {
      await expect(token.listProposals()).rejects.toMatchObject({ code: 'token.proposal_list_limit_unset' });
      await expect(token.listProposals({})).rejects.toMatchObject({ code: 'token.proposal_list_limit_unset' });
      await expect(token.listProposals({ status: 'open' })).rejects.toMatchObject({ code: 'token.proposal_list_limit_unset' });
      expect(assertProposalListLimit(50)).toBe(50);
      expect(await token.listProposals({ limit: 50 })).toEqual([]);
    });

    it('moves no ledger value when proposing or voting', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const availableBefore = await balanceOf(USER_A);
      const stakedBefore = await stakedOf(USER_A);

      const proposal = await propose(token, {
        kind: 'fee_param',
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'abstain', now });

      expect(await balanceOf(USER_A)).toBe(availableBefore);
      expect(await stakedOf(USER_A)).toBe(stakedBefore);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('close writes passed when quorum and for-threshold hold', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'fee_param',
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });

      const closed = await token.closeProposal({
        proposalId: proposal.id,
        now: closesAt,
      });
      expect(closed.status).toBe('passed');
      expect(closed.execute).toBeNull();
      expect((await token.getProposal(proposal.id)).status).toBe('passed');
    });

    it('close writes rejected when against wins', async () => {
      await fund(USER_A, '400');
      await fund(USER_B, '600');
      await token.stake({ userId: USER_A, amount: amt('400'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('600'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'curriculum',
        createdBy: USER_A,
        asAdmin: true,
        opensAt,
        closesAt,
        now,
      });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_B, choice: 'against', now });

      const closed = await token.closeProposal({ proposalId: proposal.id, now: closesAt });
      expect(closed.status).toBe('rejected');
    });

    it('close writes rejected when quorum fails even if every ballot is for', async () => {
      await fund(USER_A, '1000');
      await fund(USER_B, '99');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('99'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'fee_param',
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_B, choice: 'for', now });

      const closed = await token.closeProposal({ proposalId: proposal.id, now: closesAt });
      expect(closed.status).toBe('rejected');
    });

    it('closes against the stake snapshotted on the ballot, not live pots', async () => {
      // 10% quorum. 100 of 10100 misses. Unstaking the other 10000 leaves a
      // live pot of 100, which would clear that same ballot.
      await fund(USER_A, '100');
      await fund(USER_B, '10000');
      await token.stake({ userId: USER_A, amount: amt('100'), tier: 'flex', stakeId: crypto.randomUUID() });
      const bStake = await token.stake({ userId: USER_B, amount: amt('10000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const missed = await propose(token, {
        kind: 'fee_param',
        createdBy: USER_A,
        asAdmin: true,
        opensAt,
        closesAt,
        now,
      });
      const smallVote = await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: missed.id, userId: USER_A, choice: 'for', now });
      expect(formatAmount(smallVote.weight)).toBe('100');

      await token.unstake(bStake.id);
      expect(formatAmount(await token.stakeOf(USER_B))).toBe('0');
      const kept = await token.getProposal(missed.id);
      expect(formatAmount(kept.tally.forWeight)).toBe('100');
      const snap = await sql<Array<{ eligible_stake: string }>>`
        SELECT eligible_stake FROM token.governance_votes WHERE proposal_id = ${missed.id}
      `;
      expect(formatAmount(amt(snap[0]!.eligible_stake))).toBe('10100');

      const shrunk = await token.closeProposal({ proposalId: missed.id, now: closesAt });
      expect(shrunk.status).toBe('rejected');
      expect(formatAmount(shrunk.tally.forWeight)).toBe('100');

      // Stake opened after the window must not raise the bar. The ballot was
      // 1000 of 1000. A later 10000 pot would put 10% at 1100 and reject it.
      await token.unstake((await sql<Array<{ id: string }>>`SELECT id FROM token.stakes WHERE user_id = ${USER_A}`)[0]!.id);
      await fund(USER_C, '1000');
      await token.stake({ userId: USER_C, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const held = await propose(token, {
        kind: 'curriculum',
        createdBy: USER_C,
        opensAt,
        closesAt,
        now,
      });
      const heldVote = await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: held.id, userId: USER_C, choice: 'for', now });
      expect(formatAmount(heldVote.weight)).toBe('1000');
      await token.stake({ userId: USER_B, amount: amt('10000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const heldSnap = await sql<Array<{ eligible_stake: string }>>`
        SELECT eligible_stake FROM token.governance_votes WHERE proposal_id = ${held.id}
      `;
      expect(formatAmount(amt(heldSnap[0]!.eligible_stake))).toBe('1000');

      const inflated = await token.closeProposal({ proposalId: held.id, now: closesAt });
      expect(inflated.status).toBe('passed');
      expect(formatAmount(inflated.tally.forWeight)).toBe('1000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses close when quorum/threshold env is blank — never invents a bar', async () => {
      const unset = new TokenService(sql, ledger, bus, {
        ...options,
        governanceQuorumBps: undefined,
        governanceThresholdBps: undefined,
      });
      await fund(USER_A, '1000');
      await unset.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(unset, {
        kind: 'fee_param',
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      await unset.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });

      await expect(unset.closeProposal({ proposalId: proposal.id, now: closesAt })).rejects.toMatchObject({
        code: 'token.governance_quorum_unset',
      });
      expect((await unset.getProposal(proposal.id)).status).toBe('open');
    });

    it('grant close writes passed|rejected and names execute unwired — no value moved', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const availableBefore = await balanceOf(USER_A);
      const stakedBefore = await stakedOf(USER_A);
      const postsBefore = ledger.journal().length;

      const proposal = await propose(token, {
        kind: 'grant',
        body: { amount: '999' },
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });

      const closed = await token.closeProposal({ proposalId: proposal.id, now: closesAt });
      expect(closed.status).toBe('passed');
      expect(closed.execute).toBe('token.governance_execute_unwired');
      expect(await balanceOf(USER_A)).toBe(availableBefore);
      expect(await stakedOf(USER_A)).toBe(stakedBefore);
      expect(ledger.journal().length).toBe(postsBefore);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('listing close names execute unwired and does not open a market', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'listing',
        body: { symbol: 'X' },
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });
      const closed = await token.closeProposal({ proposalId: proposal.id, now: closesAt });
      expect(closed.status).toBe('passed');
      expect(closed.execute).toBe('token.governance_execute_unwired');
    });

    it('refuses closeProposal when an active row disagrees with the ledger pot', async () => {
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'fee_param',
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });

      await sql`UPDATE token.stakes SET amount = ${'10000'}::numeric WHERE id = ${stake.id}`;

      await expect(token.closeProposal({ proposalId: proposal.id, now: closesAt })).rejects.toMatchObject({
        code: 'token.stake_ledger_mismatch',
      });
      expect((await token.getProposal(proposal.id)).status).toBe('open');
      expect(await stakedOf(USER_A)).toBe('1000');
    });

    it('refuses close before the window ends, and refuses a second close', async () => {
      await fund(USER_A, '1000');
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      const proposal = await propose(token, {
        kind: 'fee_param',
        createdBy: USER_A,
        opensAt,
        closesAt,
        now,
      });
      await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: USER_A, choice: 'for', now });

      await expect(token.closeProposal({ proposalId: proposal.id, now })).rejects.toMatchObject({
        code: 'token.proposal_window',
      });
      expect((await token.getProposal(proposal.id)).status).toBe('open');

      await token.closeProposal({ proposalId: proposal.id, now: closesAt });
      await expect(token.closeProposal({ proposalId: proposal.id, now: closesAt })).rejects.toMatchObject({
        code: 'token.proposal_not_open',
      });
    });
  });

  // ── Doctrine ──────────────────────────────────────────────────────────────

  describe('doctrine §0.6 — no balance outside the ledger', () => {
    it('every stake in the table is backed by ledger value', async () => {
      await fund(USER_A, '10000');
      await fund(USER_B, '5000');
      await token.stake({ userId: USER_A, amount: amt('4000'), tier: 'm12', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('5000'), tier: 'm3', stakeId: crypto.randomUUID() });

      // The two independent answers to "how much is staked" must agree. That
      // they CAN be compared is the point of keeping value in the ledger and
      // only metadata here.
      const fromTable = formatAmount((await token.stakeOf(USER_A)) + (await token.stakeOf(USER_B)));
      const fromLedger = formatAmount(amt(await stakedOf(USER_A)) + amt(await stakedOf(USER_B)));

      expect(fromTable).toBe(fromLedger);
      expect(fromTable).toBe('10000');
    });

    it('sum of active stakes equals ledger stake accounts (drift refuses the property)', async () => {
      // A2 residual: active rows are the only stakeOf input; their principals
      // must equal the ledger stake pots for those users. Pending and closed
      // rows must not invent a second total.
      await fund(USER_A, '8000');
      await fund(USER_B, '3000');
      const a1 = await token.stake({ userId: USER_A, amount: amt('2000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_A, amount: amt('3000'), tier: 'm3', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_B, amount: amt('3000'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.unstake(a1.id);

      const activeRows = await sql<Array<{ amount: string }>>`
        SELECT amount FROM token.stakes WHERE status = 'active' ORDER BY id
      `;
      const fromTable = activeRows.reduce((acc, r) => acc + amt(r.amount), 0n);
      const fromStakeOf = (await token.stakeOf(USER_A)) + (await token.stakeOf(USER_B));
      const fromLedger = amt(await stakedOf(USER_A)) + amt(await stakedOf(USER_B));

      expect(formatAmount(fromTable)).toBe(formatAmount(fromStakeOf));
      expect(formatAmount(fromTable)).toBe(formatAmount(fromLedger));
      expect(formatAmount(fromTable)).toBe('6000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses stakeOf/accessOf when the table disagrees with the ledger pot', async () => {
      // Inflating the row used to raise feeDiscountBps off a number the book
      // does not hold. Gate on the pot; drift refuses closed.
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });
      expect(formatAmount(await token.stakeOf(USER_A))).toBe('1000');
      await publishFeeSchedule();
      const agreed = await token.accessOf(USER_A);
      expect(formatAmount(agreed.staked)).toBe('1000');

      await sql`UPDATE token.stakes SET amount = ${'10000'}::numeric WHERE id = ${stake.id}`;

      await expect(token.stakeOf(USER_A)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });
      await expect(token.accessOf(USER_A)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });
      expect(await stakedOf(USER_A)).toBe('1000');
    });

    it('accessOf.staked matches stakeOf for the same user (hot path vs tRPC)', async () => {
      // GET /internal/stake reads accessOf; tRPC stakeOf is self-only. Both
      // must answer the same money figure or gates open/close on a lie.
      await fund(USER_A, '7500');
      await token.stake({ userId: USER_A, amount: amt('2500'), tier: 'flex', stakeId: crypto.randomUUID() });
      await token.stake({ userId: USER_A, amount: amt('1500'), tier: 'm12', stakeId: crypto.randomUUID() });
      await publishFeeSchedule();

      const stakeOf = await token.stakeOf(USER_A);
      const access = await token.accessOf(USER_A);
      expect(access.staked).toBe(stakeOf);
      expect(formatAmount(access.staked)).toBe('4000');
    });

    it('holds no numeric balance column of its own', async () => {
      // `stakes.amount` is the principal recorded at stake time, not a running
      // balance — it never changes after insert. Anything that mutated would be
      // a second source of truth for money, which the doctrine forbids.
      await fund(USER_A, '1000');
      const stake = await token.stake({ userId: USER_A, amount: amt('1000'), tier: 'flex', stakeId: crypto.randomUUID() });

      const before = await sql<Array<{ amount: string }>>`SELECT amount FROM token.stakes WHERE id = ${stake.id}`;
      await accrueFees('trade', '500');
      await token.distributeRevenue({ windowId: 'w-immutable', sources: [{ module: 'trade', amount: amt('500') }] });
      const after = await sql<Array<{ amount: string }>>`SELECT amount FROM token.stakes WHERE id = ${stake.id}`;

      expect(after[0]!.amount).toBe(before[0]!.amount);
      // The yield went to available, not to the stake principal.
      expect(await balanceOf(USER_A)).toBe('500');
    });
  });
});
