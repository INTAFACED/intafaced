import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { earnStakeAccount, formatAmount, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { BankEarnAvailability, BankEarnPositionState } from '@intafaced/contracts';
import { BankError } from '../errors.js';
import { isDefiniteLedgerRefusal } from '../ledger-outcome.js';
import { withMoneySpan } from '../tracing.js';
import { stakePrincipalForAccrual } from './accrue-principal.js';
import { accrualBoundary } from './interest.js';
import type { EarnService, PoolRecord, PositionRecord } from './earn-service.js';

/**
 * PERSONAL EARN (BK-earn-01): partial withdraw with the `deallocating` state, the derived `waiting_accrual` state,
 * per-pool availability on top of the module gate, and earn settings with the auto program.
 * Business earn (`business.earn.*`) is BK-pots-04 and is not here (D51).
 */

/** Verification tiers as the access token carries them, in order. The availability rule stores the index. */
export const VERIFICATION_TIERS = ['none', 'basic', 'full', 'institutional'] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

/** Who is asking. A null country is unknown: a pool with a country rule is not offered to an unknown country. */
export interface EarnViewer {
  country: string | null;
  tier: VerificationTier;
}

export interface AvailabilityRule {
  allowedCountries: string[] | null;
  minVerificationTier: number | null;
}

/**
 * Whether one pool is offered. A closed pool is not offered. No rule, or null fields, follows the module gate
 * (offered here: the module gate already ran on the door). Fails closed on an unknown country.
 */
export function evaluateAvailability(
  pool: Pick<PoolRecord, 'status'>,
  rule: AvailabilityRule | null,
  viewer: EarnViewer,
): BankEarnAvailability {
  if (pool.status !== 'open') return { offered: false, reason: 'pool_closed' };
  if (rule?.allowedCountries) {
    const country = viewer.country?.trim().toUpperCase() ?? null;
    if (country === null || !rule.allowedCountries.includes(country)) return { offered: false, reason: 'country' };
  }
  if (rule?.minVerificationTier !== null && rule?.minVerificationTier !== undefined) {
    if (VERIFICATION_TIERS.indexOf(viewer.tier) < rule.minVerificationTier) return { offered: false, reason: 'verification_tier' };
  }
  return { offered: true };
}

/**
 * The state a customer sees. `waiting_accrual` is derived, not stored: an active position opened on the current UTC
 * day earns from the next UTC day (the accrual eligibility cutoff is `opened_at < boundary`).
 */
export function positionState(position: Pick<PositionRecord, 'status' | 'openedAt'>, now: Date): BankEarnPositionState {
  if (position.status === 'active' && position.openedAt >= accrualBoundary(now)) return 'waiting_accrual';
  return position.status;
}

/** First UTC midnight after the position opened. */
export function accruesFrom(openedAt: Date): Date {
  const d = new Date(Date.UTC(openedAt.getUTCFullYear(), openedAt.getUTCMonth(), openedAt.getUTCDate() + 1));
  return d;
}

export interface WithdrawResult {
  positionId: string;
  withdrawn: Amount;
  remaining: Amount;
  state: 'active' | 'closed';
}

export interface AutoProgram {
  assetId: string;
  poolId: string;
  enabled: boolean;
  cap: Amount | null;
}

/** The ledger key for one withdraw request. Distinct from the whole-position key `bank.earn.withdraw:<positionId>`. */
export function earnWithdrawKey(positionId: string, clientEventId: string): string {
  return `bank.earn.withdraw:${positionId}:${clientEventId}`;
}

const OPEN_PRINCIPAL =
  "(principal - COALESCE((SELECT SUM(w.amount) FROM bank.earn_withdrawals w WHERE w.position_id = earn_positions.id AND w.status = 'posted'), 0))::text AS principal";

interface ClaimRow {
  id: string;
  amount: string;
  status: 'claimed' | 'posted';
}

export class EarnPersonal {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly earn: EarnService,
  ) {}

  // ── Availability ───────────────────────────────────────────────────────────

  /** Deposit record less posted withdraws: what a whole withdraw would return now. */
  async openPrincipal(positionId: string): Promise<Amount> {
    const rows = await this.sql<Array<{ principal: string }>>`
      SELECT ${this.sql.unsafe(OPEN_PRINCIPAL)} FROM bank.earn_positions WHERE id = ${positionId}
    `;
    if (!rows[0]) throw new BankError(`Position ${positionId} not found`, 'bank.position_not_found');
    return parseAmount(rows[0].principal);
  }

  async availabilityRule(poolId: string): Promise<AvailabilityRule | null> {
    const rows = await this.sql<Array<{ allowed_countries: string[] | null; min_verification_tier: number | null }>>`
      SELECT allowed_countries, min_verification_tier FROM bank.earn_pool_availability WHERE pool_id = ${poolId}
    `;
    const row = rows[0];
    return row ? { allowedCountries: row.allowed_countries, minVerificationTier: row.min_verification_tier } : null;
  }

  /** Owner write of a pool's rule. Both null clears it back to the module gate. */
  async setAvailabilityRule(poolId: string, rule: AvailabilityRule): Promise<void> {
    await this.earn.pool(poolId);
    if (rule.allowedCountries === null && rule.minVerificationTier === null) {
      await this.sql`DELETE FROM bank.earn_pool_availability WHERE pool_id = ${poolId}`;
      return;
    }
    const countries = rule.allowedCountries?.map((c) => c.trim().toUpperCase()) ?? null;
    await this.sql`
      INSERT INTO bank.earn_pool_availability (pool_id, allowed_countries, min_verification_tier)
      VALUES (${poolId}, ${countries}, ${rule.minVerificationTier})
      ON CONFLICT (pool_id) DO UPDATE
         SET allowed_countries = EXCLUDED.allowed_countries,
             min_verification_tier = EXCLUDED.min_verification_tier,
             updated_at = now()
    `;
  }

  async availability(poolId: string, viewer: EarnViewer): Promise<BankEarnAvailability> {
    const pool = await this.earn.pool(poolId);
    return evaluateAvailability(pool, await this.availabilityRule(pool.id), viewer);
  }

  /**
   * Pools offered to this viewer. Hidden pools are filtered out; a kind filter that matches nothing returns empty
   * (not `bank.earn_rate_unset`). The no-rates refusal from `listPools` still stands when nothing is configured.
   */
  async offeredPools(
    viewer: EarnViewer,
    filter: { assetId?: string; kind?: 'flexible' | 'fixed'; limit?: number },
  ): Promise<Array<PoolRecord & { availability: BankEarnAvailability }>> {
    const pools = await this.earn.listPools(filter.assetId, filter.limit);
    const out: Array<PoolRecord & { availability: BankEarnAvailability }> = [];
    for (const pool of pools) {
      if (filter.kind && pool.kind !== filter.kind) continue;
      const availability = evaluateAvailability(pool, await this.availabilityRule(pool.id), viewer);
      if (availability.offered) out.push({ ...pool, availability });
    }
    return out;
  }

  /** A direct deposit into a pool the viewer is not offered refuses; otherwise the existing deposit path. */
  async deposit(
    viewer: EarnViewer,
    input: { poolId: string; userId: string; amount: Amount; positionId: string; now?: Date },
  ): Promise<PositionRecord> {
    const availability = await this.availability(input.poolId, viewer);
    if (!availability.offered && availability.reason !== 'pool_closed') {
      throw new BankError(`Pool ${input.poolId} is not offered here (${availability.reason})`, 'bank.earn_pool_not_offered');
    }
    return this.earn.deposit(input);
  }

  // ── Partial withdraw ───────────────────────────────────────────────────────

  /**
   * Withdraw part (or all) of a position. Claim → post → finish, like deposit:
   *
   *   1. Under a row lock: checks, parity of the column against the stake pot, then a `claimed` row in
   *      `earn_withdrawals` and the position to `deallocating`. Committed.
   *   2. ONE `earnWithdraw` post for `amount`, keyed `bank.earn.withdraw:<positionId>:<clientEventId>`.
   *   3. The claim is `posted`; principal drops by `amount`; the position is `active` again, or `closed` at zero.
   *
   * A definite ledger refusal undoes step 1. Any other failure leaves the claim and `deallocating` for a same-key
   * retry, which re-posts the same key (the ledger returns the committed transaction) and finishes. A different key
   * while a claim is in flight refuses `bank.position_deallocating`. A finished key returns the same result.
   */
  async withdraw(input: {
    positionId: string;
    userId: string;
    amount: Amount;
    clientEventId: string;
    now?: Date;
  }): Promise<WithdrawResult> {
    if (!input.clientEventId) throw new BankError('A withdraw needs a caller-stable client event id', 'bank.event_id_required');
    if (input.amount <= 0n) throw new BankError('Withdraw amount must be positive', 'bank.earn_withdraw_exceeds_principal');
    const now = input.now ?? new Date();
    return withMoneySpan(
      'bank.earn.withdrawPartial',
      { operation: 'earn-withdraw-partial', positionId: input.positionId, amount: formatAmount(input.amount) },
      async () => {
        const step = await this.claim(input, now);
        if (step.kind === 'done') return step.result;
        return this.postAndFinish(step.position, step.claimId, input.amount, input.clientEventId);
      },
    );
  }

  private async claim(
    input: { positionId: string; userId: string; amount: Amount; clientEventId: string },
    now: Date,
  ): Promise<{ kind: 'done'; result: WithdrawResult } | { kind: 'post'; position: PositionRecord; claimId: string }> {
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<
          Array<{
            id: string;
            pool_id: string;
            user_id: string;
            asset_id: string;
            principal: string;
            opened_at: Date;
            matures_at: Date | null;
            status: PositionRecord['status'];
          }>
        >`
          SELECT id, pool_id, user_id, asset_id, (principal - COALESCE((SELECT SUM(w.amount) FROM bank.earn_withdrawals w WHERE w.position_id = earn_positions.id AND w.status = 'posted'), 0)) AS principal, opened_at, matures_at, status
            FROM bank.earn_positions WHERE id = ${input.positionId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new BankError(`Position ${input.positionId} not found`, 'bank.position_not_found');
        if (row.user_id !== input.userId) throw new BankError('Not your position', 'bank.not_owner');
        const position: PositionRecord = {
          id: row.id,
          poolId: row.pool_id,
          userId: row.user_id,
          assetId: row.asset_id,
          principal: parseAmount(row.principal),
          openedAt: row.opened_at,
          maturesAt: row.matures_at,
          status: row.status,
        };

        const existing = await tx<ClaimRow[]>`
          SELECT id, amount, status FROM bank.earn_withdrawals
           WHERE position_id = ${input.positionId} AND client_event_id = ${input.clientEventId}
        `;
        const prior = existing[0];
        if (prior) {
          if (parseAmount(prior.amount) !== input.amount) {
            throw new BankError('This withdraw key was already used for a different amount', 'bank.position_conflict');
          }
          if (prior.status === 'posted') {
            // Derived, never stored: the deposit record less every posted withdraw of this position.
            const open = await tx<Array<{ open: string }>>`
              SELECT (p.principal - COALESCE((SELECT SUM(w.amount) FROM bank.earn_withdrawals w
                                               WHERE w.position_id = p.id AND w.status = 'posted'), 0))::text AS open
                FROM bank.earn_positions p WHERE p.id = ${input.positionId}
            `;
            const remaining = row.status === 'closed' ? 0n : parseAmount(open[0]?.open ?? '0');
            return {
              kind: 'done' as const,
              result: { positionId: position.id, withdrawn: input.amount, remaining, state: remaining === 0n ? 'closed' : 'active' },
            };
          }
          return { kind: 'post' as const, position, claimId: prior.id };
        }

        if (row.status === 'closed') throw new BankError('Position is already closed', 'bank.position_closed');
        if (row.status === 'pending') {
          throw new BankError(
            `Position ${input.positionId} is still pending — resume the deposit before withdrawing`,
            'bank.position_pending',
          );
        }
        if (row.status === 'deallocating') {
          throw new BankError(
            `Position ${input.positionId} has a withdraw in flight — retry it with its own key`,
            'bank.position_deallocating',
          );
        }
        if (row.matures_at && row.matures_at > now) {
          throw new BankError(`Fixed-term position is locked until ${row.matures_at.toISOString()}`, 'bank.position_locked');
        }
        const book = (await this.ledger.balance(earnStakeAccount(row.user_id, row.asset_id, row.id))).amount;
        stakePrincipalForAccrual(row.id, position.principal, book);
        if (input.amount > position.principal) {
          throw new BankError(
            `Withdraw ${formatAmount(input.amount)} exceeds the position's ${formatAmount(position.principal)} ${row.asset_id}`,
            'bank.earn_withdraw_exceeds_principal',
          );
        }

        const claimed = await tx<Array<{ id: string }>>`
          INSERT INTO bank.earn_withdrawals (position_id, client_event_id, amount)
          VALUES (${input.positionId}, ${input.clientEventId}, ${formatAmount(input.amount)}::numeric)
          RETURNING id
        `;
        await tx`UPDATE bank.earn_positions SET status = 'deallocating' WHERE id = ${input.positionId}`;
        return { kind: 'post' as const, position, claimId: claimed[0]!.id };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  private async postAndFinish(position: PositionRecord, claimId: string, amount: Amount, clientEventId: string): Promise<WithdrawResult> {
    let ledgerTxId: string;
    try {
      const tx = await this.ledger.post({
        ...recipes.earnWithdraw({
          positionId: position.id,
          poolId: position.poolId,
          userId: position.userId,
          assetId: position.assetId,
          amount,
        }),
        idempotencyKey: earnWithdrawKey(position.id, clientEventId),
      });
      ledgerTxId = tx.id;
    } catch (err) {
      if (isDefiniteLedgerRefusal(err)) {
        // Nothing moved under this key: release the claim and give the position back.
        await transaction(this.sql, async (tx) => {
          await tx`DELETE FROM bank.earn_withdrawals WHERE id = ${claimId} AND status = 'claimed'`;
          await tx`UPDATE bank.earn_positions SET status = 'active' WHERE id = ${position.id} AND status = 'deallocating'`;
        });
      }
      throw err;
    }

    return transaction(
      this.sql,
      async (tx) => {
        // `earn_positions.principal` stays the deposit RECORD (written once, §0.6). The open principal is that record
        // less the posted withdraws; this one is posted in the same transaction as the state change.
        const open = await tx<Array<{ open: string }>>`
          SELECT (p.principal - COALESCE((SELECT SUM(w.amount) FROM bank.earn_withdrawals w
                                           WHERE w.position_id = p.id AND (w.status = 'posted' OR w.id = ${claimId})), 0))::text AS open
            FROM bank.earn_positions p WHERE p.id = ${position.id}
        `;
        const remaining = parseAmount(open[0]?.open ?? '0');
        await tx`
          UPDATE bank.earn_positions
             SET status = ${remaining === 0n ? 'closed' : 'active'}::bank.position_status,
                 closed_at = ${remaining === 0n ? new Date() : null}
           WHERE id = ${position.id} AND status = 'deallocating'
        `;
        await tx`
          UPDATE bank.earn_withdrawals
             SET status = 'posted', ledger_tx_id = ${ledgerTxId}, posted_at = now()
           WHERE id = ${claimId} AND status = 'claimed'
        `;
        return {
          positionId: position.id,
          withdrawn: amount,
          remaining,
          state: remaining === 0n ? ('closed' as const) : ('active' as const),
        };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** Recovery: re-drive every in-flight claim on its own key. Same shape as `resumePending`. Limit is required. */
  async resumeDeallocating(limit: number): Promise<Array<{ positionId: string; outcome: 'completed' | 'failed'; reason?: string }>> {
    if (!Number.isInteger(limit) || limit < 1)
      throw new BankError('resumeDeallocating needs an explicit batch limit', 'bank.event_id_required');
    const rows = await this.sql<Array<{ id: string; position_id: string; client_event_id: string; amount: string; user_id: string }>>`
      SELECT w.id, w.position_id, w.client_event_id, w.amount, p.user_id
        FROM bank.earn_withdrawals w JOIN bank.earn_positions p ON p.id = w.position_id
       WHERE w.status = 'claimed' ORDER BY w.created_at ASC LIMIT ${limit}
    `;
    const out: Array<{ positionId: string; outcome: 'completed' | 'failed'; reason?: string }> = [];
    for (const r of rows) {
      try {
        await this.withdraw({
          positionId: r.position_id,
          userId: r.user_id,
          amount: parseAmount(r.amount),
          clientEventId: r.client_event_id,
        });
        out.push({ positionId: r.position_id, outcome: 'completed' });
      } catch (err) {
        out.push({ positionId: r.position_id, outcome: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  // ── Settings and the auto program ──────────────────────────────────────────

  async settings(userId: string): Promise<{ autoPrograms: AutoProgram[] }> {
    const rows = await this.sql<Array<{ asset_id: string; pool_id: string; enabled: boolean; cap: string | null }>>`
      SELECT asset_id, pool_id, enabled, cap FROM bank.earn_auto_programs WHERE user_id = ${userId} ORDER BY asset_id ASC
    `;
    return {
      autoPrograms: rows.map((r) => ({
        assetId: r.asset_id,
        poolId: r.pool_id,
        enabled: r.enabled,
        cap: r.cap === null ? null : parseAmount(r.cap),
      })),
    };
  }

  /**
   * Replace the user's auto programs. Enabling with a blank cap refuses `bank.autoearn_cap_unset` (owner value, never
   * defaulted). Each program's pool must be open, match the asset, and be offered to the viewer. The same commandId
   * replays; a different payload under it refuses `bank.earn_settings_conflict`.
   */
  async setSettings(
    viewer: EarnViewer,
    input: { userId: string; commandId: string; autoPrograms: AutoProgram[] },
  ): Promise<{ autoPrograms: AutoProgram[] }> {
    const seen = new Set<string>();
    for (const p of input.autoPrograms) {
      if (p.enabled && p.cap === null) {
        throw new BankError(`Auto earn for ${p.assetId} needs a per-asset cap`, 'bank.autoearn_cap_unset');
      }
      if (seen.has(p.assetId)) throw new BankError(`Two auto programs for ${p.assetId}`, 'bank.earn_settings_conflict');
      seen.add(p.assetId);
      const pool = await this.earn.pool(p.poolId);
      if (pool.assetId !== p.assetId) throw new BankError(`Pool ${pool.id} is not a ${p.assetId} pool`, 'bank.asset_mismatch');
      if (p.enabled) {
        const availability = evaluateAvailability(pool, await this.availabilityRule(pool.id), viewer);
        if (!availability.offered) {
          throw new BankError(`Pool ${pool.id} is not offered here (${availability.reason})`, 'bank.earn_pool_not_offered');
        }
      }
    }
    const hash = createHash('sha256')
      .update(JSON.stringify(input.autoPrograms.map((p) => [p.assetId, p.poolId, p.enabled, p.cap === null ? null : formatAmount(p.cap)])))
      .digest('hex');

    await transaction(
      this.sql,
      async (tx) => {
        const inserted = await tx<Array<{ command_id: string }>>`
          INSERT INTO bank.earn_settings_commands (user_id, command_id, payload_hash)
          VALUES (${input.userId}, ${input.commandId}, ${hash})
          ON CONFLICT (user_id, command_id) DO NOTHING
          RETURNING command_id
        `;
        if (inserted.length === 0) {
          const prior = await tx<Array<{ payload_hash: string }>>`
            SELECT payload_hash FROM bank.earn_settings_commands WHERE user_id = ${input.userId} AND command_id = ${input.commandId}
          `;
          if (prior[0]?.payload_hash !== hash) {
            throw new BankError('This settings command id was already used for different settings', 'bank.earn_settings_conflict');
          }
          return;
        }
        await tx`DELETE FROM bank.earn_auto_programs WHERE user_id = ${input.userId}`;
        for (const p of input.autoPrograms) {
          await tx`
            INSERT INTO bank.earn_auto_programs (user_id, asset_id, pool_id, enabled, cap)
            VALUES (${input.userId}, ${p.assetId}, ${p.poolId}, ${p.enabled}, ${p.cap === null ? null : formatAmount(p.cap)})
          `;
        }
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
    return this.settings(input.userId);
  }

  /**
   * What the auto program would sweep for one asset now: the idle amount up to the cap, less what the user already
   * holds in active positions of that asset. A disabled program sweeps nothing. A blank cap on an enabled program
   * (only reachable by a row written outside setSettings) refuses rather than sweeping uncapped.
   */
  async autoSweepAmount(userId: string, assetId: string, idle: Amount): Promise<Amount> {
    const rows = await this.sql<Array<{ enabled: boolean; cap: string | null }>>`
      SELECT enabled, cap FROM bank.earn_auto_programs WHERE user_id = ${userId} AND asset_id = ${assetId}
    `;
    const program = rows[0];
    if (!program || !program.enabled) return 0n;
    if (program.cap === null) throw new BankError(`Auto earn for ${assetId} has no cap`, 'bank.autoearn_cap_unset');
    const held = await this.earn.principalOf(userId, assetId);
    const room = parseAmount(program.cap) - held;
    if (room <= 0n || idle <= 0n) return 0n;
    return idle < room ? idle : room;
  }
}
