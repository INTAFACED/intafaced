import {
  founderChangeConfirmInputSchema,
  founderApprovalDestinationInputSchema,
  founderApprovalDestinationSchema,
  founderControlAuditListInputSchema,
  founderControlAuditListSchema,
  founderPendingChangeListInputSchema,
  founderPendingChangeListSchema,
} from '@intafaced/contracts/founder-admin';
import {
  founderLimitRequestCloseInputSchema,
  founderLimitRequestCloseResultSchema,
  payoutApprovalSchema,
} from '@intafaced/contracts/merchant-control';
import { router } from '@intafaced/contracts/trpc';
import type { ChangeOutcome } from '../control/changes.js';
import { toContractApproval } from '../control/approvals.js';
import { ControlError } from '../control/errors.js';
import type { ControlService } from '../control/service.js';
import { controlConfigureInputSchema, controlConfigureResultSchema, founderApprovalDecideInputSchema } from '../control/schemas.js';
import { guarded } from './control-errors.js';
import { notBuilt } from './errors.js';
import type { founderProcedure } from './founder-procedure.js';
import {
  PAY_FOUNDER_ADMIN_CONTROL_TIERS_LIST,
  PAY_FOUNDER_ADMIN_CONTROL_LIMIT_REQUESTS_LIST,
  PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_GET,
  PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_USAGE,
  PAY_FOUNDER_ADMIN_CONTROL_PRICING_RULES,
  PAY_FOUNDER_ADMIN_CHANGES_SUBMIT,
  PAY_FOUNDER_ADMIN_CHANGES_CONFIRM,
  PAY_FOUNDER_ADMIN_APPROVALS_LIST,
} from '@intafaced/contracts/pay-founder-admin-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from '../record-refusal.js';

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

/**
 * The contract's merchant-scoped change procedures (`founderAdmin.changes.*`) backed by the control room. One procedure
 * per path: with no control room each refuses as not built, so the path never has a second, stand-in procedure.
 */
export function founderChangeProcedures(founder: Founder, control: ControlService | undefined) {
  return {
    submit: mountRecord(
      PAY_FOUNDER_ADMIN_CHANGES_SUBMIT,
      ({ ctx, input }) => {
        if (!control) return notBuilt('founderAdmin.changes.submit');
        return guarded(async () =>
          merchantResult(
            control,
            await control.changes.submit(founderIdOf(ctx), {
              requestId: input.requestId,
              target: { scope: 'merchant', merchantId: input.merchantId, change: input.change },
              reason: input.reason,
              expectedVersion: input.expectedVersion,
            }),
          ),
        );
      },
      { refusalOf: payRefusal, founder },
    ),
    confirm: mountRecord(
      PAY_FOUNDER_ADMIN_CHANGES_CONFIRM,
      ({ ctx, input }) => {
        if (!control) return notBuilt('founderAdmin.changes.confirm');
        return guarded(async () => {
          // This procedure answers in the merchant shape; tier and pricing changes confirm under `control.configure`.
          if ((await control.changes.scopeOfRequest(input.requestId)) !== 'merchant') throw new ControlError('pay.change_not_found');
          return merchantResult(control, await control.changes.confirm(founderIdOf(ctx), input));
        });
      },
      { refusalOf: payRefusal, founder },
    ),
    pending: founder
      .input(founderPendingChangeListInputSchema)
      .output(founderPendingChangeListSchema)
      .query(({ input }) => (control ? guarded(() => control.changes.listPending(input)) : notBuilt('founderAdmin.changes.pending'))),
  };
}

/** `founderAdmin.approvals.*`: one procedure per path, refusing as not built with no control room. */
export function founderApprovalProcedures(founder: Founder, control: ControlService | undefined) {
  return {
    list: mountRecord(
      PAY_FOUNDER_ADMIN_APPROVALS_LIST,
      ({ input }) => (control ? guarded(() => control.approvals.founderQueue(input)) : notBuilt('founderAdmin.approvals.list')),
      { refusalOf: payRefusal, founder },
    ),
    /** Full destination of one queue row. A mutation so a reveal is never a cached GET: each call is one audit row. */
    destination: founder
      .input(founderApprovalDestinationInputSchema)
      .output(founderApprovalDestinationSchema)
      .mutation(({ ctx, input }) =>
        control
          ? guarded(() => control.approvals.founderDestination(founderIdOf(ctx), input.approvalId))
          : notBuilt('founderAdmin.approvals.destination'),
      ),
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
      list: mountRecord(PAY_FOUNDER_ADMIN_CONTROL_TIERS_LIST, () => guarded(() => control.listTiers()), { refusalOf: payRefusal, founder }),
    }),
    pricing: router({
      rules: mountRecord(PAY_FOUNDER_ADMIN_CONTROL_PRICING_RULES, ({ input }) => guarded(() => control.listRules(input)), {
        refusalOf: payRefusal,
        founder,
      }),
    }),
    merchant: router({
      get: mountRecord(PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_GET, ({ input }) => guarded(() => control.profile(input.merchantId)), {
        refusalOf: payRefusal,
        founder,
      }),
      usage: mountRecord(PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_USAGE, ({ input }) => guarded(() => control.usage(input.merchantId)), {
        refusalOf: payRefusal,
        founder,
      }),
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
    /** Open limit-increase asks. Reading them does not change caps. Closing one does not either. */
    limitRequests: router({
      list: mountRecord(
        PAY_FOUNDER_ADMIN_CONTROL_LIMIT_REQUESTS_LIST,
        ({ input }) => guarded(() => control.listPendingLimitRequests(input)),
        { refusalOf: payRefusal, founder },
      ),
      close: founder
        .input(founderLimitRequestCloseInputSchema)
        .output(founderLimitRequestCloseResultSchema)
        .mutation(({ ctx, input }) => guarded(() => control.closeLimitRequest(founderIdOf(ctx), input))),
    }),
    audit: router({
      list: founder
        .input(founderControlAuditListInputSchema)
        .output(founderControlAuditListSchema)
        .query(({ input }) => guarded(() => control.listAudit(input))),
    }),
  });
}
