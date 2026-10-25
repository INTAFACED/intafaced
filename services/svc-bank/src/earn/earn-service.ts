import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  InsufficientFundsError,
  LedgerError,
  earnPoolReserve,
  earnStakeAccount,
  formatAmount,
  parseAmount,
  recipes,
  sum,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { isDefiniteLedgerRefusal } from '../ledger-outcome.js';
import { BankError } from '../errors.js';
import { assertEarnPoolsListLimit } from '../catalog-list-limit.js';
import { assertEarnInterestListLimit, assertEarnPositionsListLimit } from '../owner-list-limit.js';
import { assertEarnResumePendingLimit } from '../job-batch-limit.js';
import { stakePrincipalForAccrual } from './accrue-principal.js';
import { accrualBoundary, accrualDate, planAccrual, type AccruingPosition } from './interest.js';
import { withMoneySpan } from '../tracing.js';
import { rateForDay, readRateHistory, recordRateChange, setPoolRate, type RateHistory } from './rate-history.js';
import { readPoolTotals, type PoolTotal } from '../ops/pool-totals.js';

/**
 * EARN — flexible and fixed pools as `stake`-kind ledger accounts (§8.1).
 *
 * ── Coordination with svc-token, not duplication of it ───────────────────────
 *
 * §8.1: "flexible/fixed pools as stake-kind ledger accounts; native staking
 * already lives in svc-token". Both use the `stake` kind, but L1/L3-5 purpose
 * keys separate them: token uses `token:stake:<id>`, earn uses `bank:earn:<id>`.
 * svc-bank still refuses the native asset (`bank.native_asset_not_earnable`) as
 * belt-and-suspenders so product tables stay simple.
 *
 * ── Where interest comes from ────────────────────────────────────────────────
 *
 * Out of the pool's reserve account, which must be funded first. Interest is
 * not minted and it is not accrued as a number to be settled later: an
 * under-funded pool fails to accrue, loudly, which is the correct behaviour on
 * the day the yield stops being real.
 */

export interface PoolRecord {
  id: string;
  assetId: string;
  kind: 'flexible' | 'fixed';
  name: string;
  aprBps: number;
  termDays: number | null;
  minDeposit: Amount;
  status: 'open' | 'closed';
}

export interface PositionRecord {
  id: string;
  poolId: string;
  userId: string;
  assetId: string;
  principal: Amount;
  openedAt: Date;
  maturesAt: Date | null;
  /** `pending` is the claim before activate — not interest-eligible, not listable as open. */
  status: 'pending' | 'active' | 'closed';
}

interface PoolRow {
  id: string;
  asset_id: string;
  kind: 'flexible' | 'fixed';
  name: string;
  apr_bps: string;
  term_days: number | null;
  min_deposit: string;
  status: 'open' | 'closed';
}

interface PositionRow {
  id: string;
  pool_id: string;
  user_id: string;
  asset_id: string;
  principal: string;
  opened_at: Date;
  matures_at: Date | null;
  status: 'pending' | 'active' | 'closed';
}

function toPool(row: PoolRow): PoolRecord {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind,
    name: row.name,
    aprBps: Number(row.apr_bps),
    termDays: row.term_days,
    minDeposit: parseAmount(row.min_deposit),
    status: row.status,
  };
}

function toPosition(row: PositionRow): PositionRecord {
  return {
    id: row.id,
    poolId: row.pool_id,
    userId: row.user_id,
    assetId: row.asset_id,
    principal: parseAmount(row.principal),
    openedAt: row.opened_at,
    maturesAt: row.matures_at,
    status: row.status,
  };
}

export interface EarnServiceOptions {
  /** The asset svc-token owns. Refused here. */
  nativeAssetId: string;
  /**
   * Desk pause of new supply (BK-loan-07). Checked inside `deposit`, before
   * anything is written, so every caller (router, auto-invest) respects it.
   */
  supplyGate?: { assertSupplyOpen(assetId: string): Promise<void> };
}

export interface AccrualResult {
  poolId: string;
  date: string;
  paid: Amount;
  recipients: number;
  /** Null when nothing was owed — a real, recorded outcome, not a failure. */
  ledgerTxId: string | null;
  alreadyAccrued: boolean;
}

/** One day's payout list as the accrual claim row stores it. */
type PlannedPayout = { userId: string; amount: Amount };

/** What the first transaction of `accrueInner` decided: finished, or a plan to post. */
type AccrualStep =
  { kind: 'done'; result: AccrualResult } | { kind: 'resume'; accrualId: string; payouts: PlannedPayout[]; rateBps: number };

/** Amounts go to JSON as decimal strings: a bigint cannot, and a number would lose digits. */
function encodePayouts(payouts: readonly PlannedPayout[]): Array<{ userId: string; amount: string }> {
  return payouts.map((p) => ({ userId: p.userId, amount: formatAmount(p.amount) }));
}

function decodePayouts(stored: ReadonlyArray<{ userId: string; amount: string }>): PlannedPayout[] {
  return stored.map((p) => ({ userId: p.userId, amount: parseAmount(p.amount) }));
}

/**
 * Job report for `accrueAll`: successes plus per-pool failures that did not
 * abort the rest of the pass.
 */
export interface AccrueAllReport {
  results: AccrualResult[];
  failures: Array<{ poolId: string; reason: string; code?: string }>;
}

