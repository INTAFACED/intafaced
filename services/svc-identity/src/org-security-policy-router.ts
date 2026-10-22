/** `orgSecurityPolicy.get` and `orgSecurityPolicy.set` (I-account-lifecycle-06). */
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { userCopy } from './user-copy.js';
import { MEMBER_SECOND_FACTORS, OrgSecurityPolicyError, type OrgSecurityPolicyService } from './orgs/org-security-policy.js';

export function orgSecurityPolicyToTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof OrgSecurityPolicyError) {
    const code =
      err.code === 'org.not_found'
        ? 'NOT_FOUND'
        : err.code === 'identity.client_request_id_invalid' || err.code === 'identity.org_policy_idle_out_of_range'
          ? 'BAD_REQUEST'
          : err.code === 'identity.org_policy_delegated' ||
              err.code === 'identity.org_policy_owner_only' ||
              err.code === 'org.membership_denied' ||
              err.code === 'identity.org_policy_2fa' ||
              err.code === 'identity.org_session_idle'
            ? 'FORBIDDEN'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({
      code,
      message: `${userCopy(err.code)} [${err.code}]`,
      cause: err.enrolLink ? { code: err.code, enrolLink: err.enrolLink } : { code: err.code },
    });
  }
  throw err;
}

type Principal = { userId: string; sid: string; kid?: string | null; sub_account?: string | null };
const policyView = z.union([
  z.object({ orgId: z.string().uuid(), state: z.literal('not_set') }),
  z.object({
    orgId: z.string().uuid(),
    state: z.literal('set'),
    memberSecondFactor: z.enum(MEMBER_SECOND_FACTORS),
    idleSignOutSeconds: z.number().int().nullable(),
    version: z.number().int(),
    updatedAt: z.string(),
  }),
]);

export function createOrgSecurityPolicyRouter(service: OrgSecurityPolicyService) {
  return router({
    orgSecurityPolicy: router({
      get: scopedProcedure('identity:read')
        .input(z.object({ orgId: z.string().uuid() }).strict())
        .output(policyView)
        .query(async ({ ctx, input }) => {
          try {
            return await service.get(ctx.principal.userId, input.orgId);
          } catch (err) {
            orgSecurityPolicyToTrpc(err);
          }
        }),
      set: scopedProcedure('identity:write')
        .input(
          z
            .object({
              orgId: z.string().uuid(),
              memberSecondFactor: z.enum(MEMBER_SECOND_FACTORS),
              idleSignOutSeconds: z.number().int().nullable(),
              stepUpApprovalId: z.string().uuid(),
              clientRequestId: z.string().max(4096),
            })
            .strict(),
        )
        .output(z.intersection(policyView, z.object({ changed: z.boolean() })))
        .mutation(async ({ ctx, input }) => {
          const p = ctx.principal as Principal;
          try {
            return await service.set({
              userId: p.userId,
              sessionId: p.sid,
              apiKey: Boolean(p.kid),
              subAccount: Boolean(p.sub_account),
              ...input,
            });
          } catch (err) {
            orgSecurityPolicyToTrpc(err);
          }
        }),
    }),
  });
}
