import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { NO_PARTNER_BANK_CODE } from '../partner/partner-bank.js';
import {
  closureBalancesOut,
  type DataRequest,
  type InfoRequest,
  type PartnerClosure,
  type PartnerCompliance,
  type PeriodicReview,
} from '../partner/partner-compliance.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const iso = z.string().datetime();
const businessId = z.string().regex(/^[A-Za-z0-9:_-]{8,64}$/);

const infoRequestOut = z
  .object({
    id: z.string(),
    title: z.string(),
    detail: z.string(),
    openedAt: iso,
    dueAt: iso,
    status: z.enum(['open', 'under_review']),
    answeredAt: iso.nullable(),
    file: z.object({ name: z.string(), type: z.string(), size: z.number().int(), sha256: z.string() }).strict().nullable(),
    label: z.string(),
  })
  .strict();

const reviewOut = z
  .object({
    id: z.string(),
    title: z.string(),
    dueAt: iso,
    missedEffect: z.string(),
    status: z.enum(['open', 'answered']),
    answeredAt: iso.nullable(),
    label: z.string(),
  })
  .strict();

const closureOut = z
  .object({
    id: z.string(),
    state: z.enum(['pending', 'closed', 'reopened']),
    requestedAt: iso,
    balances: z.array(z.object({ assetId: z.string(), spaceId: z.string().nullable(), amount: z.string() }).strict()),
    destination: z.object({ name: z.string(), accountRef: z.string() }).strict().nullable(),
    payoutMoveIds: z.array(z.string()),
    paidOutAt: iso.nullable(),
    closedAt: iso.nullable(),
    reopenedAt: iso.nullable(),
    label: z.string(),
  })
  .strict();

const dataRequestOut = z
  .object({
    id: z.string(),
    kind: z.enum(['access', 'portability']),
    requestedAt: iso,
    status: z.literal('received'),
    partnerRef: z.string(),
    label: z.string(),
  })
  .strict();

/** An owner value as the app reads it: published, or blank with the code that refuses where it is needed. */
const unset = (code: string) => z.object({ state: z.literal('unset'), code: z.literal(code) }).strict();

const isoOrNull = (at: Date | null) => (at ? at.toISOString() : null);
const requestWire = (row: InfoRequest) => ({
  ...row,
  openedAt: row.openedAt.toISOString(),
  dueAt: row.dueAt.toISOString(),
  answeredAt: isoOrNull(row.answeredAt),
  file: row.file ? { ...row.file } : null,
});
const reviewWire = (row: PeriodicReview) => ({ ...row, dueAt: row.dueAt.toISOString(), answeredAt: isoOrNull(row.answeredAt) });
const closureWire = (row: PartnerClosure) => ({
  ...row,
  requestedAt: row.requestedAt.toISOString(),
  balances: closureBalancesOut(row.balances),
  destination: row.destination ? { ...row.destination } : null,
  payoutMoveIds: [...row.payoutMoveIds],
  paidOutAt: isoOrNull(row.paidOutAt),
  closedAt: isoOrNull(row.closedAt),
  reopenedAt: isoOrNull(row.reopenedAt),
});
const dataWire = (row: DataRequest) => ({ ...row, requestedAt: row.requestedAt.toISOString() });

/**
 * `bank.bankAccount` (BK-acct-05, BK-acct-06; J-bank-17): the person's bank account at the partner bank: onboarding,
 * the partner's information requests and periodic reviews, closing and reopening the account, and a data-rights
 * request. Every answer is the partner's, read through the person's own session; our ledger posts nothing for any of it.
 * A person whose bank money the partner does not hold (the custodial layer, or no partner) is refused
 * `bank.no_partner_bank`: there is no partner account to onboard, review or close.
 */