export class EarnService {
  private readonly nativeAssetId: string;
  private readonly supplyGate: EarnServiceOptions['supplyGate'];

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    options: EarnServiceOptions = { nativeAssetId: 'IFC' },
  ) {
    this.nativeAssetId = options.nativeAssetId;
    this.supplyGate = options.supplyGate;
  }

  // ── Pools ──────────────────────────────────────────────────────────────────

  /**
   * Open a pool and record its opening rate (BK-earn-05), in one transaction: a pool never exists without the first
   * line of its rate history. `id` is the caller-stable retry key of an operator's create (`ops.createPool`): the same
   * id with the same terms returns the pool already made, and with different terms refuses `bank.pool_conflict`.
   */
  async createPool(input: {
    id?: string;
    assetId: string;
    kind: 'flexible' | 'fixed';
    name: string;
    aprBps: number;
    termDays?: number | null;
    minDeposit?: Amount;
  }): Promise<PoolRecord> {
    this.assertEarnable(input.assetId);
    const termDays = input.kind === 'fixed' ? (input.termDays ?? null) : null;
    const minDeposit = formatAmount(input.minDeposit ?? 0n);

    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<Array<PoolRow & { created_at: Date }>>`
          INSERT INTO bank.earn_pools (id, asset_id, kind, name, apr_bps, term_days, min_deposit)
          VALUES (
            ${input.id ?? tx`gen_random_uuid()`}, ${input.assetId}, ${input.kind}, ${input.name}, ${input.aprBps},
            ${termDays}, ${minDeposit}::numeric
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id, asset_id, kind, name, apr_bps, term_days, min_deposit, status, created_at
        `;
        const made = rows[0];
        if (!made) {
          const existing = await tx<PoolRow[]>`
            SELECT id, asset_id, kind, name, apr_bps, term_days, min_deposit, status
              FROM bank.earn_pools WHERE id = ${input.id!}
          `;
          const pool = existing[0] ? toPool(existing[0]) : null;
          // The rate it opened with, not today's: a later approved change is not a different create.
          const opened = await tx<Array<{ rate_bps: number }>>`
            SELECT rate_bps FROM bank.earn_rate_changes WHERE pool_id = ${input.id!} ORDER BY effective_at ASC LIMIT 1
          `;
          if (
            !pool ||
            opened[0]?.rate_bps !== input.aprBps ||
            pool.assetId !== input.assetId ||
            pool.kind !== input.kind ||
            pool.name !== input.name ||
            pool.termDays !== termDays ||
            pool.minDeposit !== parseAmount(minDeposit)
          ) {
            throw new BankError(`Pool ${input.id} already exists on different terms; a new pool needs a new id`, 'bank.pool_conflict');
          }
          return pool;
        }
        await recordRateChange(tx, {
          poolId: made.id,
          rateBps: input.aprBps,
          effectiveAt: made.created_at,
          reason: null,
          approvalId: null,
        });
        return toPool(made);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  async pool(poolId: string): Promise<PoolRecord> {
    const rows = await this.sql<PoolRow[]>`
      SELECT id, asset_id, kind, name, apr_bps, term_days, min_deposit, status
        FROM bank.earn_pools WHERE id = ${poolId}
    `;
    const row = rows[0];
    if (!row) throw new BankError(`Pool ${poolId} not found`, 'bank.pool_not_found');
    return toPool(row);
  }

  async listPools(assetId?: string, limit?: number): Promise<PoolRecord[]> {
    const page = assertEarnPoolsListLimit(limit);
    const rows = assetId
      ? await this.sql<PoolRow[]>`
          SELECT id, asset_id, kind, name, apr_bps, term_days, min_deposit, status
            FROM bank.earn_pools WHERE asset_id = ${assetId} AND status = 'open' ORDER BY apr_bps DESC
            LIMIT ${page}
        `
      : await this.sql<PoolRow[]>`
          SELECT id, asset_id, kind, name, apr_bps, term_days, min_deposit, status
            FROM bank.earn_pools WHERE status = 'open' ORDER BY asset_id ASC, apr_bps DESC
            LIMIT ${page}
        `;
    if (rows.length === 0) {
      throw new BankError(assetId ? `No earn rate is configured for ${assetId}` : 'No earn rates are configured', 'bank.earn_rate_unset');
    }
    return rows.map(toPool);
  }

  /** Job work set — every open pool. Not a catalog page; accrueAll is not milled as a dump. */
  private async openPoolsForAccrual(): Promise<PoolRecord[]> {
    const rows = await this.sql<PoolRow[]>`
      SELECT id, asset_id, kind, name, apr_bps, term_days, min_deposit, status
        FROM bank.earn_pools WHERE status = 'open' ORDER BY asset_id ASC, apr_bps DESC
    `;
    if (rows.length === 0) {
      throw new BankError('No earn rates are configured', 'bank.earn_rate_unset');
    }
    return rows.map(toPool);
  }

  /**
   * Put yield into a pool's reserve.
   *
   * An operator action today; in the finished §8.1 the source is loan interest
   * revenue, which lands in `houseFees('bank', asset)` and is swept here.
   */
  async fundPool(input: { poolId: string; fundingId: string; amount: Amount }): Promise<{ ledgerTxId: string }> {
    const pool = await this.pool(input.poolId);
    return withMoneySpan(
      'bank.earn.fundPool',
      { operation: 'fund-pool', poolId: pool.id, amount: formatAmount(input.amount), assetId: pool.assetId },
      async () => {
        const tx = await this.ledger.post(
          recipes.earnPoolFund({
            poolId: pool.id,
            fundingId: input.fundingId,
            assetId: pool.assetId,
            amount: input.amount,
          }),
        );
        return { ledgerTxId: tx.id };
      },
    );
  }

  /** Every rate the pool has published, oldest first (BK-earn-05). Read only. */
  rateHistory(poolId: string, limit?: number, before?: Date): Promise<RateHistory> {
    return readRateHistory(this.sql, poolId, limit, before);
  }

  /** An approved change of a flexible pool's rate; see `setPoolRate` in rate-history.ts. */
  setPoolRate(input: { poolId: string; rateBps: number; reason: string; approvalId: string; now?: Date }) {
    return setPoolRate(this.sql, input);
  }

  /** What the pool can still afford to pay. A ledger read, never a column. */
  async reserveBalance(poolId: string): Promise<Amount> {
    const pool = await this.pool(poolId);
    return (await this.ledger.balance(earnPoolReserve(pool.id, pool.assetId))).amount;
  }

  /**
   * The pool's size — sum of ledger earn stake pots for its active positions.
   *
   * Eligibility is the table (who, which pool, `active`). The money is the
   * per-position pot. If a row's principal disagrees with that pot, refuse
   * `bank.earn_principal_mismatch` rather than report a drifted column.
   *
   * A stored `total_deposited` is the single most tempting thing to add to this
   * service and the single most certain to drift.
   */
  async poolSize(poolId: string): Promise<Amount> {
    const rows = await this.sql<Array<{ id: string; user_id: string; asset_id: string; principal: string }>>`
      SELECT id, user_id, asset_id, principal FROM bank.earn_positions
       WHERE pool_id = ${poolId} AND status = 'active'
       ORDER BY id ASC
    `;
    let total: Amount = 0n;
    for (const row of rows) {
      const recorded = parseAmount(row.principal);
      const book = (await this.ledger.balance(earnStakeAccount(row.user_id, row.asset_id, row.id))).amount;
      total += stakePrincipalForAccrual(row.id, recorded, book);
    }
    return total;
  }

  /**
   * Operator totals. Same stake-pot read as `poolSize`, but an inflated
   * principal column is ignored and a failed ledger read is null, not a refusal.
   */
  poolTotals(): Promise<{ asOf: string; pools: PoolTotal[] }> {
    return readPoolTotals(this.sql, this.ledger);
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  /**
   * Open a position.
   *
   * L3-3 ordering: **claim `pending` → ledger post → activate** (same as
   * svc-token stake). `pending` is not interest-eligible; if the ledger
   * definitely refuses we delete the claim so nothing is left to accrue
   * against. An unknown outcome keeps the claim and rethrows.
   * Ledger post is idempotent on `positionId` for crash recovery — see
   * `resumePending` when the process dies after the post and before activate.
   *
   * `positionId` is the caller-stable retry key. Omit used to mint a UUID so a
   * retry without a client id staked twice (ledger keys on positionId). Refuse
   * rather than invent an id a retry cannot reuse.
   */
  async deposit(input: { poolId: string; userId: string; amount: Amount; positionId: string; now?: Date }): Promise<PositionRecord> {
    if (!input.positionId) {
      throw new BankError('Earn deposit needs a caller-stable position id', 'bank.position_id_required');
    }
    const positionId = input.positionId;
    const now = input.now ?? new Date();

    return withMoneySpan(
      'bank.earn.deposit',
      {
        operation: 'earn-deposit',
        poolId: input.poolId,
        positionId,
        userId: input.userId,
        amount: formatAmount(input.amount),
      },
      async () => {
        const pool = await this.pool(input.poolId);
        // A desk pause on the pool's asset refuses before anything is written.
        await this.supplyGate?.assertSupplyOpen(pool.assetId);
        if (pool.status !== 'open') throw new BankError(`Pool "${pool.name}" is closed`, 'bank.pool_closed');
        this.assertEarnable(pool.assetId);
        if (input.amount < pool.minDeposit) {
          throw new BankError(
            `Minimum deposit for "${pool.name}" is ${formatAmount(pool.minDeposit)} ${pool.assetId}`,
            'bank.below_minimum',
          );
        }

        const maturesAt =
          pool.kind === 'fixed' && pool.termDays !== null ? new Date(now.getTime() + pool.termDays * 24 * 60 * 60 * 1000) : null;

        const claimed = await this.sql<Array<{ id: string }>>`
          INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status)
          VALUES (${positionId}, ${pool.id}, ${input.userId}, ${pool.assetId},
                  ${formatAmount(input.amount)}::numeric, ${now}, ${maturesAt}, 'pending')
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;

        if (claimed.length === 0) {
          const finished = await this.reuseOrRefuse(positionId, input.userId, pool.id, input.amount);
          if (finished) return finished;
        }

        try {
          // Post alone is in the try. Only a definite ledger refusal proves the
          // funds never left available, so only then is deleting the claim safe.
          // Any other failure may follow a commit whose acknowledgement was lost:
          // the row stays `pending` with its original terms for resumePending or
          // a same-id retry, both of which re-drive the same idempotent post.
          // Never delete a claim that may be staked.
          await this.postEarnDeposit({
            positionId,
            poolId: pool.id,
            userId: input.userId,
            assetId: pool.assetId,
            amount: input.amount,
          });
        } catch (err) {
          if (!isDefiniteLedgerRefusal(err)) throw err;
          await this.sql`
            DELETE FROM bank.earn_positions WHERE id = ${positionId} AND status = 'pending'
          `;
          throw err;
        }

        await this.activatePending(positionId);
        return this.position(positionId);
      },
    );
  }

  /**
   * A `positionId` that is already taken: the same deposit arriving twice, or a
   * DIFFERENT deposit wearing an id somebody else already used.
   *
   * Only the first is a retry, and `ON CONFLICT (id) DO NOTHING` cannot tell
   * them apart on its own. Without this check the second one ran the whole
   * deposit path against the first one's row: the ledger post moved the SECOND
   * caller's value into a stake pot keyed by their own id, the `UPDATE … status
   * = 'active'` landed on the FIRST caller's row, and the two halves of this
   * service's own reconciliation — `principalOf()` from the table and
   * `stakedOf()` from the ledger — stopped agreeing. The second caller was told
   * their deposit was earning while their money sat in a pot no `withdraw` of
   * theirs could reach, because `withdraw` resolves the owner from the row.
   *
   * The check svc-token's `claimStakePending` already makes, and the same
   * reasoning `bank.loan_principal_mismatch` makes for loans: a retry that asks
   * for different terms is a different request.
   *
   * Returns the existing position when the retry is genuine and already
   * finished — nothing left to post — and null when it is genuine but still
   * `pending`, which re-drives (the ledger post is idempotent on the id).
   */
  private async reuseOrRefuse(positionId: string, userId: string, poolId: string, amount: Amount): Promise<PositionRecord | null> {
    const rows = await this.sql<Array<{ user_id: string; pool_id: string; principal: string; status: string }>>`
      SELECT user_id, pool_id, principal, status FROM bank.earn_positions WHERE id = ${positionId}
    `;
    const existing = rows[0];
    if (!existing) throw new BankError(`Position ${positionId} disappeared after a conflict`, 'bank.position_not_found');

    if (existing.user_id !== userId || existing.pool_id !== poolId || parseAmount(existing.principal) !== amount) {
      throw new BankError(
        `Position ${positionId} already exists on different terms — a deposit that is not a retry of that one needs a new position id`,
        'bank.position_conflict',
      );
    }

    return existing.status === 'pending' ? null : this.position(positionId);
  }

  /** Idempotent deposit post — key `bank.earn.deposit:<positionId>`. */
  private async postEarnDeposit(input: {
    positionId: string;
    poolId: string;
    userId: string;
    assetId: string;
    amount: Amount;
  }): Promise<void> {
    await this.ledger.post(
      recipes.earnDeposit({
        positionId: input.positionId,
        poolId: input.poolId,
        userId: input.userId,
        assetId: input.assetId,
        amount: input.amount,
      }),
    );
  }

  private async activatePending(positionId: string): Promise<void> {
    await this.sql`
      UPDATE bank.earn_positions SET status = 'active'
       WHERE id = ${positionId} AND status = 'pending'
    `;
  }

  /**
   * Ledger post + activate for a row already claimed as `pending`.
   *
   * Used by `resumePending`. Idempotent on `bank.earn.deposit:<positionId>`, so
   * a re-drive after a crash between the post and the activate does not stake
   * twice. Unknown failures leave the row pending for the next attempt; a
   * definite refusal is handled by `resumePending`, which closes the claim.
   */
  private async drivePendingToActive(input: {
    positionId: string;
    poolId: string;
    userId: string;
    assetId: string;
    amount: Amount;
  }): Promise<void> {
    await this.postEarnDeposit(input);
    await this.activatePending(input.positionId);
  }

  /**
   * Re-drive every `pending` earn deposit. The recovery path for "the process
   * died after the ledger post and before activate".
   *
   * Safe to run at any time and any number of times: the deposit recipe is
   * idempotent on `positionId`, and activate is conditional on `pending`. A
   * second pass finds nothing left to do.
   *
   * An UNKNOWN failure (transport error, 5xx, an untyped body) leaves the claim
   * pending for the next attempt (or for ops to inspect): the post may have
   * committed. A DEFINITE ledger refusal is final, exactly as in `deposit`: it
   * proves nothing committed under this key, so the claim is deleted. A refused
   * deposit must never stay pending, because it would book later, when funds
   * arrive, with nobody's current yes (docs/adr/2026-10-14-recovery-lookup-first-no-expiry-yet.md).
   *
   * `limit` is required. Omit used to invent a 100-row pass. Blank refuses.
   * Owner/cron may pass 100 explicitly.
   */
  async resumePending(limit?: number): Promise<Array<{ positionId: string; outcome: 'completed' | 'failed'; reason?: string }>> {
    const batch = assertEarnResumePendingLimit(limit);
    const rows = await this.sql<PositionRow[]>`
      SELECT id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status
        FROM bank.earn_positions
       WHERE status = 'pending'
       ORDER BY opened_at ASC
       LIMIT ${batch}
    `;

    const out: Array<{ positionId: string; outcome: 'completed' | 'failed'; reason?: string }> = [];

    for (const row of rows) {
      try {
        await this.drivePendingToActive({
          positionId: row.id,
          poolId: row.pool_id,
          userId: row.user_id,
          assetId: row.asset_id,
          amount: parseAmount(row.principal),
        });
        out.push({ positionId: row.id, outcome: 'completed' });
      } catch (err) {
        if (isDefiniteLedgerRefusal(err)) {
          // Same close as deposit(): only a pending claim, only on a definite refusal.
          await this.sql`
            DELETE FROM bank.earn_positions WHERE id = ${row.id} AND status = 'pending'
          `;
        }
        out.push({
          positionId: row.id,
          outcome: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return out;
  }

  async position(positionId: string): Promise<PositionRecord> {
    const rows = await this.sql<PositionRow[]>`
      SELECT id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status
        FROM bank.earn_positions WHERE id = ${positionId}
    `;
    const row = rows[0];
    if (!row) throw new BankError(`Position ${positionId} not found`, 'bank.position_not_found');
    return toPosition(row);
  }

  /** The person's open positions in one pool, newest first: the pool page lists them without paging through every pool. */
  async positionsInPool(userId: string, poolId: string, limit?: number): Promise<PositionRecord[]> {
    const page = assertEarnPositionsListLimit(limit);
    const rows = await this.sql<PositionRow[]>`
      SELECT id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status
        FROM bank.earn_positions WHERE user_id = ${userId} AND pool_id = ${poolId} AND status = 'active'
       ORDER BY opened_at DESC
       LIMIT ${page}
    `;
    return rows.map(toPosition);
  }

  /**
   * The rate each position's pool had recorded in force when it opened (BK-earn-05), by position id. A position opened
   * before its pool's first record maps to null: the bank has no record of that rate and none is guessed.
   */
  async ratesAtOpen(positions: readonly PositionRecord[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (positions.length === 0) return out;
    const rows = await this.sql<Array<{ id: string; rate_bps: number | null }>>`
      SELECT p.id, (
        SELECT c.rate_bps FROM bank.earn_rate_changes c
         WHERE c.pool_id = p.pool_id AND c.effective_at <= p.opened_at
         ORDER BY c.effective_at DESC LIMIT 1
      ) AS rate_bps
        FROM bank.earn_positions p WHERE p.id = ANY(${positions.map((position) => position.id)}::uuid[])
    `;
    for (const row of rows) out.set(row.id, row.rate_bps);
    return out;
  }

  async positionsOf(userId: string, limit?: number): Promise<PositionRecord[]> {
    const page = assertEarnPositionsListLimit(limit);
    const rows = await this.sql<PositionRow[]>`
      SELECT id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status
        FROM bank.earn_positions WHERE user_id = ${userId} AND status = 'active' ORDER BY opened_at DESC
       LIMIT ${page}
    `;
    return rows.map(toPosition);
  }

  /**
   * The user's total open principal in an asset.
   *
   * Must equal `stakedOf` (sum of purposed earn stake pots). Eligibility is
   * the active rows; the money is each row's ledger pot. Table/ledger drift
   * refuses `bank.earn_principal_mismatch` rather than report the column.
   */
  async principalOf(userId: string, assetId: string): Promise<Amount> {
    const rows = await this.sql<Array<{ id: string; principal: string }>>`
      SELECT id, principal FROM bank.earn_positions
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND status = 'active'
       ORDER BY id ASC
    `;
    let total: Amount = 0n;
    for (const row of rows) {
      const recorded = parseAmount(row.principal);
      const book = (await this.ledger.balance(earnStakeAccount(userId, assetId, row.id))).amount;
      total += stakePrincipalForAccrual(row.id, recorded, book);
    }
    return total;
  }

  /** Sum of per-position earn stake pots on the ledger (L1 purpose keys). */
  async stakedOf(userId: string, assetId: string): Promise<Amount> {
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM bank.earn_positions
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND status = 'active'
    `;
    let total = 0n;
    for (const row of rows) {
      total += (await this.ledger.balance(earnStakeAccount(userId, assetId, row.id))).amount;
    }
    return total;
  }

  /**
   * Close a position and return the principal.
   *
   * The money is the ledger stake pot, checked with `stakePrincipalForAccrual`
   * the same way `principalOf` checks it. A column that disagrees with a
   * still-funded pot refuses `bank.earn_principal_mismatch` before anything is
   * posted, so the row stays open and the pot stays whole.
   *
   * A crash after the ledger post and before this close leaves the pot at 0,
   * the principal already in available, and the row still active. That retry
   * replays `bank.earn.withdraw:<positionId>` with the column amount. The
   * ledger returns the committed transaction and does not move the principal
   * again, then the row closes. Checking the mismatch first never reaches
   * that key, so the row stays active and interest for the pool stops. An
   * empty pot with no such key fails the replay and leaves the row active.
   * A zero column stays a typed refusal — the replay amount is the column,
   * never a balance invented from the empty pot.
   *
   * The row is locked for the duration so two concurrent withdrawals cannot both
   * post. The ledger's idempotency key would catch the double-post anyway, but
   * relying on the last line of defence for ordinary correctness is how the last
   * line stops being one.
   */
  async withdraw(positionId: string, now: Date = new Date()): Promise<PositionRecord> {
    return withMoneySpan('bank.earn.withdraw', { operation: 'earn-withdraw', positionId }, async () => this.withdrawInner(positionId, now));
  }

  private async withdrawInner(positionId: string, now: Date): Promise<PositionRecord> {
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<PositionRow[]>`
          SELECT id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status
            FROM bank.earn_positions WHERE id = ${positionId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new BankError(`Position ${positionId} not found`, 'bank.position_not_found');
        if (row.status === 'closed') throw new BankError('Position is already closed', 'bank.position_closed');
        if (row.status === 'pending') {
          // Resume first. Closing a pending claim would hide a half-open deposit
          // (funds may already be staked) under a user withdraw, and would race
          // the recovery job that is supposed to finish the claim.
          throw new BankError(`Position ${positionId} is still pending — resume the deposit before withdrawing`, 'bank.position_pending');
        }
        if (row.matures_at && row.matures_at > now) {
          throw new BankError(`Fixed-term position is locked until ${row.matures_at.toISOString()}`, 'bank.position_locked');
        }

        const recorded = parseAmount(row.principal);
        const book = (await this.ledger.balance(earnStakeAccount(row.user_id, row.asset_id, row.id))).amount;
        // Empty pot, positive column: the withdraw already committed. Replay
        // the same key. Any other disagreement is drift and refuses first.
        const principal = book === 0n && recorded > 0n ? recorded : stakePrincipalForAccrual(row.id, recorded, book);

        await this.ledger.post(
          recipes.earnWithdraw({
            positionId,
            poolId: row.pool_id,
            userId: row.user_id,
            assetId: row.asset_id,
            amount: principal,
          }),
        );

        await tx`UPDATE bank.earn_positions SET status = 'closed', closed_at = now() WHERE id = ${positionId}`;

        return { ...toPosition(row), status: 'closed' as const };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  // ── Daily accrual (§8.1: "interest accrual daily recipe") ──────────────────

  /**
   * Pay one day of interest for one pool.
   *
   * Idempotent per (pool, day), twice over:
   *
   *   1. `unique(pool_id, accrual_date)` on `bank.interest_accruals`, claimed
   *      before anything is posted.
   *   2. The ledger key `bank.interest:<poolId>:<date>`.
   *
   * Both derive from the same (pool, day) pair, so a cron that fires twice at
   * midnight, or a catch-up run overlapping the live schedule, pays once.
   *
   * Three steps, so a crash cannot change what the day pays:
   *
   *   1. One transaction claims the day, reads the positions and ledger stake
   *      pots, plans the payouts, and stores that list on the claim row
   *      (`planned_payouts`, amounts as decimal strings). Committed.
   *   2. The ledger post, outside any transaction, with the STORED list.
   *   3. The claim row gets `paid_amount`, `recipients` and `ledger_tx_id`.
   *
   * A crash after step 2 and before step 3 leaves a claim with a plan and no
   * ledger transaction. The next run does not plan again: a position may have
   * been withdrawn since, and the same ledger key with a different body is a
   * conflict, not a retry. It posts the stored list (idempotent, returns the
   * same transaction) and records it. Nobody's funds are stranded: the interest
   * is in the users' available balances the whole time. A row with a
   * transaction, or with no stored plan (older rows, an empty day), is final.
   *
   * If the reserve cannot cover the day, NOTHING moves and the claim is deleted
   * so the day can be planned afresh once the pool is funded. That is the loud failure
   * §8.1 needs: a pool that cannot pay its advertised rate is an operator
   * problem today, not a shortfall discovered at maturity.
   */
  async accrue(input: { poolId: string; at?: Date; daysPerYear?: number }): Promise<AccrualResult> {
    const at = input.at ?? new Date();
    const date = accrualDate(at);
    const boundary = accrualBoundary(at);

    return withMoneySpan('bank.earn.accrue', { operation: 'interest-accrual', poolId: input.poolId, date }, async (span) => {
      const result = await this.accrueInner(input.poolId, date, boundary, input.daysPerYear);
      span.setAttribute('intafaced.recipients', result.recipients);
      span.setAttribute('intafaced.paid', formatAmount(result.paid));
      span.setAttribute('intafaced.already_accrued', result.alreadyAccrued);
      return result;
    });
  }

  private async accrueInner(poolId: string, date: string, boundary: Date, daysPerYear?: number): Promise<AccrualResult> {
    const pool = await this.pool(poolId);

    // Step 1: claim the day and store the plan, committed before any money moves.
    const step = await transaction(
      this.sql,
      async (tx): Promise<AccrualStep> => {
        // The rate in force when the day began (BK-earn-05): a change recorded during the day pays from the next one.
        const rateBps = await rateForDay(tx, pool.id, boundary, pool.aprBps);
        // Claim the day. A second run blocks here until the claim commits.
        const claimed = await tx<Array<{ id: string }>>`
          INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients)
          VALUES (${pool.id}, ${date}, ${rateBps}, 0, 0)
          ON CONFLICT (pool_id, accrual_date) DO NOTHING
          RETURNING id
        `;

        if (claimed.length === 0) {
          const existing = await tx<
            Array<{
              id: string;
              paid_amount: string;
              recipients: number;
              ledger_tx_id: string | null;
              planned_payouts: Array<{ userId: string; amount: string }> | null;
              rate_bps: string;
            }>
          >`
            SELECT id, paid_amount, recipients, ledger_tx_id, planned_payouts, rate_bps FROM bank.interest_accruals
             WHERE pool_id = ${pool.id} AND accrual_date = ${date}
          `;
          const row = existing[0]!;
          if (row.ledger_tx_id === null && row.planned_payouts !== null) {
            // A run planned the day and stopped before recording the post. Pay
            // exactly what it planned.
            return { kind: 'resume', accrualId: row.id, payouts: decodePayouts(row.planned_payouts), rateBps: Number(row.rate_bps) };
          }
          return {
            kind: 'done',
            result: {
              poolId: pool.id,
              date,
              paid: parseAmount(row.paid_amount),
              recipients: row.recipients,
              ledgerTxId: row.ledger_tx_id,
              alreadyAccrued: true,
            },
          };
        }

        const accrualId = claimed[0]!.id;

        // The UTC day boundary is the eligibility cutoff, regardless of when
        // the scheduler happens to run. A position opened at or after midnight
        // starts earning on the next day; a late cron cannot grant it a full
        // day's yield.
        //
        // Eligibility (who, which pool, opened before the day) is the table.
        // The money is the ledger earn stake pot. If the recorded principal
        // disagrees with that pot, refuse — a stale column must not size yield.
        const positions = await tx<Array<{ id: string; user_id: string; principal: string }>>`
          SELECT id, user_id, principal FROM bank.earn_positions
           WHERE pool_id = ${pool.id} AND status = 'active' AND opened_at < ${boundary}
           ORDER BY id ASC
        `;

        const accruing: AccruingPosition[] = [];
        for (const p of positions) {
          const ledgerPrincipal = stakePrincipalForAccrual(
            p.id,
            parseAmount(p.principal),
            (await this.ledger.balance(earnStakeAccount(p.user_id, pool.assetId, p.id))).amount,
          );
          accruing.push({ positionId: p.id, userId: p.user_id, principal: ledgerPrincipal });
        }

        const plan = planAccrual(accruing, rateBps, daysPerYear);

        if (plan.payouts.length === 0) {
          // A real outcome, recorded: an empty pool, or every position too small
          // to earn a unit today. Writing the row keeps the day from being
          // reconsidered forever. No plan is stored, so the row is final.
          return {
            kind: 'done',
            result: { poolId: pool.id, date, paid: 0n, recipients: 0, ledgerTxId: null, alreadyAccrued: false },
          };
        }

        const payouts = plan.payouts.map((p) => ({ userId: p.userId, amount: p.amount }));
        await tx`
          UPDATE bank.interest_accruals
             SET planned_payouts = ${tx.json(encodePayouts(payouts) as never)}
           WHERE id = ${accrualId}
        `;
        return { kind: 'resume', accrualId, payouts, rateBps };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    if (step.kind === 'done') return step.result;

    return this.settleAccrual(pool, date, step.accrualId, step.payouts, step.rateBps, 'release');
  }

  /**
   * Steps 2 and 3 of an accrual: post the stored plan, then record it.
   *
   * `onUnderfunded` says what happens to the claim when the reserve cannot
   * cover the plan. `release` deletes it so the day is planned afresh, which is
   * right for the day being accrued now. `keep` leaves the stored plan in
   * place, which is right for an earlier day that only ever resumes: nothing
   * would plan that day again, and the plan is still what it owed.
   */
  private async settleAccrual(
    pool: PoolRecord,
    date: string,
    accrualId: string,
    payouts: PlannedPayout[],
    rateBps: number,
    onUnderfunded: 'release' | 'keep',
  ): Promise<AccrualResult> {
    const total = sum(payouts.map((p) => p.amount));
    let posted;
    try {
      posted = await this.ledger.post(recipes.earnInterest({ poolId: pool.id, date, assetId: pool.assetId, payouts }));
    } catch (err) {
      if (err instanceof InsufficientFundsError || (err instanceof LedgerError && err.code === 'ledger.insufficient_funds')) {
        // Nothing posted. Drop the claim so the day is re-runnable the moment
        // the reserve is topped up, and is planned afresh from live positions.
        // The guard keeps a claim that a concurrent run has already recorded.
        if (onUnderfunded === 'release') {
          await this.sql`
            DELETE FROM bank.interest_accruals WHERE id = ${accrualId} AND ledger_tx_id IS NULL
          `;
        }
        // Rethrown as a bank code so the operator alert says what is wrong
        // ("this pool cannot pay its rate") rather than what the ledger saw.
        throw new BankError(
          `Pool "${pool.name}" cannot cover ${formatAmount(total)} ${pool.assetId} of interest for ${date}`,
          'bank.pool_underfunded',
        );
      }
      throw err;
    }

    const recorded = await this.sql<Array<{ id: string }>>`
      UPDATE bank.interest_accruals
         SET paid_amount = ${formatAmount(total)}::numeric,
             recipients = ${payouts.length},
             ledger_tx_id = ${posted.id}
       WHERE id = ${accrualId}
      RETURNING id
    `;
    if (recorded.length === 0) {
      // The claim was deleted after the post landed: a concurrent run saw the
      // reserve short before our post took effect and released it. The payment
      // stands, so it gets its record back.
      await this.sql`
        INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients, ledger_tx_id, planned_payouts)
        VALUES (
          ${pool.id}, ${date}, ${rateBps}, ${formatAmount(total)}::numeric, ${payouts.length}, ${posted.id},
          ${this.sql.json(encodePayouts(payouts) as never)}
        )
        ON CONFLICT (pool_id, accrual_date) DO UPDATE
           SET paid_amount = EXCLUDED.paid_amount,
               recipients = EXCLUDED.recipients,
               ledger_tx_id = EXCLUDED.ledger_tx_id,
               planned_payouts = EXCLUDED.planned_payouts
      `;
    }

    return {
      poolId: pool.id,
      date,
      paid: total,
      recipients: payouts.length,
      ledgerTxId: posted.id,
      alreadyAccrued: false,
    };
  }

  /**
   * Finish accruals from EARLIER days that stopped between planning and
   * recording. Each keeps its own date and its own stored plan; no day is
   * planned here. Every failure is reported against its pool.
   */
  private async resumeEarlierAccruals(before: string, results: AccrualResult[], failures: AccrueAllReport['failures']): Promise<void> {
    const pending = await this.sql<
      Array<{
        id: string;
        pool_id: string;
        accrual_date: string;
        rate_bps: string;
        planned_payouts: Array<{ userId: string; amount: string }>;
      }>
    >`
      SELECT id, pool_id, accrual_date::text AS accrual_date, rate_bps, planned_payouts FROM bank.interest_accruals
       WHERE planned_payouts IS NOT NULL AND ledger_tx_id IS NULL AND accrual_date < ${before}
       ORDER BY accrual_date ASC, id ASC
    `;
    for (const row of pending) {
      try {
        const pool = await this.pool(row.pool_id);
        results.push(
          await this.settleAccrual(pool, row.accrual_date, row.id, decodePayouts(row.planned_payouts), Number(row.rate_bps), 'keep'),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const code = err instanceof BankError ? err.code : undefined;
        failures.push({ poolId: row.pool_id, reason: `${row.accrual_date}: ${reason}`, ...(code ? { code } : {}) });
      }
    }
  }

  /**
   * Every open pool accrues for the day. The job's entry point.
   *
   * Isolation is deliberate: an underfunded pool is a loud operator problem for
   * THAT pool (`bank.pool_underfunded` still throws from `accrue` when called
   * alone), but it must not withhold every other pool's advertised yield for the
   * day. Failures are returned, not swallowed — ops see which pool blocked.
   *
   * Earlier days whose run stopped after planning are finished first, from
   * their stored plans, and reported alongside today's results.
   */
  async accrueAll(at: Date = new Date(), daysPerYear?: number): Promise<AccrueAllReport> {
    const pools = await this.openPoolsForAccrual();
    const results: AccrualResult[] = [];
    const failures: AccrueAllReport['failures'] = [];
    await this.resumeEarlierAccruals(accrualDate(at), results, failures);
    for (const pool of pools) {
      try {
        results.push(await this.accrue({ poolId: pool.id, at, ...(daysPerYear === undefined ? {} : { daysPerYear }) }));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const code = err instanceof BankError ? err.code : undefined;
        failures.push({ poolId: pool.id, reason, ...(code ? { code } : {}) });
      }
    }
    return { results, failures };
  }

  /**
   * Lifetime interest a pool has paid — summed from the per-day records.
   *
   * Not a stored total. Summing the daily rows and reading how much has left the
   * pool's reserve in the ledger are two independent answers to the same
   * question, and they must agree.
   */
  async interestPaid(poolId: string): Promise<Amount> {
    const rows = await this.sql<Array<{ total: string }>>`
      SELECT COALESCE(SUM(paid_amount), 0) AS total FROM bank.interest_accruals WHERE pool_id = ${poolId}
    `;
    return parseAmount(rows[0]?.total ?? '0');
  }

  /**
   * What one person earned from one pool, a row per paid day, newest first (BK-pots-03, J-bank-07 #5).
   *
   * Each row is that day's accrual record: the rate snapshotted for the day and this person's payout from the plan the
   * day posted (one payout per person per pool per day, whatever their number of positions). Only days with a ledger
   * transaction count, so a planned day that has not posted yet is not shown as paid. `before` (a day, exclusive) pages
   * back through older days. `total` sums every itemised paid day, not just this page, and equals what the ledger
   * credited this person from the pool on those days. Paid days written before the stored plan (migration 0032) carry no
   * per-person split: they are counted in `unitemisedDays` for the pool, never guessed into anyone's figures.
   */
  async interestHistory(
    userId: string,
    poolId: string,
    limit?: number,
    before?: string,
  ): Promise<{
    days: Array<{ date: string; rateBps: number; amount: Amount; ledgerTxId: string }>;
    total: Amount;
    unitemisedDays: number;
  }> {
    const page = assertEarnInterestListLimit(limit);
    await this.pool(poolId);
    // The containment test is served by the GIN index on the plan; the lateral expansion then reads one person's payout.
    const mine = this.sql.json([{ userId }] as never);
    const [days, [sum], [unitemised]] = await Promise.all([
      this.sql<Array<{ date: string; rate_bps: number; amount: string; ledger_tx_id: string }>>`
        SELECT a.accrual_date::text AS date, a.rate_bps::int AS rate_bps, p.amount, a.ledger_tx_id
          FROM bank.interest_accruals a
          CROSS JOIN LATERAL jsonb_to_recordset(a.planned_payouts) AS p("userId" text, amount text)
         WHERE a.pool_id = ${poolId} AND a.ledger_tx_id IS NOT NULL AND a.planned_payouts @> ${mine}
           AND p."userId" = ${userId}
           ${before ? this.sql`AND a.accrual_date < ${before}::date` : this.sql``}
         ORDER BY a.accrual_date DESC
         LIMIT ${page}
      `,
      this.sql<Array<{ total: string }>>`
        SELECT COALESCE(SUM(p.amount::numeric), 0)::text AS total
          FROM bank.interest_accruals a
          CROSS JOIN LATERAL jsonb_to_recordset(a.planned_payouts) AS p("userId" text, amount text)
         WHERE a.pool_id = ${poolId} AND a.ledger_tx_id IS NOT NULL AND a.planned_payouts @> ${mine}
           AND p."userId" = ${userId}
      `,
      this.sql<Array<{ days: number }>>`
        SELECT count(*)::int AS days FROM bank.interest_accruals
         WHERE pool_id = ${poolId} AND ledger_tx_id IS NOT NULL AND planned_payouts IS NULL AND paid_amount > 0
      `,
    ]);
    return {
      days: days.map((d) => ({ date: d.date, rateBps: d.rate_bps, amount: parseAmount(d.amount), ledgerTxId: d.ledger_tx_id })),
      total: parseAmount(sum?.total ?? '0'),
      unitemisedDays: unitemised?.days ?? 0,
    };
  }

  private assertEarnable(assetId: string): void {
    if (assetId === this.nativeAssetId) {
      throw new BankError(
        `${assetId} is staked through svc-token, not through bank earn pools (§8.1) — both would write to the same ledger stake account`,
        'bank.native_asset_not_earnable',
      );
    }
  }
}
