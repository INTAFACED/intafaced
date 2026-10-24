/**
 * Customer step-up. `stepUp.begin` records the payment and returns a passkey
 * challenge (or accepts an authenticator code). `stepUp.complete` returns a
 * single-use `stepUpApprovalId`. A session access token is required. A refresh
 * token is not a session and is not a factor.
 */
import { z } from 'zod';
import { SAME_PERSON_ACTION_TYPES, protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import { AuthError } from './auth/auth-service.js';
import { CustomerStepUpService, StepUpError } from './auth/customer-step-up.js';
import { userCopy } from './user-copy.js';

const amountField = z.string().regex(/^\d+(\.\d{1,18})?$/);

const webauthnShape = z.object({
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

const beginInput = z
  .object({
    scope: z.enum(SAME_PERSON_ACTION_TYPES),
    purpose: z.string().min(1).max(64),
    amount: amountField.optional(),
    target: z.string().min(1).max(256).optional(),
    fields: z.record(z.string().min(1).max(64), z.string().max(4000)),
  })
  .strict();

const completeInput = z
  .object({
    challengeId: z.string().guid(),
    totpCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    webauthn: webauthnShape.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.totpCode) !== Boolean(value.webauthn), {
    message: 'Provide exactly one of totpCode or webauthn',
  });

const ceremonyOutput = z.object({
  challengeId: z.string().guid(),
  expiresAt: z.string().datetime({ offset: true }),
  scope: z.string(),
  purpose: z.string(),
  amount: z.string().nullable(),
  target: z.string().nullable(),
  totp: z.boolean(),
  webauthn: z
    .object({
      challenge: z.string(),
      timeout: z.number(),
      rpId: z.string(),
      allowCredentials: z.array(
        z.object({
          type: z.literal('public-key'),
          id: z.string(),
          transports: z.array(z.string()).optional(),
        }),
      ),
      userVerification: z.literal('required'),
    })
    .nullable(),
});

const approvalOutput = z.object({
  stepUpApprovalId: z.string().guid(),
  expiresAt: z.string().datetime({ offset: true }),
  scope: z.string(),
  purpose: z.string(),
  amount: z.string().nullable(),
  target: z.string().nullable(),
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
  if (err instanceof TRPCError) throw err;
  if (err instanceof StepUpError) {
    const code =
      err.code === 'step_up.not_found'
        ? 'NOT_FOUND'
        : err.code === 'step_up.expired' || err.code === 'step_up.session_mismatch'
          ? 'PRECONDITION_FAILED'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  if (err instanceof AuthError) throw factorToTrpc(err);
  throw err;
}

export function createStepUpRouter(stepUps: CustomerStepUpService) {
  return router({
    stepUp: router({
      /**
       * Start a confirmation for one payment. Returns a passkey challenge when
       * the account has a passkey, and `totp: true` when a six-digit code will
       * be accepted. Recovery codes are not a method. The result is not an
       * approval and not an access token.
       */
      begin: protectedProcedure
        .input(beginInput)
        .output(ceremonyOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            if (ctx.principal.kid || ctx.principal.sub_account) {
              throw new TRPCError({ code: 'FORBIDDEN', message: 'API keys and sub-accounts cannot confirm a payment' });
            }
            return await stepUps.begin({ userId: ctx.principal.userId, sessionId: ctx.principal.sid }, input);
          } catch (err) {
            toTrpc(err);
          }
        }),

      /**
       * Prove the fresh factor and mint `stepUpApprovalId`. Bound to this user,
       * this session, this scope, and the amount and target from begin. The
       * consuming service spends it once. No access token is returned.
       */
      complete: protectedProcedure
        .input(completeInput)
        .output(approvalOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            if (ctx.principal.kid || ctx.principal.sub_account) {
              throw new TRPCError({ code: 'FORBIDDEN', message: 'API keys and sub-accounts cannot confirm a payment' });
            }
            return await stepUps.complete(
              { userId: ctx.principal.userId, sessionId: ctx.principal.sid },
              {
                challengeId: input.challengeId,
                ...(input.totpCode ? { totpCode: input.totpCode } : {}),
                ...(input.webauthn ? { webauthn: input.webauthn } : {}),
              },
            );
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}
