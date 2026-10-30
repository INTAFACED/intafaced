import type { Sql } from 'postgres';
import { z } from 'zod';
import { merchantCustomerSeriesInputSchema, merchantCustomerSeriesSchema, router, TRPCError } from '@intafaced/contracts';
import { merchantActivationSchema } from '@intafaced/contracts/merchant-activation';
import { defaultDisputeCaseStore, type DisputeCaseStore } from '../fraud/dispute-case.js';
import type { FounderAuthority } from '../founder-authority.js';
import { founderProcedure } from '../namespaces/founder-procedure.js';
import { ACTIVITY_OBJECT_TYPES, ActivityFeed } from './activity.js';
import { CustomerDirectory } from './customers.js';
import { DisputeOpsService, EVIDENCE_KINDS } from './disputes.js';
import { EVIDENCE_UPLOAD_OFF, type DisputeEvidenceGate } from './dispute-evidence-policy.js';
import { MerchantOpsError, wrapOps } from './errors.js';
import { INVOICE_STATUSES, InvoiceService, type InvoiceLinkPort } from './invoices.js';
import { EXPORT_KINDS, ExportService, type ExportDeps } from './exports.js';
import { MerchantActivationView } from './activation.js';
import { MerchantKybView } from './kyb.js';
import { NOTIFICATION_KINDS, NotificationService } from './notifications.js';
import {
  ReceiptBrandingService,
  ReceiptPrecisionInvalid,
  ReceiptPrecisionUnset,
  STATUS_EMAIL_KINDS,
  StatusEmailNotConnected,
  type ReceiptAssetPlaces,
} from './receipt-branding.js';
import { OperatorNotes } from './notes.js';
import { cursorInput, limitInput } from './pagination.js';
import { PayoutList } from './payouts.js';
import { reportOptions, zonedFilters } from './merchant-disp-bill-rep-report-options.js';
import { merchantRiskPolicy } from './merchant-disp-bill-rep-risk-policy.js';
import { DISPUTE_REASON_CATEGORIES, DisputeEvidenceDraft, disputeGuidance } from './merchant-disp-bill-rep-evidence-draft.js';
import { readDisputeFunds, type DisputeFundsLedger } from './merchant-disp-bill-rep-dispute-funds.js';
import { isInteractivePrincipal, resolveMerchantCaller, TEAM_ROLES } from './roles.js';
import { MerchantSecurity } from './security.js';
import { permissionCatalogue, refuseBuiltInRoleEdit } from './merchant-plat-org-permission-catalogue.js';
import { TeamService } from './team.js';
import { type TeamEmailInviteLimit } from './team-email.js';
import { WebhookOps, type WebhookRetryLimit } from './webhooks.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import { invitationAccept, membershipExit, teamMemberWrite } from '../team-member-write.js';

/**
 * `merchantOps.*`   - the merchant's own operations pages (W15). Scoped to the
 *                     caller's merchant, which is resolved from the signed
 *                     principal and never accepted from the request body.
 * `founderAdmin.ops.*` - operator-only notes. Built from `founderProcedure`
 *                     (never `admin:read`); see namespaces/founder-procedure.ts.
 *
 * Every procedure refuses another merchant's ids with the same answer as an id
 * that does not exist (M1), lists only the caller's rows (M2), and checks the
 * caller's team role on top of the session scope.
 */
