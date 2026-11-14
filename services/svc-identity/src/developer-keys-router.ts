import { router, scopedProcedure, serviceProcedureFor, TRPCError } from '@intafaced/contracts';
import {
  apiKeyCreateInputSchema,
  apiKeyCreateOutputSchema,
  apiKeyDetailSchema,
  apiKeyGetInputSchema,
  apiKeyListInputSchema,
  apiKeyRevokeInputSchema,
  apiKeyRevokeOutputSchema,
  apiKeySetExpiryInputSchema,
  apiKeySetExpiryOutputSchema,
  apiKeyListOutputSchema,
  apiKeyScopesOutputSchema,
  agentKeyApprovalListInputSchema,
  agentKeyApprovalListOutputSchema,
  agentKeyHoldInputSchema,
  agentKeyHoldOutputSchema,
  apiKeyCallRecordInputSchema,
  apiKeyCallRecordOutputSchema,
  apiKeyCallsInputSchema,
  apiKeyCallsOutputSchema,
  developerSetRoleInputSchema,
  developerSetRoleOutputSchema,
  developerTeamInputSchema,
  developerTeamSchema,
  apiKeyRotateInputSchema,
  apiKeyRotateOutputSchema,
} from '@intafaced/contracts/api-keys';
import { ApiKeyCallsError, listApiKeyCalls, recordApiKeyCall } from './auth/api-key-calls.js';
import { AgentKeyApprovalError, holdAgentKeyAction, listAgentKeyApprovals } from './auth/agent-key-approvals.js';
import { rotateDeveloperKey } from './auth/developer-key-rotate.js';
import { LeakedKeyError, operatorKeyAudit, reportLeakedKey } from './ops/leaked-api-key.js';
import { approveByPerson, RotationRequestError, waitingRotation } from './auth/key-rotation-requests.js';
import { z } from 'zod';
import { optionalFactorProof } from './auth/api-key-fresh-factor.js';
import {
  createDeveloperKey,
  describeKeyScopes,
  DeveloperKeyError,
  getDeveloperKey,
  listDeveloperKeys,
  checkRevokeReason,
  revokeDeveloperKey,
  setDeveloperKeyExpiry,
  toRecord,
  type DeveloperKeysDeps,
} from './auth/developer-keys.js';
import { developerTeam, DeveloperTeamError, revokeOrgKey, setDeveloperRole } from './auth/developer-team.js';
import { MintApiKeyPasskeyError } from './auth/mint-api-key-passkey.js';
import { userCopy } from './user-copy.js';

export const DEVELOPER_KEY_STATUS: Record<DeveloperKeyError['code'], TRPCError['code']> = {
  'auth.scope_empty': 'BAD_REQUEST',
  'auth.scope_unknown': 'BAD_REQUEST',
  'auth.scope_interactive_only': 'FORBIDDEN',
  'auth.scope_not_held': 'FORBIDDEN',
  'auth.ip_invalid': 'BAD_REQUEST',
  'identity.key_name_invalid': 'BAD_REQUEST',
  'identity.key_name_taken': 'CONFLICT',
  'identity.key_expiry_invalid': 'BAD_REQUEST',
  'identity.key_cap_unset': 'PRECONDITION_FAILED',
  'identity.key_cap_reached': 'PRECONDITION_FAILED',
  'identity.key_request_conflict': 'CONFLICT',
  'identity.key_signing_unset': 'PRECONDITION_FAILED',
  'identity.key_lead_not_approved': 'FORBIDDEN',
  'identity.key_lead_check_unavailable': 'PRECONDITION_FAILED',
  'identity.key_not_found': 'NOT_FOUND',
  'identity.key_not_live': 'PRECONDITION_FAILED',
  'identity.key_revoke_reason_invalid': 'BAD_REQUEST',
  'identity.key_account_required': 'BAD_REQUEST',
  'identity.key_account_denied': 'FORBIDDEN',
  'identity.key_org_denied': 'FORBIDDEN',
  'identity.portfolio_key_cap_unset': 'PRECONDITION_FAILED',
  'identity.portfolio_key_cap_reached': 'PRECONDITION_FAILED',
  'auth.agent_scope_forbidden': 'FORBIDDEN',
  'identity.developer_roles_unset': 'PRECONDITION_FAILED',
  'identity.developer_role_read_only': 'FORBIDDEN',
  'identity.developer_role_none': 'FORBIDDEN',
  'identity.key_rotate_overlap_unset': 'PRECONDITION_FAILED',
  'identity.key_rotate_overlap_too_long': 'BAD_REQUEST',
};

