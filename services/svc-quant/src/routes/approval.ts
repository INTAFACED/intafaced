import {
  QUANT_APPROVAL_DECIDED,
  QUANT_APPROVAL_HASH_STALE,
  QUANT_APPROVAL_NOT_FOUND,
  QUANT_APPROVAL_NOT_REVIEWER,
  QUANT_APPROVAL_POLICY_UNSET,
  QUANT_APPROVAL_SELF_REVIEW,
  QuantError,
} from '../errors.js';
import {
  publicJurisdictionProcedure,
  quantApprovalDecideInputSchema,
  quantApprovalPolicySchema,
  quantApprovalPolicySetInputSchema,
  quantApprovalRequestInputSchema,
  quantApprovalStateSchema,
  router,
} from '@intafaced/contracts';
import { z } from 'zod';
import { toTrpc, accountField, missingStrategy, type QuantCore } from './core.js';

export function approvalRoutes(core: QuantCore) {
  const { strategies, now, approvals, approvalHashOf, approvalStrategy, approvalStateOf, accountOf } = core;
  return router({
    policy: router({
      get: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ ...accountField }).optional())
        .output(quantApprovalPolicySchema)
        .query(async ({ input, ctx }) => {
          try {
            const policy = await approvals.policy(accountOf(ctx, input?.accountId));
            return { required: policy ? policy.required : null, setAt: policy?.setAt ?? null };
          } catch (err) {
            toTrpc(err);
          }
        }),
      set: publicJurisdictionProcedure('quant', 'fiat')
        .input(quantApprovalPolicySetInputSchema.extend(accountField))
        .output(quantApprovalPolicySchema)
        .mutation(async ({ input, ctx }) => {
          try {
            const accountId = accountOf(ctx, input.accountId);
            const stored = await approvals.setPolicy({
              accountId,
              required: input.required,
              key: `quant.approval_policy:${accountId}:${input.idempotencyKey}`,
              actor: ctx.principal?.userId ?? accountId,
              at: new Date(now()),
            });
            return { required: stored.required, setAt: stored.setAt };
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),

    /** One strategy's approvals and whether its newest version may go live now. The owner or a teammate reads it. */
    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantApprovalStateSchema)
      .query(async ({ input, ctx }) => {
        try {
          return await approvalStateOf(accountOf(ctx, input.accountId), input.strategyId);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * The owner asks for an independent review of one version, bound to its hash now, under
     * `quant.approval:<strategy>:v<n>:<hash8>:request`: the same ask again is the same request. With no policy set it
     * refuses `quant.approval_policy_unset`.
     */
    request: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantApprovalRequestInputSchema.extend(accountField))
      .output(quantApprovalStateSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await strategies.get({ accountId, id: input.strategyId });
          if (!found || found.deletedAt) missingStrategy();
          const policy = await approvals.policy(accountId);
          if (!policy) {
            throw new QuantError(QUANT_APPROVAL_POLICY_UNSET, 'this account has not set whether live use needs an independent review');
          }
          const hash = await approvalHashOf(found, input.strategyVersion);
          await approvals.request({
            key: `quant.approval:${found.id}:v${input.strategyVersion}:${hash.slice(0, 8)}:request`,
            accountId,
            strategyId: found.id,
            strategyVersion: input.strategyVersion,
            contentHash: hash,
            requester: ctx.principal?.userId ?? accountId,
            requestedAt: new Date(now()).toISOString(),
          });
          return await approvalStateOf(accountId, found.id);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * A teammate decides one request, once. The requester, or the owner on their own strategy, refuses
     * `quant.approval_self_review`; a request whose version or risk settings changed since refuses
     * `quant.approval_hash_stale`; a decided request answers its decision again when the same reviewer sends the
     * same decision, and refuses `quant.approval_decided` otherwise.
     */
    decide: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantApprovalDecideInputSchema.extend(accountField))
      .output(quantApprovalStateSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const callerId = accountOf(ctx, input.accountId);
          const { found, member } = await approvalStrategy(callerId, input.strategyId);
          const row = await approvals.get(input.approvalId);
          if (!row || row.strategyId !== found.id) throw new QuantError(QUANT_APPROVAL_NOT_FOUND, 'approval request not found');
          if (callerId === row.requester || callerId === found.accountId) {
            throw new QuantError(
              QUANT_APPROVAL_SELF_REVIEW,
              'a different member must review this version; you cannot approve your own request',
            );
          }
          if (!member) throw new QuantError(QUANT_APPROVAL_NOT_REVIEWER, 'only a teammate this strategy is shared with can review it');
          if (row.decision !== 'pending') {
            if (row.reviewer === callerId && row.decision === input.decision) return await approvalStateOf(callerId, found.id);
            throw new QuantError(QUANT_APPROVAL_DECIDED, `this request was already ${row.decision}`);
          }
          if (
            !found.versions.some((v) => v.version === row.strategyVersion) ||
            (await approvalHashOf(found, row.strategyVersion)) !== row.contentHash
          ) {
            throw new QuantError(
              QUANT_APPROVAL_HASH_STALE,
              `version ${row.strategyVersion} changed after this request; ask for a new review`,
            );
          }
          const decided = await approvals.decide({
            id: row.id,
            reviewer: callerId,
            decision: input.decision,
            reason: input.reason,
            at: new Date(now()),
          });
          if (!decided) {
            const again = await approvals.get(row.id);
            if (!(again?.reviewer === callerId && again.decision === input.decision)) {
              throw new QuantError(QUANT_APPROVAL_DECIDED, 'this request was already decided');
            }
          }
          return await approvalStateOf(callerId, found.id);
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
