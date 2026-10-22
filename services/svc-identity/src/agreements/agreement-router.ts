/** `agreements.*` (RC-identity-12): listMine and accept for customers, publish (four-eyes) for compliance, requires for services. */
import { z } from 'zod';
import {
  agreementKindSchema,
  agreementRequiresInputSchema,
  agreementRequiresOutputSchema,
  protectedProcedure,
  router,
  scopedProcedure,
  serviceProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { AgreementError, type AgreementService } from './agreement-service.js';

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof AgreementError) {
    const code =
      err.code === 'auth.not_found'
        ? 'NOT_FOUND'
        : err.code === 'identity.agreement_signer_not_admin' || err.code === 'identity.agreement_delegated'
          ? 'FORBIDDEN'
          : err.code === 'identity.agreement_not_published' ||
              err.code === 'identity.agreement_version_not_current' ||
              err.code === 'identity.agreement_approval_refused'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  throw err;
}

const row = z.object({
  kind: agreementKindSchema,
  currentVersion: z.number().int(),
  jurisdiction: z.string(),
  textRef: z.string(),
  disputeVenue: z.string(),
  publishedAt: z.string(),
  acceptedVersion: z.number().int().nullable(),
  needsAcceptance: z.boolean(),
});

export function createAgreementRouter(service: AgreementService) {
  return router({
    agreements: router({
      listMine: protectedProcedure
        .input(z.object({ orgId: z.string().uuid().optional() }).strict())
        .output(z.array(row))
        .query(async ({ ctx, input }) => {
          try {
            return await service.listMine({ userId: ctx.principal.userId, orgId: input.orgId });
          } catch (err) {
            toTrpc(err);
          }
        }),
      accept: scopedProcedure('identity:write')
        .input(z.object({ kind: agreementKindSchema, version: z.number().int().positive(), orgId: z.string().uuid().optional() }).strict())
        .output(z.object({ accepted: z.literal(true), changed: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          const p = ctx.principal as { userId: string; kid?: string | null; sub_account?: string | null };
          try {
            return await service.accept({ userId: p.userId, delegated: Boolean(p.kid || p.sub_account), ...input });
          } catch (err) {
            toTrpc(err);
          }
        }),
      publish: scopedProcedure('admin:compliance')
        .input(
          z
            .object({
              kind: agreementKindSchema,
              jurisdiction: z.string().max(64),
              textRef: z.string().max(512),
              disputeVenue: z.string().max(256),
              approvalId: z.string().max(128).nullish(),
              operationId: z.string().max(128).nullish(),
            })
            .strict(),
        )
        .output(z.object({ kind: agreementKindSchema, version: z.number().int() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await service.publish({ actorId: ctx.principal.userId, ...input });
          } catch (err) {
            toTrpc(err);
          }
        }),
      requires: serviceProcedure
        .input(agreementRequiresInputSchema)
        .output(agreementRequiresOutputSchema)
        .query(async ({ input }) => service.requires(input.subjectId, input.kind)),
    }),
  });
}
