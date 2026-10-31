/**
 * Action-bound approval doors. Session proposes/approves; HMAC consumes.
 * A typed-in second name is not accepted on approve.
 */
import { z } from 'zod';
import {
  SAME_PERSON_ACTION_TYPES,
  actionApprovalApproveInputSchema,
  actionApprovalConsumeInputSchema,
  actionApprovalIdInputSchema,
  actionApprovalPoliciesReadSchema,
  actionApprovalProposeInputSchema,
  actionApprovalSchema,
  protectedProcedure,
  router,
  scopedProcedure,
  serviceProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { AuthError as GuardError, hasScope, requireMfa } from '@intafaced/auth';
import { ActionApprovalError, type ActionApprovalService } from './auth/action-approval-service.js';
import {
  isInteractiveFounderPrincipal,
  isOperatorPrincipal,
  isTradeOpsOperatorPrincipal,
  type ApprovalSubject,
} from './auth/action-approval-audience.js';
import { AuthError, type AuthService } from './auth/auth-service.js';
import { userCopy } from './user-copy.js';

/**
 * Proves ONE fresh second factor for this user and session, or throws `AuthError`.
 * Wired in `index.ts` to `auth.stepUp`: the same TOTP / WebAuthn verification, the same
 * attempt lockout, the same single-use passkey challenge (from `auth.stepUpOptions`). The
 * elevated token it mints is discarded; only the proof is used here.
 */
export type SamePersonFactorVerifier = (input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly totpCode?: string;
  readonly webauthn?: Parameters<AuthService['stepUp']>[0]['webauthn'];
}) => Promise<void>;

const webauthnShape = () =>
  z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal('public-key'),
    response: z.object({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().nullish(),
    }),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  });

const samePersonCreateInput = z
  .object({
    actionType: z.enum(SAME_PERSON_ACTION_TYPES),
    payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    // Six-digit TOTP ONLY. A recovery code (XXXXX-XXXXX) is deliberately not accepted for money-out.
    totpCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    webauthn: webauthnShape().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.totpCode) !== Boolean(v.webauthn), {
    message: 'Provide exactly one of totpCode or webauthn',
  });

function factorToTrpc(err: AuthError): TRPCError {
  const message = userCopy(err.code);
  switch (err.code) {
    case 'auth.mfa_invalid':
    case 'auth.webauthn_invalid':
    case 'auth.mfa_required':
    case 'auth.session_invalid':
    case 'auth.session_reused':
      return new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
    case 'auth.too_many_attempts':
      return new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: err });
    case 'auth.mfa_not_enrolled':
    case 'auth.webauthn_not_enrolled':
    case 'auth.account_frozen':
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    case 'auth.not_found':
      return new TRPCError({ code: 'NOT_FOUND', message, cause: err });
    default:
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
  }
}

