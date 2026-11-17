/**
 * The card programme desk for support and finance (J-bank-26). Reads are `admin:read`; every change is `support:ops`,
 * records the signed-in operator as its actor and writes one audit row. A staff member with the viewer role is refused
 * every change (`bank.card_programme_viewer`). Nothing here posts to the ledger.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { SETTING_KEYS } from '../cards/programme/programme-ops.js';
import { ruleParamsSchema } from '../cards/programme/rules.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const amount = z.string().regex(/^\d+(\.\d{1,18})?$/);
const signed = z.string().regex(/^-?\d+(\.\d{1,18})?$/);
const settingKey = z.enum(SETTING_KEYS);
const setting = z.object({ value: z.unknown(), version: z.number().int(), updatedBy: z.string(), updatedAt: z.string() }).nullable();
const settings = z.object(
  Object.fromEntries(SETTING_KEYS.map((k) => [k, setting])) as Record<(typeof SETTING_KEYS)[number], typeof setting>,
);
const rule = z.object({
  id: z.string().guid(),
  ruleKey: z.string(),
  version: z.number().int(),
  name: z.string(),
  params: ruleParamsSchema,
  words: z.string(),
  state: z.enum(['shadow', 'active', 'retired']),
  shadow: z.object({ evaluated: z.number().int(), wouldDecline: z.number().int(), at: z.string() }),
  createdBy: z.string(),
  createdAt: z.string(),
  promotedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
});
const staff = z.object({
  userId: z.string(),
  email: z.string(),
  role: z.enum(['manager', 'viewer']),
  assignedBy: z.string(),
  assignedAt: z.string(),
});
const cardRef = z.object({ id: z.string().guid(), panTail: z.string(), status: z.string(), assetId: z.string(), test: z.boolean() });
const cardholder = z.object({
  id: z.string().guid(),
  kind: z.enum(['individual', 'business']),
  name: z.string(),
  email: z.string().nullable(),
  country: z.string(),
  userId: z.string().nullable(),
  beneficialOwners: z.array(z.object({ name: z.string(), email: z.string() })),
  status: z.enum(['verified', 'review']),
  gap: z.string().nullable(),
  gapCode: z.string().nullable(),
  screening: z.enum(['clear', 'listed']),
  screenedAt: z.string(),
  test: z.boolean(),
  createdAt: z.string(),
});
const report = z.object({
  day: z.string(),
  asOf: z.string(),
  test: z.boolean(),
  assets: z.array(z.object({ assetId: z.string(), approved: z.number().int(), approvedVolume: amount, declined: z.number().int() })),
  totals: z.object({ approved: z.number().int(), declined: z.number().int() }),
});
const traceStep = z.object({ check: z.string(), result: z.enum(['pass', 'decline', 'skip']), detail: z.string() });
const channel = z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']);

export function cardProgrammeOpsProcedures(bank: BankServices, guard: Guard) {
  const p = () => bank.cardProgrammeOps;
  const actor = (ctx: { principal: { userId: string } }) => ctx.principal.userId;
  return {
    /** The desk's first paint: settings, checklist, rules, staff, audit, cardholders and their queue, the log, the report. */
    cardProgrammeDesk: scopedProcedure('admin:read')
      .output(
        z.object({
          test: z.boolean(),
          programme: z.object({ id: z.string(), displayName: z.string(), simulated: z.boolean() }),
          settings,
          checklist: z.array(z.object({ id: z.string(), label: z.string(), done: z.boolean(), blocker: z.string().nullable() })),
          rules: z.array(rule),
          staff: z.array(staff),
          audit: z.array(
            z.object({
              id: z.string(),
              actor: z.string(),
              action: z.string(),
              target: z.string(),
              before: z.string().nullable(),
              after: z.string().nullable(),
              at: z.string(),
            }),
          ),
          reviewQueue: z.array(cardholder),
          cardholders: z.array(cardholder.extend({ cards: z.array(cardRef) })),
          decisionLog: z.array(
            z.object({
              id: z.string().guid(),
              cardId: z.string().guid(),
              panTail: z.string(),
              assetId: z.string(),
              amount,
              channel: z.string(),
              merchantCategory: z.string().nullable(),
              decision: z.enum(['approved', 'declined']),
              declineCode: z.string().nullable(),
              status: z.string(),
              decidedAt: z.string(),
              test: z.boolean(),
            }),
          ),
          report,
          exemptions: z.number().int(),
          simulator: z.boolean(),
          screeningListSet: z.boolean(),
        }),
      )
      .query(() => guard(() => p().desk())),

    cardProgrammeCardholders: scopedProcedure('admin:read')
      .input(z.object({ query: z.string().max(120).optional() }).strict())
      .output(z.array(cardholder.extend({ cards: z.array(cardRef) })))
      .query(({ input }) => guard(() => p().cardholders(input.query))),

    cardProgrammeCardholder: scopedProcedure('admin:read')
      .input(z.object({ cardholderId: z.string().max(64) }).strict())
      .output(
        cardholder.extend({
          cards: z.array(cardRef),
          funds: z.array(
            z.object({
              assetId: z.string(),
              appHeld: amount,
              appCaptured: amount,
              appFigure: amount,
              partnerHeld: amount.nullable(),
              partnerCaptured: amount.nullable(),
              partnerFigure: amount.nullable(),
              difference: signed.nullable(),
              status: z.enum(['matches', 'break', 'not_known']),
              test: z.boolean(),
            }),
          ),
        }),
      )
      .query(({ input }) => guard(() => p().cardholder(input.cardholderId))),

    cardProgrammeAuthorization: scopedProcedure('admin:read')
      .input(z.object({ id: z.string().max(64) }).strict())
      .output(
        z.object({
          id: z.string().guid(),
          cardId: z.string().guid(),
          authorizationRef: z.string(),
          panTail: z.string(),
          assetId: z.string(),
          amount,
          channel: z.string(),
          merchantCategory: z.string().nullable(),
          decision: z.enum(['approved', 'declined']),
          declineCode: z.string().nullable(),
          heldBy: z.string(),
          partnerHoldRef: z.string().nullable(),
          test: z.boolean(),
          lifecycle: z.array(z.object({ event: z.string(), amount, at: z.string(), detail: z.string().nullable() })),
          variance: z
            .object({ authorised: amount, captured: amount, returned: amount, stillHeld: amount, captureVariance: signed })
            .nullable(),
          trace: z.array(traceStep).nullable(),
        }),
      )
      .query(({ input }) => guard(() => p().authorization(input.id))),

    cardProgrammeExport: scopedProcedure('admin:read')
      .output(z.object({ fileName: z.string(), asOf: z.string(), text: z.string(), sha256: z.string(), signature: z.string() }))
      .mutation(({ ctx }) => guard(() => p().exportReport(actor(ctx)))),

    cardProgrammeConfigure: scopedProcedure('support:ops')
      .input(z.object({ key: settingKey, value: z.unknown() }).strict())
      .output(settings)
      .mutation(({ ctx, input }) => guard(() => p().configure(actor(ctx), input.key, input.value))),

    cardProgrammeClearThreeDs: scopedProcedure('support:ops')
      .output(settings)
      .mutation(({ ctx }) => guard(() => p().clearThreeDs(actor(ctx)))),

    cardProgrammeRuleCreate: scopedProcedure('support:ops')
      .input(z.object({ ruleKey: z.string().max(64), name: z.string().max(80), params: ruleParamsSchema }).strict())
      .output(rule)
      .mutation(({ ctx, input }) => guard(() => p().createRule(actor(ctx), input))),

    cardProgrammeRulePromote: scopedProcedure('support:ops')
      .input(z.object({ ruleId: z.string().guid() }).strict())
      .output(z.array(rule))
      .mutation(({ ctx, input }) => guard(() => p().promoteRule(actor(ctx), input.ruleId))),

    cardProgrammeRuleRollback: scopedProcedure('support:ops')
      .input(z.object({ ruleKey: z.string().max(64) }).strict())
      .output(z.array(rule))
      .mutation(({ ctx, input }) => guard(() => p().rollbackRule(actor(ctx), input.ruleKey))),

    cardProgrammeStaffAssign: scopedProcedure('support:ops')
      .input(z.object({ email: z.string().max(254), role: z.enum(['manager', 'viewer']) }).strict())
      .output(z.array(staff))
      .mutation(({ ctx, input }) => guard(() => p().assignStaff(actor(ctx), input))),

    cardProgrammeCardholderCreate: scopedProcedure('support:ops')
      .input(
        z
          .object({
            requestKey: z.string().max(128),
            kind: z.enum(['individual', 'business']),
            name: z.string().max(120),
            email: z.string().max(254).optional(),
            country: z.string().max(2),
            beneficialOwners: z
              .array(z.object({ name: z.string().max(120), email: z.string().max(254) }).strict())
              .max(10)
              .optional(),
          })
          .strict(),
      )
      .output(cardholder)
      .mutation(({ ctx, input }) => guard(() => p().createCardholder(actor(ctx), input))),

    cardProgrammeBulkValidate: scopedProcedure('support:ops')
      .input(z.object({ file: z.string().max(100_000) }).strict())
      .output(
        z.object({
          batchId: z.string(),
          ok: z.boolean(),
          rows: z.array(
            z.object({
              row: z.number().int(),
              cardholderId: z.string(),
              assetId: z.string(),
              perAuthorizationLimit: z.string(),
              error: z.string().nullable(),
            }),
          ),
        }),
      )
      .mutation(({ input }) => guard(() => p().validateBulk(input.file))),

    cardProgrammeBulkIssue: scopedProcedure('support:ops')
      .input(z.object({ file: z.string().max(100_000) }).strict())
      .output(
        z.object({
          batchId: z.string(),
          cards: z.array(
            z.object({ row: z.number().int(), cardId: z.string().guid(), panTail: z.string(), cardholderId: z.string().guid() }),
          ),
          cardsInBatch: z.number().int(),
          test: z.boolean(),
        }),
      )
      .mutation(({ ctx, input }) => guard(() => p().issueBulk(actor(ctx), input.file))),

    cardProgrammeReassign: scopedProcedure('support:ops')
      .input(z.object({ cardId: z.string().guid(), toCardholderId: z.string().guid() }).strict())
      .output(z.object({ cardId: z.string().guid(), panTail: z.string(), cardholderId: z.string().guid() }))
      .mutation(({ ctx, input }) => guard(() => p().reassign(actor(ctx), input))),

    /** The card event simulator (TEST): dev and test stacks only, simulated cards only. */
    cardProgrammeSimulate: scopedProcedure('support:ops')
      .input(
        z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('authorize'),
              cardId: z.string().guid(),
              authorizationRef: z.string().min(4).max(128),
              amount,
              channel: channel.optional(),
              merchantCategory: z.string().max(64).optional(),
              threeDs: z.enum(['authenticated', 'failed']).optional(),
            })
            .strict(),
          z
            .object({ kind: z.literal('capture'), cardId: z.string().guid(), authorizationRef: z.string().min(4).max(128), amount })
            .strict(),
          z.object({ kind: z.literal('reverse'), cardId: z.string().guid(), authorizationRef: z.string().min(4).max(128) }).strict(),
        ]),
      )
      .output(
        z.object({
          test: z.literal(true),
          kind: z.enum(['authorize', 'capture', 'reverse']),
          authorizationId: z.string().optional(),
          decision: z.enum(['approved', 'declined']).optional(),
          declineCode: z.string().nullable().optional(),
          captured: amount.optional(),
          returned: amount.optional(),
        }),
      )
      .mutation(({ ctx, input }) => guard(() => p().simulate(actor(ctx), input))),
  };
}
