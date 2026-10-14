import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import type { ApiKeyMinter } from './auth/mint-api-key-ip.js';
import { PlaceDoorError } from './auth/place-door.js';
import { mintApiKeyAfterRecoveryCode, RedeemRecoveryMintError } from './auth/redeem-recovery-mint.js';
import { RedeemRecoveryRotateError, rotateApiKeyAfterRecoveryCode } from './auth/redeem-recovery-rotate.js';
import { RotateApiKeyError } from './auth/rotate-api-key.js';

/**
 * Recovery-code-gated API key mint and rotate.
 *
 * Top-level (not nested under apiKeys) so mergeRouters cannot replace
 * apiKeys.exchange. `identity:write`, same as the plain `apiKeys.create` and
 * `rotateApiKey`, and it adds a door rather than removing one: the caller must
 * ALSO present one unspent recovery code, which is spent atomically and counted
 * against the account's `mfa` attempt budget (auth/recovery-redeem.ts).
 *
 * Who may call. A person in a live session of their own account: the user and
 * the session both come from the verified token, never from the body. An API key
 * (`kid`) or sub-account principal is refused, because a leaked key must not be
 * able to spend the owner's recovery codes or mint more keys.
 *
 * NOT ROUTED on purpose (see the PR description): the session, passkey-enrol,
 * single-key revoke, revoke-all-keys and revoke-other-sessions variants.
 */
const recoveryCode = z.string().regex(/^[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5}$/, 'recovery code looks like XXXXX-XXXXX');

type Gate = { kid?: string | undefined; sub_account?: string | undefined };

function assertPersonInSession(principal: Gate): void {
  assertDelegateCannotGrant(principal.kid);
  if (principal.sub_account) {
    throw new AuthError('A sub-account cannot spend a recovery code', 'auth.delegate_cannot_grant');
  }
}

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof AuthError) {
    if (err.code === 'auth.too_many_attempts') throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
    if (err.code === 'auth.delegate_cannot_grant') throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  }
  if (err instanceof PlaceDoorError) throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  if (err instanceof RedeemRecoveryMintError || err instanceof RedeemRecoveryRotateError) {
    switch (err.code) {
      case 'auth.recovery_missing':
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
      case 'auth.recovery_spent':
      case 'auth.recovery_invalid':
        // One shape for both: a caller must not learn whether the account has codes left.
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid recovery code', cause: err });
      case 'auth.not_found':
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
  }
  if (err instanceof RotateApiKeyError) throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });
}

export function createRecoveryRedeemRouter(sql: Sql, minter: ApiKeyMinter) {
  return router({
    mintApiKeyWithRecoveryCode: scopedProcedure('identity:write')
      .input(
        z.object({
          recoveryCode,
          name: z.string().min(1).max(64),
          scopes: z.array(z.string()).min(1),
          domainWhitelist: z.array(z.string()).optional(),
          mode: z.enum(['live', 'sandbox']).optional(),
        }),
      )
      .output(z.object({ id: z.string(), key: z.string(), prefix: z.string(), mode: z.enum(['live', 'sandbox']) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertPersonInSession(ctx.principal);
          const { recoveryCode: code, ...key } = input;
          const minted = await mintApiKeyAfterRecoveryCode(minter, sql, {
            ...key,
            userId: ctx.principal.userId,
            sessionId: ctx.principal.sid,
            code,
            grantorScopes: ctx.principal.scopes,
            grantorKid: ctx.principal.kid,
          });
          return { id: minted.id, key: minted.key, prefix: minted.prefix, mode: minted.mode };
        } catch (err) {
          return toTrpc(err);
        }
      }),

    rotateApiKeyWithRecoveryCode: scopedProcedure('identity:write')
      .input(z.object({ recoveryCode, keyId: z.string().uuid() }))
      .output(
        z.object({
          id: z.string(),
          key: z.string(),
          prefix: z.string(),
          mode: z.enum(['live', 'sandbox']),
          revokedKeyId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertPersonInSession(ctx.principal);
          const rotated = await rotateApiKeyAfterRecoveryCode(minter, sql, {
            userId: ctx.principal.userId,
            sessionId: ctx.principal.sid,
            keyId: input.keyId,
            code: input.recoveryCode,
            grantorScopes: ctx.principal.scopes,
            grantorKid: ctx.principal.kid,
          });
          return { id: rotated.id, key: rotated.key, prefix: rotated.prefix, mode: rotated.mode, revokedKeyId: rotated.revokedKeyId };
        } catch (err) {
          return toTrpc(err);
        }
      }),
  });
}
