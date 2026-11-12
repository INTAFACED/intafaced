import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import {
  checkLinkEmailCode,
  checkLinkPassword,
  checkLinkWallet,
  checkUnlink,
  linkEmailCode,
  linkPassword,
  linkWallet,
  listSigninMethods,
  parseSigninMethod,
  SigninMethodError,
  startWalletChallenge,
  unlinkSigninMethod,
  VENDOR_SMS,
  walletAddress,
  type SigninMethods,
  type WalletConfig,
} from './auth/signin-methods.js';
import { SecurityLockError } from './auth/security-lock.js';
import { toSecurityStepUpTrpc, type SecurityStepUp } from './auth/security-step-up.js';
import { SocialError, type SocialSignin } from './social/social-signin.js';
import { userCopy } from './user-copy.js';

const methodsOutput = z.object({
  password: z.boolean(),
  emailCode: z.object({ on: z.boolean(), address: z.string().nullable(), proved: z.boolean() }),
  passkeys: z.number().int(),
  wallets: z.array(z.object({ address: z.string(), linkedAt: z.string() })),
  providers: z.array(z.string()),
});

/** A wallet's signed answer, for linking it here and for signing in with it (`auth.walletSignIn`): one shape for both. */
export const walletAnswerFields = {
  flowId: z.string().guid(),
  message: z.string().min(1).max(2000),
  signature: z.string().min(1).max(4000),
};
const walletAnswer = z.object(walletAnswerFields).strict();
/** The wallet asking for a message to sign, to link it or to sign in with it. */
export const walletChallengeInput = z
  .object({
    address: z.string().min(1).max(64),
    chainId: z
      .number()
      .int()
      .positive()
      .max(2 ** 53 - 1),
    origin: z.string().max(256).optional(),
  })
  .strict();
export const walletChallengeOutput = z.object({ flowId: z.string(), message: z.string(), expiresAt: z.string() });
const clientRequestId = z.string().min(1).max(128);
const stepUpApprovalId = z.string().min(1).max(128).nullish();
const phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);

/** A refused sign-in method change as the wire answer, or null for any other error. The code travels in `cause.code`. */
export function signinMethodTrpc(err: unknown): TRPCError | null {
  if (!(err instanceof SigninMethodError)) return null;
  const code =
    err.code === 'auth.not_found'
      ? 'NOT_FOUND'
      : err.code === 'auth.account_frozen'
        ? 'FORBIDDEN'
        : err.code === 'identity.method_taken' || err.code === 'identity.method_already_linked'
          ? 'CONFLICT'
          : err.code === 'identity.last_signin_method' || err.code === VENDOR_SMS || err.code === 'identity.method_unverified'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
  return new TRPCError({ code, message: userCopy(err.code), cause: err });
}

