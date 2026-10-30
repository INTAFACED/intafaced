/**
 * Operator earn pool doors (BK-earn-05, J-bank-08 #1): open a pool, and change a flexible pool's rate.
 *
 * `createPool` existed in the service with no procedure, and nothing could change a rate at all, so a pool's rate had no
 * history. Both doors are treasury with a second person: an identity approval bound to every term, consumed only after
 * the terms pass the checks, so a wrong form never spends the second person. Nothing is defaulted: a minimum deposit of
 * zero is typed as "0". The caller names the pool id, so a retried create is the same pool. A rate change moves the
 * pool's rate and writes its history record in one transaction (`earn/rate-history.ts`); a fixed-term pool's rate never
 * changes.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;
type ConsumeOpsApproval = (
  input: { approvalId?: string | null; operationId?: string | null },
  actionType: string,
  fields: Record<string, string>,
) => Promise<string>;
type ConsumeOpsApprovalPair = (
  input: { approvalId?: string | null; operationId?: string | null },
  actionType: string,
  fields: Record<string, string>,
) => Promise<{ approvalId: string; requesterId: string; approverId: string }>;

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');
/** `apr_bps` is numeric(8,0): the column's own bound, not a product limit. */
const rateBps = z.number().int().min(0).max(99_999_999);

export const CREATE_EARN_POOL_ACTION = 'bank.ops.createEarnPool';
export const SET_EARN_POOL_RATE_ACTION = 'bank.ops.setEarnPoolRate';
export const SET_EARN_POOL_STATUS_ACTION = 'bank.ops.setEarnPoolStatus';

const poolInput = z.object({
  poolId: z.string().guid(),
  assetId: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,16}$/, 'asset code in capitals, as the ledger names it'),
  kind: z.enum(['flexible', 'fixed']),
  name: z.string().trim().min(3).max(120),
  aprBps: rateBps,
  termDays: z.number().int().min(1).max(3650).nullable(),
  minDeposit: amountString,
  /** Staking-style (BK-earn-04): days a saving taken back unbonds. Flexible only; omit or null for no unbonding. */
  unbondingDays: z.number().int().min(1).max(365).nullish(),
});

export type CreateEarnPoolInput = z.infer<typeof poolInput>;

/** The fields the approval is bound to, in canonical form. The client hashes the same strings. */
export function createEarnPoolFields(input: CreateEarnPoolInput): Record<string, string> {
  return {
    poolId: input.poolId,
    assetId: input.assetId.trim(),
    kind: input.kind,
    name: input.name.trim(),
    aprBps: String(input.aprBps),
    termDays: input.termDays === null ? '' : String(input.termDays),
    minDeposit: formatAmount(parseAmount(input.minDeposit)),
    // Only a pool that unbonds names it, so the fields of every other pool hash as they always did.
    ...(input.unbondingDays == null ? {} : { unbondingDays: String(input.unbondingDays) }),
  };
}

const rateInput = z.object({
  poolId: z.string().guid(),
  rateBps,
  reason: z.string().trim().min(3).max(300),
});

export type SetEarnPoolRateInput = z.infer<typeof rateInput>;

export function setEarnPoolRateFields(input: SetEarnPoolRateInput): Record<string, string> {
  return { poolId: input.poolId, rateBps: String(input.rateBps), reason: input.reason.trim() };
}

const statusInput = z.object({
  poolId: z.string().guid(),
  status: z.enum(['open', 'closed']),
  reason: z.string().trim().min(3).max(300),
  /** The pool's next status revision (its current one plus one): the change's key `pool-status:<poolId>:<revision>`. */
  revision: z.number().int().min(1).max(2_147_483_647),
});

export type SetEarnPoolStatusInput = z.infer<typeof statusInput>;

export function setEarnPoolStatusFields(input: SetEarnPoolStatusInput): Record<string, string> {
  return { poolId: input.poolId, status: input.status, reason: input.reason.trim(), revision: String(input.revision) };
}

const approval = { approvalId: z.string().max(128).nullish(), operationId: z.string().max(128).nullish() };

