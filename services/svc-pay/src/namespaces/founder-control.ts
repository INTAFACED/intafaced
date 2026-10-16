import { z } from 'zod';
import {
  router,
  merchantControlGetInputSchema,
  merchantControlProfileSchema,
  founderChangeSubmitInputSchema,
  founderChangeSubmitResultSchema,
  founderChangeConfirmInputSchema,
  founderApprovalQueueInputSchema,
  founderApprovalQueueSchema,
  founderApprovalDestinationInputSchema,
  founderApprovalDestinationSchema,
  founderControlAuditListInputSchema,
  founderControlAuditListSchema,
  founderPendingChangeListInputSchema,
  founderPendingChangeListSchema,
  payoutApprovalSchema,
} from '@intafaced/contracts';
import type { ChangeOutcome } from '../control/changes.js';
import { toContractApproval } from '../control/approvals.js';
import { ControlError } from '../control/errors.js';
import type { ControlService } from '../control/service.js';
import {
  controlConfigureInputSchema,
  controlConfigureResultSchema,
  founderApprovalDecideInputSchema,
  pricingRuleListInputSchema,
  pricingRuleViewSchema,
  tierListInputSchema,
  tierViewSchema,
  usageViewSchema,
} from '../control/schemas.js';
import { guarded } from './control-errors.js';
import type { founderProcedure } from './founder-procedure.js';

type Founder = ReturnType<typeof founderProcedure>;

const founderIdOf = (ctx: unknown): string => (ctx as { founderUserId: string }).founderUserId;

async function merchantResult(control: ControlService, outcome: ChangeOutcome) {
  const merchantId = outcome.merchantId as string;
  return {
    requestId: outcome.requestId,
    merchantId,
    outcome: outcome.outcome,
    actorUserId: outcome.actorUserId,
    profile: await control.profile(merchantId),
    occurredAt: outcome.occurredAt.toISOString(),
  };
}

/** The contract's merchant-scoped change procedures (`founderAdmin.changes.*`) backed by the control room. */
export function founderChangeProcedures(founder: Founder, control: ControlService) {
  return {
    submit: founder
      .input(founderChangeSubmitInputSchema)
      .output(founderChangeSubmitResultSchema)
      .mutation(({ ctx, input }) =>
        guarded(async () =>
          merchantResult(
            control,
            await control.changes.submit(founderIdOf(ctx), {
              requestId: input.requestId,
              target: { scope: 'merchant', merchantId: input.merchantId, change: input.change },
              reason: input.reason,
              expectedVersion: input.expectedVersion,
            }),
          ),
        ),
      ),
    confirm: founder
      .input(founderChangeConfirmInputSchema)
      .output(founderChangeSubmitResultSchema)
      .mutation(({ ctx, input }) =>
        guarded(async () => {
          // This procedure answers in the merchant shape; tier and pricing changes confirm under `control.configure`.
          if ((await control.changes.scopeOfRequest(input.requestId)) !== 'merchant') throw new ControlError('pay.change_not_found');
          return merchantResult(control, await control.changes.confirm(founderIdOf(ctx), input));
        }),
      ),
    pending: founder
      .input(founderPendingChangeListInputSchema)
      .output(founderPendingChangeListSchema)
      .query(({ input }) => guarded(() => control.changes.listPending(input))),
  };
}

export function founderApprovalProcedures(founder: Founder, control: ControlService) {
  return {
    list: founder
      .input(founderApprovalQueueInputSchema)
      .output(founderApprovalQueueSchema)
      .query(({ input }) => guarded(() => control.approvals.founderQueue(input))),
    /** Full destination of one queue row. A mutation so a reveal is never a cached GET: each call is one audit row. */
    destination: founder
      .input(founderApprovalDestinationInputSchema)
      .output(founderApprovalDestinationSchema)
      .mutation(({ ctx, input }) => guarded(() => control.approvals.founderDestination(founderIdOf(ctx), input.approvalId))),
  };
}

/** `founderAdmin.control.*`: tier definitions, pricing layers, usage, and the founder side of payout approvals. */
export function createFounderControlRouter(founder: Founder, control: ControlService) {
  const configureResult = (o: ChangeOutcome) => ({
    requestId: o.requestId,
    scope: o.scope === 'pricing' ? ('pricing' as const) : ('tier' as const),
    scopeId: o.scopeId,
    outcome: o.outcome,
    actorUserId: o.actorUserId,
    version: o.version.toString(),
    occurredAt: o.occurredAt.toISOString(),
  });
  return router({
    tiers: router({
      list: founder
        .input(tierListInputSchema)
        .output(z.array(tierViewSchema))
        .query(() => guarded(() => control.listTiers())),
    }),
    pricing: router({
      rules: founder
        .input(pricingRuleListInputSchema)
        .output(z.array(pricingRuleViewSchema))
        .query(({ input }) => guarded(() => control.listRules(input))),
    }),
    merchant: router({
      get: founder
        .input(merchantControlGetInputSchema)
        .output(merchantControlProfileSchema)
        .query(({ input }) => guarded(() => control.profile(input.merchantId))),
      usage: founder
        .input(merchantControlGetInputSchema)
        .output(usageViewSchema)
        .query(({ input }) => guarded(() => control.usage(input.merchantId))),
    }),
    configure: router({
      submit: founder
        .input(controlConfigureInputSchema)
        .output(controlConfigureResultSchema)
        .mutation(({ ctx, input }) =>
          guarded(async () =>
            configureResult(
              await control.changes.submit(founderIdOf(ctx), {
                requestId: input.requestId,
                target:
                  input.change.kind === 'upsert_tier'
                    ? { scope: 'tier', change: input.change }
                    : { scope: 'pricing', change: input.change },
                reason: input.reason,
                expectedVersion: input.expectedVersion,
              }),
            ),
          ),
        ),
      confirm: founder
        .input(founderChangeConfirmInputSchema)
        .output(controlConfigureResultSchema)
        .mutation(({ ctx, input }) =>
          guarded(async () => {
            const scope = await control.changes.scopeOfRequest(input.requestId);
            if (scope !== 'tier' && scope !== 'pricing') throw new ControlError('pay.change_not_found');
            return configureResult(await control.changes.confirm(founderIdOf(ctx), input));
          }),
        ),
    }),
    approvals: router({
      decide: founder
        .input(founderApprovalDecideInputSchema)
        .output(payoutApprovalSchema)
        .mutation(({ ctx, input }) =>
          guarded(async () => toContractApproval(await control.approvals.founderDecide(founderIdOf(ctx), input))),
        ),
    }),
    audit: router({
      list: founder
        .input(founderControlAuditListInputSchema)
        .output(founderControlAuditListSchema)
        .query(({ input }) => guarded(() => control.listAudit(input))),
    }),
  });
}