const DEVELOPER_TEAM_STATUS: Record<DeveloperTeamError['code'], TRPCError['code']> = {
  'identity.developer_roles_unset': 'PRECONDITION_FAILED',
  'identity.developer_role_read_only': 'FORBIDDEN',
  'identity.developer_role_none': 'FORBIDDEN',
  'identity.developer_org_denied': 'NOT_FOUND',
  'identity.developer_role_denied': 'FORBIDDEN',
  'identity.developer_role_unknown': 'BAD_REQUEST',
  'identity.developer_member_unknown': 'NOT_FOUND',
  'identity.developer_request_conflict': 'CONFLICT',
};

function refused(err: unknown): never {
  if (err instanceof DeveloperTeamError) {
    throw new TRPCError({ code: DEVELOPER_TEAM_STATUS[err.code], message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  if (err instanceof DeveloperKeyError) {
    throw new TRPCError({ code: DEVELOPER_KEY_STATUS[err.code], message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  // Only an account with a verified passkey may hold a key (the live service's mint rule).
  if (err instanceof MintApiKeyPasskeyError && err.code !== 'auth.not_found') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  throw err;
}

function leakRefused(err: unknown): never {
  if (err instanceof LeakedKeyError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `${err.message} [${err.code}]`, cause: err });
  }
  throw err;
}

const ROTATION_REQUEST_STATUS: Record<RotationRequestError['code'], TRPCError['code']> = {
  'identity.key_not_found': 'NOT_FOUND',
  'identity.key_not_live': 'PRECONDITION_FAILED',
  'identity.rotation_request_not_found': 'NOT_FOUND',
  'identity.rotation_self_approval': 'FORBIDDEN',
  'identity.rotation_approver_not_person': 'FORBIDDEN',
  'identity.rotation_key_only': 'BAD_REQUEST',
};

function rotationRefused(err: unknown): never {
  if (err instanceof RotationRequestError) {
    throw new TRPCError({ code: ROTATION_REQUEST_STATUS[err.code], message: `${err.message} [${err.code}]`, cause: err });
  }
  refused(err);
}

function assertSignedInPerson(principal: { kid?: string | undefined; sub_account?: string | undefined }): void {
  if (principal.kid || principal.sub_account) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `${userCopy('identity.delegated_refused')} [identity.delegated_refused]` });
  }
}

/**
 * The developer room's key doors (`developerKeys.*`), beside `apiKeys.*` so mergeRouters cannot replace either.
 * Only a person signed in on a device may use them: an API key or a sub-account is refused before anything is read.
 */
export function createDeveloperKeysRouter(deps: DeveloperKeysDeps) {
  return router({
    developerKeys: router({
      create: scopedProcedure('identity:write')
        .input(apiKeyCreateInputSchema.extend({ factorProof: optionalFactorProof }))
        .output(apiKeyCreateOutputSchema)
        .mutation(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await createDeveloperKey(deps, ctx.principal, input);
          } catch (err) {
            refused(err);
          }
        }),

      list: scopedProcedure('identity:read')
        .input(apiKeyListInputSchema)
        .output(apiKeyListOutputSchema)
        .query(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          return listDeveloperKeys(deps, ctx.principal.userId, input.limit);
        }),

      get: scopedProcedure('identity:read')
        .input(apiKeyGetInputSchema)
        .output(apiKeyDetailSchema)
        .query(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await getDeveloperKey(deps, ctx.principal.userId, input.keyId);
          } catch (err) {
            refused(err);
          }
        }),

      /** No second factor: the person can always switch a key off. A key or a sub-account still cannot call it. */
      revoke: scopedProcedure('identity:write')
        .input(apiKeyRevokeInputSchema)
        .output(apiKeyRevokeOutputSchema)
        .mutation(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            if (input.orgId !== undefined) {
              // An organisation's key: its owner or a key admin revokes it (DV-console-01).
              const done = await revokeOrgKey(
                deps.sql,
                input.orgId,
                ctx.principal.userId,
                input.keyId,
                checkRevokeReason(input.reason),
                deps.developerRoles ?? null,
              );
              if (!done) throw new DeveloperKeyError('No key with this id in this organisation', 'identity.key_not_found');
              return { record: toRecord(done.row), changed: done.changed };
            }
            return await revokeDeveloperKey(deps, ctx.principal.userId, input);
          } catch (err) {
            refused(err);
          }
        }),

      /** The organisation's developer area as the caller sees it (DV-console-01): their role, the reason, its keys. */
      team: scopedProcedure('identity:read')
        .input(developerTeamInputSchema)
        .output(developerTeamSchema)
        .query(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await developerTeam(deps.sql, input.orgId, ctx.principal.userId, deps.developerRoles ?? null);
          } catch (err) {
            refused(err);
          }
        }),

      /** The owner gives a member a developer role or takes it away; a member never can. */
      setTeamRole: scopedProcedure('identity:write')
        .input(developerSetRoleInputSchema)
        .output(developerSetRoleOutputSchema)
        .mutation(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await setDeveloperRole(deps.sql, ctx.principal.userId, input, deps.developerRoles ?? null);
          } catch (err) {
            refused(err);
          }
        }),

      /** A key can never move its own end date (or any key's): the delegate refusal comes before anything is read. */
      setExpiry: scopedProcedure('identity:write')
        .input(apiKeySetExpiryInputSchema.extend({ factorProof: optionalFactorProof }))
        .output(apiKeySetExpiryOutputSchema)
        .mutation(async ({ ctx, input }) => {
          // T-8: a key principal gets the delegate refusal, as the older expire door gives it.
          if (ctx.principal.kid) {
            throw new TRPCError({ code: 'FORBIDDEN', message: `${userCopy('auth.delegate_cannot_grant')} [auth.delegate_cannot_grant]` });
          }
          assertSignedInPerson(ctx.principal);
          try {
            return await setDeveloperKeyExpiry(deps, ctx.principal, input);
          } catch (err) {
            refused(err);
          }
        }),

      /**
       * An operator reports a leaked key string (DV-keys-05, J-developer-07 #6). The same reply for a match, a repeat
       * and a string that is no key; a live match is revoked with one audit row and one notice to its holder.
       */
      reportLeaked: scopedProcedure('admin:compliance')
        .input(z.object({ key: z.string().min(1).max(512) }).strict())
        .output(z.object({ received: z.literal(true) }).strict())
        .mutation(async ({ ctx, input }) => {
          try {
            return await reportLeakedKey(deps.sql, ctx, input.key);
          } catch (err) {
            leakRefused(err);
          }
        }),

      /** The operator revoke record of one key (at most one entry), for the reporting operator. */
      operatorAudit: scopedProcedure('admin:compliance')
        .input(z.object({ keyId: z.string().guid(), limit: z.number().int().min(1).max(100).optional() }).strict())
        .output(
          z.object({ entries: z.array(z.object({ actorId: z.string(), reason: z.string(), revokedAt: z.string() }).strict()) }).strict(),
        )
        .query(async ({ ctx, input }) => {
          try {
            return await operatorKeyAudit(deps.sql, ctx, input.keyId);
          } catch (err) {
            leakRefused(err);
          }
        }),

      /** A key can never rotate itself here: a key's own request goes through the approval door instead. */
      rotate: scopedProcedure('identity:write')
        .input(apiKeyRotateInputSchema.extend({ factorProof: optionalFactorProof }))
        .output(apiKeyRotateOutputSchema)
        .mutation(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await rotateDeveloperKey(deps, ctx.principal, input);
          } catch (err) {
            refused(err);
          }
        }),

      /** The waiting rotation request a key made for itself, shown on the key's page for its owner to approve. */
      rotationRequest: scopedProcedure('identity:read')
        .input(z.object({ keyId: z.string().uuid() }))
        .output(
          z.object({
            request: z
              .object({ requestId: z.string(), keyId: z.string(), overlapSeconds: z.number().int(), createdAt: z.string() })
              .nullable(),
          }),
        )
        .query(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          return { request: await waitingRotation(deps.sql, ctx.principal.userId, input.keyId) };
        }),

      /** The owner, signed in on a device with a fresh passkey, approves a key's request: one replacement issues. */
      approveRotation: scopedProcedure('identity:write')
        .input(z.object({ requestId: z.string().uuid(), factorProof: optionalFactorProof }))
        .output(apiKeyRotateOutputSchema)
        .mutation(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await approveByPerson(deps, ctx.principal, input);
          } catch (err) {
            rotationRefused(err);
          }
        }),

      scopes: scopedProcedure('identity:read')
        .output(apiKeyScopesOutputSchema)
        .query(({ ctx }) => {
          assertSignedInPerson(ctx.principal);
          return { scopes: describeKeyScopes(ctx.principal.scopes) };
        }),

      /** The owner's agent keys' held attempts (DV-keys-05): each a waiting row; nothing was sent. */
      approvals: scopedProcedure('identity:read')
        .input(agentKeyApprovalListInputSchema)
        .output(agentKeyApprovalListOutputSchema)
        .query(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          return listAgentKeyApprovals(deps.sql, ctx.principal.userId, input.limit);
        }),

      /** One key's call log (DV-keys-06): its owner only; anyone else's key is not found. Never a body or header value. */
      calls: scopedProcedure('identity:read')
        .input(apiKeyCallsInputSchema)
        .output(apiKeyCallsOutputSchema)
        .query(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await listApiKeyCalls(deps.sql, ctx.principal.userId, input);
          } catch (err) {
            if (err instanceof ApiKeyCallsError) {
              throw new TRPCError({ code: 'NOT_FOUND', message: `${userCopy(err.code)} [${err.code}]`, cause: err });
            }
            throw err;
          }
        }),

      /** The edge's report of one call it answered for an API key (`api-key-calls.ts`). Only the edge may send it. */
      recordCall: serviceProcedureFor(['svc-edge'])
        .input(apiKeyCallRecordInputSchema)
        .output(apiKeyCallRecordOutputSchema)
        .mutation(({ input }) => recordApiKeyCall(deps.sql, input)),

      /**
       * The edge's ask when an API key attempts a held action (`AGENT_HELD_ACTIONS`): an agent key's attempt becomes a
       * waiting row and is not forwarded; any other key is not held. Only the edge may call it.
       */
      holdAgentAction: serviceProcedureFor(['svc-edge'])
        .input(agentKeyHoldInputSchema)
        .output(agentKeyHoldOutputSchema)
        .mutation(async ({ input }) => {
          try {
            return await holdAgentKeyAction(deps.sql, input);
          } catch (err) {
            if (err instanceof AgentKeyApprovalError) {
              throw new TRPCError({ code: 'NOT_FOUND', message: `${userCopy(err.code)} [${err.code}]`, cause: err });
            }
            throw err;
          }
        }),
    }),
  });
}