function toTrpc(err: unknown): never {
  if (err instanceof GuardError) {
    throw new TRPCError({
      code: err.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof ActionApprovalError) {
    const code =
      err.code === 'action_approval.not_found'
        ? 'NOT_FOUND'
        : err.code === 'action_approval.not_requester' ||
            err.code === 'action_approval.service_mismatch' ||
            err.code === 'action_approval.operator_only' ||
            err.code === 'action_approval.trade_ops_only' ||
            err.code === 'action_approval.founder_only' ||
            err.code === 'action_approval.audience_mismatch'
          ? 'FORBIDDEN'
          : err.code === 'action_approval.founders_unavailable'
            ? 'SERVICE_UNAVAILABLE'
            : err.code === 'action_approval.type_not_same_person' || err.code === 'action_approval.type_not_four_eyes'
              ? 'BAD_REQUEST'
              : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.message} [${err.code}]`, cause: err });
  }
  if (err instanceof AuthError) throw factorToTrpc(err);
  throw err;
}

export function createActionApprovalRouter(
  svc: ActionApprovalService,
  deps: { readonly verifyFactor?: SamePersonFactorVerifier; readonly privilegedUserIds?: readonly string[] } = {},
) {
  const privilegedUserIds = deps.privilegedUserIds ?? [];

  /**
   * Who may propose, approve or reject. `founder` types need a live founder: an interactive MFA principal (no API key,
   * no sub-account) that identity's founder directory still lists; an `admin:*` scope does not count. `operator` types
   * need an operator principal. `self` is only a stored same-person row (its own door). Decided from the whole request (type, target service and
   * target id), not the type string alone.
   */
  async function callerAccess(
    principal: Parameters<typeof isOperatorPrincipal>[0],
  ): Promise<{ operator: boolean; founder: boolean; tradeOps: boolean; adminRead: boolean }> {
    const operator = isOperatorPrincipal(principal, privilegedUserIds);
    const founder = isInteractiveFounderPrincipal(principal) && (await svc.isFounder(principal.userId));
    const tradeOps = isTradeOpsOperatorPrincipal(principal);
    const adminRead = hasScope(principal.scopes, 'admin:read');
    return { operator, founder, tradeOps, adminRead };
  }

  async function assertAudienceFor(
    principal: Parameters<typeof isOperatorPrincipal>[0],
    subject: ApprovalSubject | null,
    whenUnset: 'refuse' | 'default' = 'refuse',
  ): Promise<void> {
    // An unknown approval id falls through to the service's own `not_found`; nothing is disclosed here.
    if (subject === null) return;
    // A governed type takes its audience from the owner policy row (refusing `policy_unset` when it is blank), and a
    // caller outside it is `audience_mismatch`. Every other type keeps the fixed audience and its codes.
    const audience = svc.audienceFor(subject, whenUnset);
    if (svc.isGoverned(subject) && !(await inAudience(principal, audience))) {
      throw new ActionApprovalError(
        'this caller is not in the approval policy audience for this action type',
        'action_approval.audience_mismatch',
      );
    }
    if (audience === 'self') return;
    if (audience === 'founder') {
      if (!isInteractiveFounderPrincipal(principal) || !(await svc.isFounder(principal.userId))) {
        throw new ActionApprovalError('this action type is a founder-only action', 'action_approval.founder_only');
      }
      return;
    }
    if (audience === 'trade_ops') {
      if (!isTradeOpsOperatorPrincipal(principal)) {
        throw new ActionApprovalError('this action type is a trade-ops operator action', 'action_approval.trade_ops_only');
      }
      return;
    }
    if (!isOperatorPrincipal(principal, privilegedUserIds)) {
      throw new ActionApprovalError('this action type is an operator action', 'action_approval.operator_only');
    }
  }

  async function inAudience(principal: Parameters<typeof isOperatorPrincipal>[0], audience: string): Promise<boolean> {
    if (audience === 'founder') return isInteractiveFounderPrincipal(principal) && (await svc.isFounder(principal.userId));
    if (audience === 'trade_ops') return isTradeOpsOperatorPrincipal(principal);
    if (audience === 'operator') return isOperatorPrincipal(principal, privilegedUserIds);
    return false;
  }

  return router({
    actionApproval: router({
      /**
       * Money-out step-up. The signed-in user proves a fresh passkey assertion (from
       * `auth.stepUpOptions`) or a six-digit TOTP code IN THIS REQUEST, for an intent hash they
       * computed. The result is an approval only they, in this session, can spend once at svc-bank
       * within five minutes. A session alone is not enough, a recovery code is refused, and no
       * bearer token is minted. Four-eyes approvals are a different door (`propose`/`approve`).
       *
       * Honest limit: the passkey challenge is not derived from the hash, so this buys single use and
       * no reuse for a different payload. It does not stop a compromised page from asking the user to
       * tap for the wrong payload; see the ADR.
       */
      createSamePerson: protectedProcedure
        .input(samePersonCreateInput)
        .output(actionApprovalSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            if (!deps.verifyFactor) {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'step-up factor verification is not wired' });
            }
            if (ctx.principal.kid || ctx.principal.sub_account) {
              // An API key or a sub-account has no interactive second factor and may never mint a step-up approval.
              throw new TRPCError({ code: 'FORBIDDEN', message: 'API keys and sub-accounts cannot create step-up approvals' });
            }
            await deps.verifyFactor({
              userId: ctx.principal.userId,
              sessionId: ctx.principal.sid,
              ...(input.totpCode ? { totpCode: input.totpCode } : {}),
              ...(input.webauthn ? { webauthn: input.webauthn } : {}),
            });
            return await svc.createSamePerson(
              { userId: ctx.principal.userId, sessionId: ctx.principal.sid },
              { actionType: input.actionType, payloadHash: input.payloadHash },
            );
          } catch (err) {
            if (err instanceof TRPCError) throw err;
            toTrpc(err);
          }
        }),

      propose: protectedProcedure
        .input(actionApprovalProposeInputSchema)
        .output(actionApprovalSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            await assertAudienceFor(ctx.principal, input);
            return await svc.propose(ctx.principal.userId, input);
          } catch (err) {
            toTrpc(err);
          }
        }),

      approve: protectedProcedure
        .input(actionApprovalApproveInputSchema)
        .output(actionApprovalSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            await assertAudienceFor(ctx.principal, await svc.subjectOf(input.approvalId));
            return await svc.approve(ctx.principal.userId, input.approvalId, input.expectedPayloadHash);
          } catch (err) {
            toTrpc(err);
          }
        }),

      reject: protectedProcedure
        .input(actionApprovalIdInputSchema)
        .output(actionApprovalSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            await assertAudienceFor(ctx.principal, await svc.subjectOf(input.approvalId), 'default');
            return await svc.reject(ctx.principal.userId, input.approvalId);
          } catch (err) {
            toTrpc(err);
          }
        }),

      /**
       * Pending approvals this caller may decide, or the caller's own requests.
       * A session that is neither an operator nor a founder is refused the pending
       * view. `mine` is the caller's own rows. Limit is required — omit is not a page.
       */
      list: protectedProcedure
        .input(z.object({ view: z.enum(['pending', 'mine']), limit: z.number().int().min(1).max(100) }))
        .output(z.object({ approvals: z.array(actionApprovalSchema), pageFull: z.boolean() }))
        .query(async ({ ctx, input }) => {
          try {
            const access = await callerAccess(ctx.principal);
            if (input.view === 'pending' && !access.operator && !access.founder) {
              throw new ActionApprovalError('pending approvals are an operator or founder read', 'action_approval.operator_only');
            }
            return await svc.listForCaller(ctx.principal.userId, input.view, input.limit, access);
          } catch (err) {
            toTrpc(err);
          }
        }),

      /**
       * Every policy-governed action type with its owner policy row, or `unset` with `action_approval.policy_unset`
       * (OPS-change-control-01 CR-1). A founder or operator read for the console; it changes nothing.
       */
      policies: protectedProcedure.output(actionApprovalPoliciesReadSchema).query(async ({ ctx }) => {
        try {
          const access = await callerAccess(ctx.principal);
          if (!access.operator && !access.founder) {
            throw new ActionApprovalError('approval policies are an operator or founder read', 'action_approval.operator_only');
          }
          return { policies: svc.policyEntries() };
        } catch (err) {
          toTrpc(err);
        }
      }),

      /** One approval by id. The requester, or an operator/founder in its audience. */
      get: protectedProcedure
        .input(z.object({ approvalId: z.string().min(1).max(128) }))
        .output(actionApprovalSchema)
        .query(async ({ ctx, input }) => {
          try {
            return await svc.getForCaller(ctx.principal.userId, input.approvalId, await callerAccess(ctx.principal));
          } catch (err) {
            toTrpc(err);
          }
        }),

      revoke: protectedProcedure
        .input(actionApprovalIdInputSchema)
        .output(actionApprovalSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await svc.revoke(ctx.principal.userId, input.approvalId);
          } catch (err) {
            toTrpc(err);
          }
        }),

      consume: serviceProcedure
        .input(actionApprovalConsumeInputSchema)
        .output(actionApprovalSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await svc.consume(ctx.service as string, input);
          } catch (err) {
            toTrpc(err);
          }
        }),

      /**
       * Edge has no INTERNAL_SERVICE_SECRET (must not reach ledger.post).
       * Kill-switch consume is session + MFA, and only for targetService svc-edge.
       */
      consumeForEdge: scopedProcedure('admin:write')
        .input(actionApprovalConsumeInputSchema)
        .output(actionApprovalSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            if (input.targetService !== 'svc-edge') {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'consumeForEdge is only for svc-edge kill-switch approvals',
              });
            }
            return await svc.consume('svc-edge', { ...input, consumerPrincipalId: ctx.principal.userId });
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}
