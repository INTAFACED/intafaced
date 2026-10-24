import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ACTION_APPROVAL_MISSING } from './auth/privileged-dual-control.js';
import type { ActionApprovalService } from './auth/action-approval-service.js';
import type { RankService } from './rank/rank-service.js';
import { LimitFeeTierError, RANK_NOT_FOUND, changeFeeTier, changeLimit } from './rank/limit-fee-tier.js';

/**
 * Top-level limit / fee-tier change so mergeRouters cannot nest-replace rank.perks.
 * Dual-control: actor is the signed principal; confirmActorId is a second distinct operator.
 * Does not invent bps — caller must name feeDiscountBps / p2pLimitMultiplier.
 */
export function createLimitFeeTierRouter(sql: Sql, rank: RankService, approvals: Pick<ActionApprovalService, 'consume'>) {
  const view = z.object({
    rank: z.number().int().min(0),
    feeDiscountBps: z.number().int().min(0).max(10_000),
    p2pLimitMultiplier: z.number().min(1),
  });

  function mapErr(err: unknown): never {
    if (err instanceof LimitFeeTierError) {
      if (err.code === RANK_NOT_FOUND) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      }
      if (err.code === ACTION_APPROVAL_MISSING) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      }
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
    throw err;
  }

  return router({
    changeFeeTier: scopedProcedure('admin:compliance')
      .input(
        z.object({
          rank: z.number().int().min(0),
          feeDiscountBps: z.number().int().min(0).max(10_000),
          confirmActorId: z.string().guid().optional(),
          approvalId: z.string().max(128).nullish(),
          operationId: z.string().max(128).nullish(),
        }),
      )
      .output(view)
      .mutation(async ({ ctx, input }) => {
        try {
          return await changeFeeTier(
            sql,
            { rank: input.rank, feeDiscountBps: input.feeDiscountBps },
            {
              actorId: ctx.principal.userId,
              confirmActorId: input.confirmActorId,
              approvalId: input.approvalId,
              operationId: input.operationId,
              targetId: 'identity.change_fee_tier',
            },
            rank,
            approvals,
          );
        } catch (err) {
          mapErr(err);
        }
      }),

    changeLimit: scopedProcedure('admin:compliance')
      .input(
        z.object({
          rank: z.number().int().min(0),
          p2pLimitMultiplier: z.number().min(1),
          confirmActorId: z.string().guid().optional(),
          approvalId: z.string().max(128).nullish(),
          operationId: z.string().max(128).nullish(),
        }),
      )
      .output(view)
      .mutation(async ({ ctx, input }) => {
        try {
          return await changeLimit(
            sql,
            { rank: input.rank, p2pLimitMultiplier: input.p2pLimitMultiplier },
            {
              actorId: ctx.principal.userId,
              confirmActorId: input.confirmActorId,
              approvalId: input.approvalId,
              operationId: input.operationId,
              targetId: 'identity.change_limit',
            },
            rank,
            approvals,
          );
        } catch (err) {
          mapErr(err);
        }
      }),
  });
}