export interface MerchantOpsDeps {
  /** The pay database. Absent = every merchantOps procedure refuses `pay.merchant_ops_unavailable`. */
  readonly sql?: Sql;
  readonly founderAuthority: FounderAuthority;
  /** Defaults to the process-wide dispute case store the fraud code already uses. */
  readonly disputes?: DisputeCaseStore;
  /** Default off. Upload stays refused until both switches are on and a scanner is set. */
  readonly evidence?: DisputeEvidenceGate;
  /** Hosted payment links. Absent: invoice send refuses, it does not mint a second checkout. */
  readonly invoiceLinks?: InvoiceLinkPort;
  readonly exports?: ExportDeps;
  /** Ledger balances for a statement export. Absent: that kind refuses. */
  readonly ledger?: ExportDeps['ledger'];
  /** http://localhost webhook URLs. Production leaves this off. */
  readonly webhooksAllowLocalHttp?: boolean;
  /** Retry window. Unset: retry refuses. No production default. */
  readonly webhookRetry?: WebhookRetryLimit;
  /** Chargeback transactions by key, for the read-only dispute funds card. Absent: that read refuses. */
  readonly disputeFundsLedger?: DisputeFundsLedger;
  /** Email-invite window. Unset: email invite refuses. Account-id invite is unchanged. */
  readonly teamEmailInvite?: TeamEmailInviteLimit;
  /**
   * How a freshly queued export gets generated. Default: run it in this process
   * on the next tick. Tests pass a no-op and drive `processQueued` themselves.
   */
  readonly exportKick?: (jobId: string, run: () => Promise<boolean>) => void;
  /**
   * Decimal places from the asset registry (M-adv-payments-core-07). Absent, or a
   * null answer, refuses `ledger.asset_precision_unset`. No place count is invented.
   */
  readonly receiptPlaces?: ReceiptAssetPlaces;
}

const id = z.string().guid();
const iso = z.string().datetime({ offset: true });
const assetIdIn = z.string().trim().min(1).max(32);
const note = z.string().trim().min(1).max(2000);

function makeParts(deps: MerchantOpsDeps) {
  const sql = deps.sql;
  const parts = sql
    ? {
        sql,
        team: new TeamService(sql, deps.teamEmailInvite),
        security: new MerchantSecurity(sql),
        disputeStore: deps.disputes ?? defaultDisputeCaseStore,
        disputes: new DisputeOpsService(sql, deps.disputes ?? defaultDisputeCaseStore, deps.evidence ?? EVIDENCE_UPLOAD_OFF),
        invoices: new InvoiceService(sql, deps.invoiceLinks),
        customers: new CustomerDirectory(sql),
        kyb: new MerchantKybView(sql),
        activation: new MerchantActivationView(sql),
        exports: new ExportService(sql, {
          ...deps.exports,
          disputes: deps.exports?.disputes ?? deps.disputes ?? defaultDisputeCaseStore,
          ledger: deps.exports?.ledger ?? deps.ledger,
        }),
        notifications: new NotificationService(sql),
        branding: new ReceiptBrandingService(sql, deps.receiptPlaces ?? null),
        activity: new ActivityFeed(sql),
        payouts: new PayoutList(sql),
        webhooks: new WebhookOps(sql, { allowLocalHttp: deps.webhooksAllowLocalHttp === true, retry: deps.webhookRetry }),
        notes: new OperatorNotes(sql),
      }
    : null;
  /** Without a database every procedure refuses closed; none answers empty. */
  const need = () => {
    if (!parts) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return parts;
  };
  return { need };
}

