import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
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
} from '@intafaced/contracts/api-keys';
import { optionalFactorProof } from './auth/api-key-fresh-factor.js';
import {
  createDeveloperKey,
  describeKeyScopes,
  DeveloperKeyError,
  getDeveloperKey,
  listDeveloperKeys,
  revokeDeveloperKey,
  setDeveloperKeyExpiry,
  type DeveloperKeysDeps,
} from './auth/developer-keys.js';
import { MintApiKeyPasskeyError } from './auth/mint-api-key-passkey.js';
import { userCopy } from './user-copy.js';

const STATUS: Record<DeveloperKeyError['code'], TRPCError['code']> = {
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
  'identity.key_not_found': 'NOT_FOUND',
  'identity.key_not_live': 'PRECONDITION_FAILED',
  'identity.key_revoke_reason_invalid': 'BAD_REQUEST',
};

function refused(err: unknown): never {
  if (err instanceof DeveloperKeyError) {
    throw new TRPCError({ code: STATUS[err.code], message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  // Only an account with a verified passkey may hold a key (the live service's mint rule).
  if (err instanceof MintApiKeyPasskeyError && err.code !== 'auth.not_found') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  throw err;
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
            return await revokeDeveloperKey(deps, ctx.principal.userId, input);
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

      scopes: scopedProcedure('identity:read')
        .output(apiKeyScopesOutputSchema)
        .query(({ ctx }) => {
          assertSignedInPerson(ctx.principal);
          return { scopes: describeKeyScopes(ctx.principal.scopes) };
        }),
    }),
  });
}