export function createBankAccountRouter(bank: Pick<BankServices, 'testPartner' | 'partnerCustody' | 'bankAccountTerms'>, guard: Guard) {
  const partnerFor = (userId: string): PartnerCompliance => {
    const compliance = bank.testPartner?.compliance;
    if (!compliance || !bank.partnerCustody.bankFor(userId)) {
      throw new BankError(
        'The partner bank does not hold a bank account for you, so there is nothing to onboard, review or close.',
        NO_PARTNER_BANK_CODE,
      );
    }
    return compliance;
  };
  const terms = bank.bankAccountTerms;

  return router({
    /** The partner's steps and requirements, with the owner's, and our identity case where the partner accepts it (#1). */
    onboarding: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z
          .object({
            label: z.string(),
            steps: z.array(
              z
                .object({
                  id: z.enum(['identity', 'information']),
                  title: z.string(),
                  status: z.enum(['done', 'open']),
                  doneWith: z.literal('identity_case').nullable(),
                })
                .strict(),
            ),
            requirements: z.array(z.string()),
            ownerRequirements: z.union([
              z.object({ state: z.literal('published'), requirements: z.array(z.string()) }).strict(),
              unset('bank.onboarding_requirements_unset'),
            ]),
            identityCase: z.object({ tier: z.enum(['none', 'basic', 'full', 'institutional']), accepted: z.boolean() }).strict(),
            complete: z.boolean(),
            openRequests: z.number().int(),
            openReviews: z.number().int(),
          })
          .strict(),
      )
      .query(({ ctx }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          const partner = partnerFor(userId);
          const now = await partner.onboarding(userId, ctx.principal.tier);
          const requests = await partner.requests(userId);
          const reviews = await partner.reviews(userId);
          return {
            label: now.label,
            steps: now.steps.map((step) => ({ ...step })),
            requirements: [...now.requirements],
            ownerRequirements: terms.ownerRequirements
              ? { state: 'published' as const, requirements: [...terms.ownerRequirements] }
              : { state: 'unset' as const, code: 'bank.onboarding_requirements_unset' as const },
            identityCase: { ...now.identityCase },
            complete: now.complete,
            openRequests: requests.filter((row) => row.status === 'open').length,
            openReviews: reviews.filter((row) => row.status === 'open').length,
          };
        }),
      ),

    /** The partner's information requests, newest first, with the owner's size cap and types for an answer (#2). */
    requests: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z
          .object({
            requests: z.array(infoRequestOut),
            upload: z.union([
              z.object({ state: z.literal('published'), allowedTypes: z.array(z.string()), maxBytes: z.number().int() }).strict(),
              unset('bank.info_request_upload_unset'),
            ]),
          })
          .strict(),
      )
      .query(({ ctx }) =>
        guard(async () => {
          const rows = await partnerFor(ctx.principal.userId).requests(ctx.principal.userId);
          return {
            requests: rows.map(requestWire),
            upload: terms.upload
              ? { state: 'published' as const, allowedTypes: [...terms.upload.allowedTypes], maxBytes: terms.upload.maxBytes }
              : { state: 'unset' as const, code: 'bank.info_request_upload_unset' as const },
          };
        }),
      ),

    /** Answers one open request with one file, which goes to the partner; the request moves to under review once (#2). */
    answerRequest: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            requestId: z.string().min(1).max(128),
            name: z.string().trim().min(1).max(200),
            type: z.string().trim().min(1).max(100),
            // The size cap is the owner's; this bound only stops a body far past any cap from being decoded.
            contentBase64: z.string().min(4).max(28_000_000),
          })
          .strict(),
      )
      .output(infoRequestOut)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          const partner = partnerFor(userId);
          const limits = terms.upload;
          if (!limits) {
            throw new BankError(
              'The size cap and file types for an answer are not published, so nothing was sent.',
              'bank.info_request_upload_unset',
            );
          }
          const type = input.type.toLowerCase();
          if (!limits.allowedTypes.includes(type)) {
            throw new BankError(`A ${type} file is not one the bank takes for an answer.`, 'bank.info_request_type_not_allowed');
          }
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64) || input.contentBase64.length % 4 !== 0) {
            throw new BankError('The file could not be read.', 'bank.info_request_file_invalid');
          }
          const bytes = Buffer.from(input.contentBase64, 'base64');
          if (bytes.length === 0) throw new BankError('The file is empty.', 'bank.info_request_file_invalid');
          if (bytes.length > limits.maxBytes) {
            throw new BankError(`The file is over the ${limits.maxBytes}-byte cap, so nothing was sent.`, 'bank.info_request_too_large');
          }
          return requestWire(await partner.answerRequest(userId, input.requestId, { name: input.name, type, bytes }));
        }),
      ),

    /** The partner's periodic reviews: each open one with its due date and what missing it does (#4). */
    reviews: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ reviews: z.array(reviewOut) }).strict())
      .query(({ ctx }) =>
        guard(async () => ({ reviews: (await partnerFor(ctx.principal.userId).reviews(ctx.principal.userId)).map(reviewWire) })),
      ),

    answerReview: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({ reviewId: z.string().min(1).max(128), stillAccurate: z.boolean(), note: z.string().trim().max(500).nullable() })
          .strict(),
      )
      .output(reviewOut)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          reviewWire(
            await partnerFor(ctx.principal.userId).answerReview(ctx.principal.userId, input.reviewId, {
              stillAccurate: input.stillAccurate,
              note: input.note,
            }),
          ),
        ),
      ),

    /** Whether the account is open, closing (restricted) or closed, every closure newest first, and the reopen window (#5, #6). */
    closure: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z
          .object({
            state: z.enum(['open', 'pending', 'closed']),
            closures: z.array(closureOut),
            reopenWindow: z.union([
              z.object({ state: z.literal('published'), days: z.number().int(), until: iso.nullable() }).strict(),
              unset('bank.reopen_window_unset'),
            ]),
          })
          .strict(),
      )
      .query(({ ctx }) =>
        guard(async () => {
          const now = await partnerFor(ctx.principal.userId).closure(ctx.principal.userId);
          const closedAt = now.state === 'closed' ? (now.closures[0]?.closedAt ?? null) : null;
          return {
            state: now.state,
            closures: now.closures.map(closureWire),
            reopenWindow:
              terms.reopenWindowDays === null
                ? { state: 'unset' as const, code: 'bank.reopen_window_unset' as const }
                : {
                    state: 'published' as const,
                    days: terms.reopenWindowDays,
                    until: closedAt ? new Date(closedAt.getTime() + terms.reopenWindowDays * 86_400_000).toISOString() : null,
                  },
          };
        }),
      ),

    /** Asks the partner to close the account, once per `closureId`; a balance needs a destination; a legal hold refuses (#5). */
    requestClosure: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            closureId: businessId,
            destination: z
              .object({
                name: z.string().trim().min(1).max(140),
                accountRef: z
                  .string()
                  .trim()
                  .regex(/^[A-Za-z0-9 ]{6,40}$/),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .output(closureOut)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          closureWire(
            await partnerFor(ctx.principal.userId).requestClosure(
              ctx.principal.userId,
              `${ctx.principal.userId}:${input.closureId}`,
              input.destination
                ? { name: input.destination.name, accountRef: input.destination.accountRef.replace(/\s+/g, '').toUpperCase() }
                : null,
            ),
          ),
        ),
      ),

    /** Reopens a closed account within the owner's window (#6). */
    reopen: scopedProcedure('bank:write', { module: 'bank' })
      .output(closureOut)
      .mutation(({ ctx }) =>
        guard(async () => {
          const partner = partnerFor(ctx.principal.userId);
          if (terms.reopenWindowDays === null) {
            throw new BankError(
              'How long a closed account may be reopened is not published, so it cannot be reopened here.',
              'bank.reopen_window_unset',
            );
          }
          return closureWire(await partner.reopen(ctx.principal.userId, terms.reopenWindowDays));
        }),
      ),

    /** The person's data-rights requests about the account, each with the partner's record of it (#6). */
    dataRequests: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ requests: z.array(dataRequestOut) }).strict())
      .query(({ ctx }) =>
        guard(async () => ({ requests: (await partnerFor(ctx.principal.userId).dataRequests(ctx.principal.userId)).map(dataWire) })),
      ),

    requestData: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ requestId: businessId, kind: z.enum(['access', 'portability']) }).strict())
      .output(dataRequestOut)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          dataWire(
            await partnerFor(ctx.principal.userId).requestData(
              ctx.principal.userId,
              `${ctx.principal.userId}:${input.requestId}`,
              input.kind,
            ),
          ),
        ),
      ),
  });
}