export function createMerchantOpsRouter(deps: MerchantOpsDeps) {
  const read = ownMerchantRead();
  const onboardOrRead = ownMerchantRead();
  const { need } = makeParts(deps);
  /** pay:write, or pay:onboard for an active member of a verified business: see team-member-write.ts. */
  const memberWrite = teamMemberWrite(() => need().sql);
  const accept = invitationAccept();
  const exit = membershipExit();
  const kick =
    deps.exportKick ??
    ((_jobId: string, run: () => Promise<boolean>) => {
      setImmediate(() => void run().catch(() => undefined));
    });

  /** Resolve once per call: the merchant and role of whoever is calling. */
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need().sql, ctx.principal);
  return router({
    merchantOps: router({
      disputes: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              status: z.enum(['open', 'contested', 'accepted', 'won', 'lost']).optional(),
              paymentId: id.optional(),
              search: z.string().trim().min(1).max(200).optional(),
              from: iso.optional(),
              to: iso.optional(),
              dueAfter: iso.optional(),
              dueBefore: iso.optional(),
              deadline: z.enum(['set', 'unset']).optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().disputes.list(await callerOf(ctx), input))),
        summary: read.input(z.object({}).strict()).query(({ ctx }) => wrapOps(async () => need().disputes.summary(await callerOf(ctx)))),
        /** M-disp-02: what a contest would send now, what is missing, and the rail's due date. Writes nothing. */
        reviewDraft: read
          .input(z.object({ disputeId: z.string().trim().min(1).max(200) }))
          .query(({ ctx, input }) =>
            wrapOps(async () =>
              new DisputeEvidenceDraft(need().sql, need().disputeStore).reviewDraft(await callerOf(ctx), input.disputeId),
            ),
          ),
        /** M-disp-02: plain-words meaning and recommended evidence for a reason category. Static; no merchant data. */
        guidance: read.input(z.object({ reason: z.enum(DISPUTE_REASON_CATEGORIES) })).query(({ ctx, input }) =>
          wrapOps(async () => {
            await callerOf(ctx);
            return disputeGuidance(input.reason);
          }),
        ),
        /** M-disp-01: where the money is. Reads the chargeback posts by their dispute keys; posts nothing. */
        funds: read
          .input(z.object({ disputeId: z.string().trim().min(1).max(200) }))
          .query(({ ctx, input }) =>
            wrapOps(async () => readDisputeFunds(await callerOf(ctx), need().disputeStore, deps.disputeFundsLedger, input.disputeId)),
          ),
        get: read
          .input(z.object({ disputeId: z.string().trim().min(1).max(200) }))
          .query(({ ctx, input }) => wrapOps(async () => need().disputes.get(await callerOf(ctx), input.disputeId))),
        addEvidence: memberWrite
          .input(
            z.object({
              disputeId: z.string().trim().min(1).max(200),
              kind: z.enum(EVIDENCE_KINDS),
              fileName: z.string().trim().min(1).max(255),
              contentType: z.string().trim().min(1).max(127),
              sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
              sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
              note: note.optional(),
            }),
          )
          .mutation(({ ctx, input }) => wrapOps(async () => need().disputes.addEvidence(await callerOf(ctx), input))),
        uploadEvidence: memberWrite
          .input(
            z.object({
              disputeId: z.string().trim().min(1).max(200),
              kind: z.enum(EVIDENCE_KINDS),
              fileName: z.string().trim().min(1).max(255),
              contentType: z.string().trim().min(1).max(127),
              contentBase64: z.string().min(1).max(1_400_000),
              sha256: z
                .string()
                .regex(/^[0-9a-fA-F]{64}$/)
                .optional(),
              note: note.optional(),
            }),
          )
          .mutation(({ ctx, input }) => wrapOps(async () => need().disputes.uploadEvidence(await callerOf(ctx), input))),
        getEvidence: read
          .input(z.object({ evidenceId: id }))
          .query(({ ctx, input }) => wrapOps(async () => need().disputes.getEvidence(await callerOf(ctx), input.evidenceId))),
        respond: memberWrite
          .input(
            z.object({
              requestId: id,
              disputeId: z.string().trim().min(1).max(200),
              action: z.enum(['contest', 'accept_liability']),
              note: note.optional(),
            }),
          )
          .mutation(({ ctx, input }) => wrapOps(async () => need().disputes.respond(await callerOf(ctx), input))),
      }),

      invoices: router({
        create: memberWrite
          .input(
            z.object({
              requestId: id,
              assetId: assetIdIn,
              amount: z.string().trim().min(1).max(80),
              customerRef: z.string().trim().min(1).max(200).optional(),
              customerEmail: z.string().trim().min(3).max(254).optional(),
              description: z.string().trim().min(1).max(2000).optional(),
              dueAt: iso.optional(),
              lineItems: z
                .array(
                  z
                    .object({
                      description: z.string().trim().min(1).max(500),
                      quantity: z.string().trim().min(1).max(80),
                      unitAmount: z.string().trim().min(1).max(80),
                      kind: z.enum(['charge', 'credit']).default('charge'),
                    })
                    .strict(),
                )
                .max(40)
                .optional(),
            }),
          )
          .mutation(({ ctx, input }) => wrapOps(async () => need().invoices.create(await callerOf(ctx), input))),
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              status: z.enum(INVOICE_STATUSES).optional(),
              assetId: assetIdIn.optional(),
              search: z.string().trim().min(1).max(200).optional(),
              from: iso.optional(),
              to: iso.optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().invoices.list(await callerOf(ctx), input))),
        get: read
          .input(z.object({ invoiceId: id }))
          .query(({ ctx, input }) => wrapOps(async () => need().invoices.get(await callerOf(ctx), input.invoiceId))),
        send: memberWrite
          .input(z.object({ requestId: id, invoiceId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().invoices.send(await callerOf(ctx), input))),
        /** M-bill-07: copy a draft into a new draft (same lines, no link, payer email not copied). */
        duplicate: memberWrite
          .input(z.object({ requestId: id, invoiceId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().invoices.duplicate(await callerOf(ctx), input))),
        void: memberWrite
          .input(z.object({ requestId: id, invoiceId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().invoices.void(await callerOf(ctx), input))),
        reissueLink: memberWrite
          .input(z.object({ requestId: id, invoiceId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().invoices.reissueLink(await callerOf(ctx), input))),
        markPaidByPayment: memberWrite
          .input(z.object({ requestId: id, invoiceId: id, paymentId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().invoices.markPaidByPayment(await callerOf(ctx), input))),
      }),

      customers: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              search: z.string().trim().min(1).max(200).optional(),
              seenAfter: iso.optional(),
              seenBefore: iso.optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().customers.list(await callerOf(ctx), input))),
        summary: read
          .input(z.object({ activeSince: iso }))
          .query(({ ctx, input }) => wrapOps(async () => need().customers.summary(await callerOf(ctx), input))),
        get: read
          .input(z.object({ customerRef: z.string().trim().min(1).max(200), recentPaymentsLimit: limitInput }))
          .query(({ ctx, input }) => wrapOps(async () => need().customers.get(await callerOf(ctx), input))),
        series: read
          .input(merchantCustomerSeriesInputSchema)
          .output(merchantCustomerSeriesSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().customers.series(await callerOf(ctx), input))),
      }),

      /** Team-wide sign-in rule (M-plat-org-06). Members read it; only the owner changes it. svc-identity enforces it. */
      security: router({
        get: read.input(z.object({}).strict()).query(({ ctx }) => wrapOps(async () => need().security.get(await callerOf(ctx)))),
        setRequireMfa: memberWrite
          .input(z.object({ requireMfa: z.boolean(), expectedRevision: z.number().int().min(0) }).strict())
          .mutation(({ ctx, input }) => wrapOps(async () => need().security.setRequireMfa(await callerOf(ctx), input))),
      }),

      team: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              status: z.enum(['active', 'invited', 'removed']).optional(),
              role: z.enum(['owner', 'admin', 'finance', 'developer', 'viewer']).optional(),
              search: z.string().trim().min(1).max(200).optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().team.list(await callerOf(ctx), input))),
        history: read
          .input(z.object({ limit: limitInput, cursor: cursorInput }))
          .query(({ ctx, input }) => wrapOps(async () => need().team.history(await callerOf(ctx), input))),
        /** Which role the caller holds, so the portal can hide what they cannot do. */
        me: read.input(z.object({}).strict()).query(({ ctx }) =>
          wrapOps(async () => {
            const c = await callerOf(ctx);
            return { merchantId: c.merchantId, userId: c.userId, role: c.role };
          }),
        ),
        invite: memberWrite
          .input(
            z.object({
              userId: z.string().trim().min(1).max(128).optional(),
              email: z.string().trim().min(1).max(254).optional(),
              role: z.enum(TEAM_ROLES),
              label: z.string().trim().min(1).max(120).optional(),
            }),
          )
          .mutation(({ ctx, input }) => wrapOps(async () => need().team.invite(await callerOf(ctx), input))),
        changeRole: memberWrite
          .input(z.object({ memberId: id, role: z.enum(TEAM_ROLES) }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().team.changeRole(await callerOf(ctx), input))),
        remove: memberWrite
          .input(z.object({ memberId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().team.remove(await callerOf(ctx), input))),
        leave: exit.input(z.object({}).strict()).mutation(({ ctx }) => wrapOps(async () => need().team.leave(await callerOf(ctx)))),
        myInvitations: read
          .input(z.object({}).strict())
          .query(({ ctx }) => wrapOps(async () => need().team.myInvitations(ctx.principal.userId))),
        acceptInvite: accept.input(z.object({ memberId: id })).mutation(({ ctx, input }) =>
          wrapOps(async () => {
            if (!isInteractivePrincipal(ctx.principal)) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
            return need().team.acceptInvite(ctx.principal.userId, input.memberId);
          }),
        ),
        declineInvite: exit.input(z.object({ memberId: id })).mutation(({ ctx, input }) =>
          wrapOps(async () => {
            if (!isInteractivePrincipal(ctx.principal)) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
            return need().team.declineInvite(ctx.principal.userId, input.memberId);
          }),
        ),
      }),

      /** M-plat-org-03: the built-in roles and what each can do, read from the role table. Built-in roles have no write. */
      permissions: router({
        catalogue: read.input(z.object({}).strict()).query(({ ctx }) =>
          wrapOps(async () => {
            await callerOf(ctx);
            return permissionCatalogue();
          }),
        ),
        /** Mounted on the read scope on purpose: a read-only caller gets the named refusal too, not a scope error. It never writes. */
        updateRole: read.input(z.object({ role: z.string().trim().min(1).max(32) }).passthrough()).mutation(({ ctx }) =>
          wrapOps(async () => {
            await callerOf(ctx);
            return refuseBuiltInRoleEdit();
          }),
        ),
      }),

      /** M-disp-05: the default risk rules in plain words, from fraud-policy.ts. Read only; enforces nothing. */
      risk: router({
        policy: read.input(z.object({}).strict()).query(({ ctx }) =>
          wrapOps(async () => {
            await callerOf(ctx);
            return merchantRiskPolicy();
          }),
        ),
      }),

      kyb: router({
        current: onboardOrRead
          .input(z.object({}).strict())
          .query(({ ctx }) => wrapOps(async () => need().kyb.current(await callerOf(ctx)))),
        history: onboardOrRead
          .input(z.object({ limit: limitInput, cursor: cursorInput }))
          .query(({ ctx, input }) => wrapOps(async () => need().kyb.history(await callerOf(ctx), input))),
      }),

      /**
       * J-merchant-02 step 6: whether the business is activated, from svc-pay's own status record (activation.ts).
       * Unconfirmed until a recorded change to active says otherwise; never derived from the verification.
       */
      activation: router({
        get: onboardOrRead
          .input(z.object({}).strict())
          .output(merchantActivationSchema)
          .query(({ ctx }) => wrapOps(async () => need().activation.get(await callerOf(ctx)))),
      }),

      exports: router({
        create: memberWrite
          .input(
            z.object({
              requestId: id,
              kind: z.enum(EXPORT_KINDS),
              filters: z
                .object({
                  from: iso.optional(),
                  to: iso.optional(),
                  status: z.string().max(32).optional(),
                  assetId: assetIdIn.optional(),
                  amountMin: z.string().optional(),
                  amountMax: z.string().optional(),
                })
                .strict()
                .default({}),
              columns: z
                .array(z.string().regex(/^[a-z_]{1,64}$/))
                .max(32)
                .optional(),
              /** M-rep-01: local days in a time zone; the server computes the UTC boundaries. Not combined with filters.from/to. */
              period: z
                .object({
                  fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  timeZone: z.string().trim().min(1).max(64),
                })
                .strict()
                .optional(),
            }),
          )
          .mutation(({ ctx, input }) =>
            wrapOps(async () => {
              const p = need();
              const caller = await callerOf(ctx);
              const { period, ...rest } = input;
              const filters = period ? zonedFilters(rest.filters, period, new Date()) : rest.filters;
              const result = await p.exports.create(caller, { ...rest, filters });
              if (result.created) kick(result.job.jobId, () => p.exports.process(result.job.jobId));
              return result.job;
            }),
          ),
        /** M-rep-01: per kind, the date basis and the columns this caller's role may pick; formats offered. */
        options: read.input(z.object({}).strict()).query(({ ctx }) => wrapOps(async () => reportOptions(await callerOf(ctx)))),
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              kind: z.enum(EXPORT_KINDS).optional(),
              status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']).optional(),
              search: z.string().trim().min(1).max(200).optional(),
              from: iso.optional(),
              to: iso.optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().exports.list(await callerOf(ctx), input))),
        expire: memberWrite
          .input(z.object({ jobId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().exports.expire(await callerOf(ctx), input.jobId))),
        get: read
          .input(z.object({ jobId: id }))
          .query(({ ctx, input }) => wrapOps(async () => need().exports.get(await callerOf(ctx), input.jobId))),
        download: read
          .input(z.object({ jobId: id }))
          .query(({ ctx, input }) => wrapOps(async () => need().exports.download(await callerOf(ctx), input.jobId))),
      }),

      activity: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              objectType: z.enum(ACTIVITY_OBJECT_TYPES).optional(),
              action: z.string().trim().min(1).max(64).optional(),
              actorId: z.string().trim().min(1).max(128).optional(),
              from: iso.optional(),
              to: iso.optional(),
              search: z.string().trim().min(1).max(200).optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().activity.list(await callerOf(ctx), input))),
      }),

      payouts: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              status: z.enum(['pending', 'posted', 'paid_out', 'failed']).optional(),
              assetId: assetIdIn.optional(),
              from: iso.optional(),
              to: iso.optional(),
              search: z.string().trim().min(1).max(200).optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().payouts.list(await callerOf(ctx), input))),
      }),

      webhooks: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              status: z.enum(['active', 'disabled']).optional(),
              search: z.string().trim().min(1).max(500).optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().webhooks.list(await callerOf(ctx), input))),
        create: memberWrite
          .input(z.object({ url: z.string().trim().min(1).max(2048) }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().webhooks.create(await callerOf(ctx), input))),
        update: memberWrite
          .input(z.object({ endpointId: id, url: z.string().trim().min(1).max(2048) }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().webhooks.update(await callerOf(ctx), input))),
        disable: memberWrite
          .input(z.object({ endpointId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().webhooks.disable(await callerOf(ctx), input.endpointId))),
        rotateSecret: memberWrite
          .input(z.object({ endpointId: id, requestId: id }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().webhooks.rotateSecret(await callerOf(ctx), input))),
        deliveries: router({
          list: read
            .input(
              z.object({
                limit: limitInput,
                cursor: cursorInput,
                endpointId: id.optional(),
                status: z.enum(['pending', 'delivered', 'failed', 'dead']).optional(),
                from: iso.optional(),
                to: iso.optional(),
              }),
            )
            .query(({ ctx, input }) => wrapOps(async () => need().webhooks.listDeliveries(await callerOf(ctx), input))),
          retry: memberWrite
            .input(z.object({ requestId: id, deliveryId: id }))
            .mutation(({ ctx, input }) => wrapOps(async () => need().webhooks.retry(await callerOf(ctx), input))),
        }),
        health: read.input(z.object({}).strict()).query(({ ctx }) => wrapOps(async () => need().webhooks.health(await callerOf(ctx)))),
      }),

      notifications: router({
        list: read
          .input(
            z.object({
              limit: limitInput,
              cursor: cursorInput,
              unreadOnly: z.boolean().optional(),
              kind: z.enum(NOTIFICATION_KINDS).optional(),
            }),
          )
          .query(({ ctx, input }) => wrapOps(async () => need().notifications.list(await callerOf(ctx), input))),
        unreadCount: read
          .input(z.object({}).strict())
          .query(({ ctx }) => wrapOps(async () => need().notifications.unreadCount(await callerOf(ctx)))),
        markRead: memberWrite
          .input(z.object({ notificationIds: z.array(id).min(1).max(200) }))
          .mutation(({ ctx, input }) => wrapOps(async () => need().notifications.markRead(await callerOf(ctx), input.notificationIds))),
        markAllRead: memberWrite
          .input(z.object({}).strict())
          .mutation(({ ctx }) => wrapOps(async () => need().notifications.markAllRead(await callerOf(ctx)))),
        preferences: router({
          list: read
            .input(z.object({}).strict())
            .query(({ ctx }) => wrapOps(async () => need().notifications.preferences(await callerOf(ctx)))),
          history: read
            .input(z.object({ limit: limitInput, cursor: cursorInput }))
            .query(({ ctx, input }) => wrapOps(async () => need().notifications.preferenceHistory(await callerOf(ctx), input))),
          set: memberWrite
            .input(
              z.object({
                kind: z.enum(NOTIFICATION_KINDS),
                inApp: z.boolean(),
                threshold: z
                  .string()
                  .regex(/^[0-9]+(\.[0-9]{1,18})?$/)
                  .nullish(),
              }),
            )
            .mutation(({ ctx, input }) => wrapOps(async () => need().notifications.setPreference(await callerOf(ctx), input))),
        }),
      }),

      receiptBranding: router({
        get: read
          .input(z.object({}).strict())
          .query(({ ctx }) => wrapBranding(async () => need().branding.getForMerchant(await callerOf(ctx)))),
        save: memberWrite
          .input(templateInput)
          .mutation(({ ctx, input }) => wrapBranding(async () => need().branding.saveForMerchant(await callerOf(ctx), input))),
        preview: read
          .input(z.object({ amount: z.string(), assetId: z.string() }).strict())
          .query(({ ctx, input }) => wrapBranding(async () => need().branding.preview(await callerOf(ctx), input))),
      }),
      statusEmails: router({
        get: read.input(z.object({}).strict()).query(({ ctx }) => wrapBranding(async () => need().branding.statusGet(await callerOf(ctx)))),
        set: memberWrite
          .input(
            z
              .object({
                succeeded: z.boolean().optional(),
                failed: z.boolean().optional(),
                refunded: z.boolean().optional(),
              })
              .strict(),
          )
          .mutation(({ ctx, input }) => wrapBranding(async () => need().branding.statusSet(await callerOf(ctx), input))),
        sendTest: memberWrite
          .input(z.object({ kind: z.enum(STATUS_EMAIL_KINDS) }).strict())
          .mutation(({ ctx, input }) => wrapBranding(async () => need().branding.sendTest(await callerOf(ctx), input.kind))),
      }),
    }),
  });
}
export type MerchantOpsRouter = ReturnType<typeof createMerchantOpsRouter>;