export function createEarnPoolProcedure(bank: BankServices, consumeOpsApproval: ConsumeOpsApproval, guard: Guard) {
  return scopedProcedure('admin:treasury')
    .input(poolInput.extend(approval))
    .output(
      z.object({
        poolId: z.string().guid(),
        kind: z.enum(['flexible', 'fixed']),
        aprBps: z.number().int(),
        termDays: z.number().int().nullable(),
        minDeposit: amountString,
        status: z.enum(['open', 'closed']),
        unbondingDays: z.number().int().nullable(),
        approvedBy: z.string(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        // Checked before the approval is consumed, so a wrong form does not spend the second person.
        if (input.kind === 'fixed' && input.termDays === null) {
          throw new BankError('A fixed-term pool needs its term in days', 'bank.pool_terms_invalid');
        }
        if (input.kind === 'flexible' && input.termDays !== null) {
          throw new BankError('A flexible pool has no term', 'bank.pool_terms_invalid');
        }
        if (input.kind === 'fixed' && input.unbondingDays != null) {
          throw new BankError('Only a flexible pool unbonds: a fixed term already has its own lock', 'bank.pool_terms_invalid');
        }
        const approvedBy = await consumeOpsApproval(input, CREATE_EARN_POOL_ACTION, createEarnPoolFields(input));
        const pool = await bank.earn.createPool({
          id: input.poolId,
          assetId: input.assetId.trim(),
          kind: input.kind,
          name: input.name.trim(),
          aprBps: input.aprBps,
          termDays: input.termDays,
          minDeposit: parseAmount(input.minDeposit),
          unbondingDays: input.unbondingDays ?? null,
        });
        return {
          poolId: pool.id,
          kind: pool.kind,
          aprBps: pool.aprBps,
          termDays: pool.termDays,
          minDeposit: formatAmount(pool.minDeposit),
          status: pool.status,
          unbondingDays: pool.unbondingDays,
          approvedBy,
        };
      }),
    );
}

export function setEarnPoolRateProcedure(bank: BankServices, consumeOpsApproval: ConsumeOpsApproval, guard: Guard) {
  return scopedProcedure('admin:treasury')
    .input(rateInput.extend(approval))
    .output(
      z.object({
        poolId: z.string().guid(),
        rateBps: z.number().int(),
        previousBps: z.number().int(),
        effectiveAt: z.string(),
        approvedBy: z.string(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        // The pool must exist and be flexible before the second person is spent.
        const pool = await bank.earn.pool(input.poolId);
        if (pool.kind === 'fixed') {
          throw new BankError(
            'A fixed-term pool keeps the rate it opened with; publish a new pool for a new rate',
            'bank.fixed_pool_rate_locked',
          );
        }
        if (pool.aprBps === input.rateBps) throw new BankError(`The pool already pays ${input.rateBps} bps`, 'bank.pool_rate_unchanged');
        const fields = setEarnPoolRateFields(input);
        const approvedBy = await consumeOpsApproval(input, SET_EARN_POOL_RATE_ACTION, fields);
        const changed = await bank.earn.setPoolRate({
          poolId: input.poolId,
          rateBps: input.rateBps,
          reason: fields.reason!,
          approvalId: input.approvalId!,
        });
        return {
          poolId: changed.poolId,
          rateBps: changed.rateBps,
          previousBps: changed.previousBps,
          effectiveAt: changed.effectiveAt.toISOString(),
          approvedBy,
        };
      }),
    );
}

/**
 * Close a pool to new savings, or open it again (BK-earn-04, J-bank-08 #6): treasury with a second person, bound to the
 * pool, the status, the reason and the revision. The savings a closed pool holds keep accruing and can be taken back.
 * The unchanged and stale checks run under the pool's row lock before the approval is spent (`EarnService.setPoolStatus`).
 */
export function setEarnPoolStatusProcedure(bank: BankServices, consumeOpsApprovalPair: ConsumeOpsApprovalPair, guard: Guard) {
  return scopedProcedure('admin:treasury')
    .input(statusInput.extend(approval))
    .output(
      z.object({
        poolId: z.string().guid(),
        status: z.enum(['open', 'closed']),
        previousStatus: z.enum(['open', 'closed']),
        revision: z.number().int(),
        approvedBy: z.string(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => {
        const fields = setEarnPoolStatusFields(input);
        return bank.earn.setPoolStatus({
          poolId: input.poolId,
          status: input.status,
          reason: fields.reason!,
          revision: input.revision,
          approve: () => consumeOpsApprovalPair(input, SET_EARN_POOL_STATUS_ACTION, fields),
        });
      }),
    );
}
