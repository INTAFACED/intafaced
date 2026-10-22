import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import {
  PRIVACY_APPROVAL_REQUIRED,
  PRIVACY_SECTIONS,
  PRIVACY_VERSION_CONFLICT,
  PrivacyRegisterError,
  publishSection,
  readRegister,
} from './privacy-register.js';

const section = z.enum(PRIVACY_SECTIONS);
const entry = z.union([
  z
    .object({
      section,
      state: z.literal('published'),
      version: z.number().int(),
      bodyRef: z.string(),
      retentionPeriod: z.string().nullable(),
      publishedAt: z.string(),
    })
    .strict(),
  z.object({ section, state: z.literal('not_set') }).strict(),
]);
const publishedEntry = z
  .object({
    section,
    state: z.literal('published'),
    version: z.number().int(),
    bodyRef: z.string(),
    retentionPeriod: z.string().nullable(),
    publishedAt: z.string(),
    approvalId: z.string(),
  })
  .strict();

function privacyError(error: unknown): never {
  if (error instanceof PrivacyRegisterError) {
    const code =
      error.code === PRIVACY_VERSION_CONFLICT ? 'CONFLICT' : error.code === PRIVACY_APPROVAL_REQUIRED ? 'FORBIDDEN' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: error.code, cause: error });
  }
  throw error;
}

function actor(ctx: { principal: { userId: string } | null }): string {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.required' });
  return ctx.principal.userId;
}

export function createPrivacyRegisterRouter(sql: Sql) {
  return router({
    privacy: router({
      register: router({
        /** Signed-in customers: every section, published text reference or `not_set`. */
        get: scopedProcedure('identity:read')
          .input(z.object({ section: section.optional(), version: z.number().int().positive().optional() }).strict().optional())
          .output(z.array(entry))
          .query(async ({ input }) => {
            if (input?.version !== undefined && input.section === undefined) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'identity.privacy_section_required' });
            }
            const at =
              input?.section !== undefined && input.version !== undefined ? { section: input.section, version: input.version } : undefined;
            return readRegister(sql, at);
          }),
        /** Founder-ops: consumes an APPROVED identity.privacy_publish approval (four-eyes: approver is not requester). */
        publish: scopedProcedure('admin:write')
          .input(
            z
              .object({
                section,
                version: z.number().int().positive(),
                bodyRef: z.string().max(2048),
                retentionPeriod: z.string().max(256).nullable().optional(),
                approvalId: z.string().min(1).max(128),
              })
              .strict(),
          )
          .output(publishedEntry)
          .mutation(async ({ ctx, input }) => {
            try {
              return await publishSection(sql, actor(ctx), { ...input, requestId: ctx.requestId });
            } catch (error) {
              privacyError(error);
            }
          }),
      }),
    }),
  });
}