/**
 * The subtree mounted at `founderAdmin.ops` (see namespaces/founder-admin.ts).
 * tRPC cannot merge two routers that both define `founderAdmin`, so the notes
 * are handed to the founder-admin router to mount, not merged beside it.
 */
export function createFounderOpsRouter(deps: MerchantOpsDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const { need } = makeParts(deps);
  const founderIdOf = (ctx: unknown): string => {
    const value = (ctx as { founderUserId?: unknown }).founderUserId;
    if (typeof value !== 'string' || value.length === 0) throw new MerchantOpsError('pay.founder_authority_missing', 'forbidden');
    return value;
  };

  return router({
    notes: router({
      add: founder
        .input(
          z.object({
            merchantId: id,
            body: z.string().trim().min(1).max(4000),
            tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
            flagged: z.boolean().default(false),
          }),
        )
        .mutation(({ ctx, input }) => wrapOps(async () => need().notes.add(founderIdOf(ctx), input))),
      list: founder
        .input(
          z.object({
            merchantId: id,
            limit: limitInput,
            cursor: cursorInput,
            flaggedOnly: z.boolean().optional(),
            includeRetracted: z.boolean().optional(),
          }),
        )
        .query(({ input }) => wrapOps(async () => need().notes.list(input))),
      retract: founder
        .input(z.object({ noteId: id, reason: z.string().trim().min(3).max(500) }))
        .mutation(({ ctx, input }) => wrapOps(async () => need().notes.retract(founderIdOf(ctx), input))),
    }),
    receiptTemplate: router({
      get: founder.input(z.object({}).strict()).query(() => wrapBranding(async () => need().branding.getOpsDefault())),
      save: founder
        .input(templateInput)
        .mutation(({ ctx, input }) => wrapBranding(async () => need().branding.saveOpsDefault(founderIdOf(ctx), input))),
    }),
  });
}

const templateInput = z
  .object({
    requestId: id,
    logoRef: z.string().nullable(),
    accent: z.string().nullable(),
    footer: z.string(),
    language: z.string(),
  })
  .strict();

async function wrapBranding<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await wrapOps(fn);
  } catch (error) {
    if (error instanceof StatusEmailNotConnected) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'vendor.email', cause: error });
    }
    if (error instanceof ReceiptPrecisionUnset || error instanceof ReceiptPrecisionInvalid) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.code, cause: error });
    }
    throw error;
  }
}
export type FounderOpsRouter = ReturnType<typeof createFounderOpsRouter>;
