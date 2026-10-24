import { z } from 'zod';
import {
  businessCategorySchema,
  categoryPolicyEventSchema,
  categoryPolicyHistoryInputSchema,
  categoryPolicyListInputSchema,
  categoryPolicyPreviewInputSchema,
  categoryPolicyPreviewSchema,
  categoryPolicySetInputSchema,
  categoryPolicyViewSchema,
  router,
  TRPCError,
} from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { DualControlError } from '../dual-control.js';
import type { FounderAuthority } from '../founder-authority.js';
import { founderProcedure, type FounderContext } from '../namespaces/founder-procedure.js';
import { CategoryPolicyError, CategoryPolicyService } from './category.js';

const KIND: Record<string, TRPCError['code']> = {
  'pay.business_category_policy_unset': 'PRECONDITION_FAILED',
  'pay.category_not_found': 'NOT_FOUND',
  'pay.category_exists': 'CONFLICT',
  'pay.category_version_conflict': 'CONFLICT',
  'pay.category_policy_changed': 'CONFLICT',
  'pay.category_locked': 'FORBIDDEN',
  'pay.category_unchanged': 'BAD_REQUEST',
};

/** Category refusals keep their typed code as the cause; approval and dual-control refusals are preconditions. */
export function categoryToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CategoryPolicyError) {
    return new TRPCError({ code: KIND[error.code] ?? 'BAD_REQUEST', message: `${error.code}: ${error.message}`, cause: error });
  }
  if (error instanceof DualControlError || error instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
  }
  return error;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw categoryToTrpcError(error);
  }
}

function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

export interface CategoryPolicyMountDeps {
  sql: Sql;
  approvals: ActionApprovalConsumer;
}

/**
 * `founderAdmin.categoryPolicy.*` (RC-merchant-08): the business category table. Founder-only, every procedure from
 * `founderProcedure`; every edit needs a second founder's approval bound to `preview`'s hash.
 */
export function createCategoryPolicyRouter(deps: CategoryPolicyMountDeps & { founderAuthority: FounderAuthority }) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new CategoryPolicyService(deps.sql, deps.approvals);
  return router({
    list: founder
      .input(categoryPolicyListInputSchema)
      .output(categoryPolicyViewSchema)
      .query(() => wrap(() => service.list())),
    history: founder
      .input(categoryPolicyHistoryInputSchema)
      .output(z.array(categoryPolicyEventSchema))
      .query(({ input }) => wrap(() => service.history(input.key, input.limit))),
    preview: founder
      .input(categoryPolicyPreviewInputSchema)
      .output(categoryPolicyPreviewSchema)
      .query(({ input }) => wrap(() => service.preview(input))),
    set: founder
      .input(categoryPolicySetInputSchema)
      .output(businessCategorySchema)
      .mutation(({ ctx, input }) => wrap(() => service.set(actorOf(ctx), input))),
  });
}