function signinMethodTrpcError(err: unknown): never {
  const mapped = signinMethodTrpc(err);
  if (mapped) throw mapped;
  if (err instanceof SecurityLockError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(err.code), cause: { code: err.code } });
  }
  if (err instanceof SocialError) {
    const code =
      err.code === 'identity.provider_taken'
        ? 'CONFLICT'
        : err.code === 'identity.social_flow_invalid' || err.code === 'identity.social_exchange_failed'
          ? 'BAD_REQUEST'
          : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.message} [${err.code}]`, cause: err });
  }
  return toSecurityStepUpTrpc(err);
}

/**
 * Link and unlink sign-in methods (I-account-lifecycle-07). Top-level, beside `listPasskeys`. Each change checks what
 * would refuse it first (a wrong signature, a weak password, the last way in, a phone with no text provider), then the
 * security step-up (`link_method`, `unlink_method`), then writes under the users row lock. The step-up binds the method,
 * and for a wallet the address (`wallet_siwe:<address>`).
 */
export function createSigninMethodsRouter(
  sql: Sql,
  stepUp: SecurityStepUp,
  options: { wallet: WalletConfig; social?: SocialSignin | undefined },
) {
  const requireLink = (principal: Parameters<SecurityStepUp['require']>[0], method: string, request: string, approval?: string | null) =>
    stepUp.require(principal, 'identity.step_up.link_method', { method, clientRequestId: request }, approval);
  return router({
    signinMethods: scopedProcedure('identity:read')
      .input(z.object({}).strict().optional())
      .output(methodsOutput)
      .query(async ({ ctx }) => {
        try {
          return await listSigninMethods(sql, ctx.principal.userId);
        } catch (err) {
          return signinMethodTrpcError(err);
        }
      }),

    /** The message a wallet signs to be linked: single use, for this account and this wallet only. */
    walletLinkChallenge: scopedProcedure('identity:write')
      .input(walletChallengeInput)
      .output(walletChallengeOutput)
      .mutation(async ({ ctx, input }) => {
        try {
          return await startWalletChallenge(sql, options.wallet, {
            purpose: 'link',
            address: walletAddress(input.address),
            chainId: input.chainId,
            userId: ctx.principal.userId,
            ...(input.origin ? { origin: input.origin } : {}),
          });
        } catch (err) {
          return signinMethodTrpcError(err);
        }
      }),

    linkSigninMethod: scopedProcedure('identity:write')
      .input(
        z
          .object({
            method: z.string().min(1).max(64),
            clientRequestId,
            stepUpApprovalId,
            password: z.string().max(1024).optional(),
            phone: phone.optional(),
            wallet: walletAnswer.optional(),
          })
          .strict(),
      )
      .output(methodsOutput)
      .mutation(async ({ ctx, input }): Promise<SigninMethods> => {
        try {
          const method = parseSigninMethod(input.method);
          const userId = ctx.principal.userId;
          if (method === 'sms_code') {
            // A number is checked for shape, then refused: texted codes need the outside provider. Nothing is stored.
            if (!input.phone) throw new SigninMethodError('identity.method_invalid');
            throw new SigninMethodError(VENDOR_SMS, 'Texted codes need an outside SMS provider, which is not connected');
          }
          if (method === 'password') {
            if (input.password === undefined) throw new SigninMethodError('identity.method_invalid');
            await checkLinkPassword(sql, userId, input.password);
            await requireLink(ctx.principal, method, input.clientRequestId, input.stepUpApprovalId);
            return await linkPassword(sql, userId, input.password);
          }
          if (method === 'email_code') {
            await checkLinkEmailCode(sql, userId);
            await requireLink(ctx.principal, method, input.clientRequestId, input.stepUpApprovalId);
            return await linkEmailCode(sql, userId);
          }
          // A provider account links only through `linkProviderComplete`, after the provider's own sign-in.
          if (method.startsWith('social:') || !input.wallet) throw new SigninMethodError('identity.method_invalid');
          const address = await checkLinkWallet(sql, options.wallet, userId, input.wallet);
          if (method !== `wallet_siwe:${address}`) throw new SigninMethodError('identity.wallet_challenge_invalid');
          await requireLink(ctx.principal, method, input.clientRequestId, input.stepUpApprovalId);
          return await linkWallet(sql, options.wallet, userId, input.wallet);
        } catch (err) {
          return signinMethodTrpcError(err);
        }
      }),

    unlinkSigninMethod: scopedProcedure('identity:write')
      .input(z.object({ method: z.string().min(1).max(64), clientRequestId, stepUpApprovalId }).strict())
      .output(methodsOutput)
      .mutation(async ({ ctx, input }) => {
        try {
          const method = parseSigninMethod(input.method);
          if (method === 'sms_code') throw new SigninMethodError('identity.method_not_linked');
          // The last way in is refused before the step-up, so it spends no confirmation.
          await checkUnlink(sql, ctx.principal.userId, method);
          await stepUp.require(
            ctx.principal,
            'identity.step_up.unlink_method',
            { method, clientRequestId: input.clientRequestId },
            input.stepUpApprovalId,
          );
          return await unlinkSigninMethod(sql, ctx.principal.userId, method);
        } catch (err) {
          return signinMethodTrpcError(err);
        }
      }),

    /** Link a provider account. With no provider registered this answers the allowlisted `idp.social`. */
    linkProviderStart: scopedProcedure('identity:write')
      .input(z.object({ provider: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict())
      .output(z.object({ provider: z.string(), authorizationUrl: z.string(), expiresAt: z.string() }).strict())
      .mutation(async ({ ctx, input }) => {
        try {
          if (!options.social) {
            throw new SocialError(
              'Sign-in with another account provider needs an outside provider. It is switched off in this build.',
              'idp.social',
            );
          }
          const started = await options.social.start({ provider: input.provider, purpose: 'link', userId: ctx.principal.userId });
          return { provider: started.provider, authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt.toISOString() };
        } catch (err) {
          return signinMethodTrpcError(err);
        }
      }),

    /**
     * Link a provider account, back from the provider: the security step-up first (it binds `social:<provider>`), so a
     * missing confirmation leaves the state unspent; then the state, which must be one this account started for linking.
     */
    linkProviderComplete: scopedProcedure('identity:write')
      .input(
        z
          .object({
            provider: z.string().regex(/^[a-z0-9-]{1,32}$/),
            state: z.string().min(1).max(200),
            code: z.string().min(1).max(2000),
            clientRequestId,
            stepUpApprovalId,
          })
          .strict(),
      )
      .output(methodsOutput)
      .mutation(async ({ ctx, input }): Promise<SigninMethods> => {
        try {
          if (!options.social) {
            throw new SocialError(
              'Sign-in with another account provider needs an outside provider. It is switched off in this build.',
              'idp.social',
            );
          }
          const userId = ctx.principal.userId;
          await requireLink(ctx.principal, `social:${input.provider}`, input.clientRequestId, input.stepUpApprovalId);
          const done = await options.social.complete({ provider: input.provider, purpose: 'link', state: input.state, code: input.code });
          if (done.userId !== userId) throw new SocialError('That sign-in link is not valid', 'identity.social_flow_invalid');
          await options.social.link(userId, input.provider, done.profile);
          return await listSigninMethods(sql, userId);
        } catch (err) {
          return signinMethodTrpcError(err);
        }
      }),
  });
}
