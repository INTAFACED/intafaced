import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  sandboxCreateInputSchema,
  sandboxCreateOutputSchema,
  sandboxFundInputSchema,
  sandboxFundOutputSchema,
  sandboxGetInputSchema,
  sandboxGetOutputSchema,
  sandboxKeyCreateInputSchema,
  sandboxKeyCreateOutputSchema,
  sandboxListOutputSchema,
} from '@intafaced/contracts/developer-sandboxes';
import { optionalFactorProof } from './auth/api-key-fresh-factor.js';
import { DeveloperKeyError } from './auth/developer-keys.js';
import { DEVELOPER_KEY_STATUS } from './developer-keys-router.js';
import {
  createSandbox,
  createSandboxKey,
  DeveloperSandboxError,
  fundSandbox,
  getSandbox,
  listSandboxes,
  type DeveloperSandboxesDeps,
} from './auth/developer-sandboxes.js';
import { MintApiKeyPasskeyError } from './auth/mint-api-key-passkey.js';
import { userCopy } from './user-copy.js';

const SANDBOX_STATUS: Record<DeveloperSandboxError['code'], TRPCError['code']> = {
  'identity.sandbox_name_invalid': 'BAD_REQUEST',
  'identity.sandbox_name_taken': 'CONFLICT',
  'identity.sandbox_cap_unset': 'PRECONDITION_FAILED',
  'identity.sandbox_cap_reached': 'PRECONDITION_FAILED',
  'identity.sandbox_request_conflict': 'CONFLICT',
  'identity.sandbox_not_found': 'NOT_FOUND',
  'identity.sandbox_funds_unset': 'PRECONDITION_FAILED',
  'env.scope_not_sandboxable': 'FORBIDDEN',
};

function refused(err: unknown): never {
  if (err instanceof DeveloperSandboxError) {
    throw new TRPCError({ code: SANDBOX_STATUS[err.code], message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  if (err instanceof DeveloperKeyError) {
    throw new TRPCError({ code: DEVELOPER_KEY_STATUS[err.code], message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
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
 * The developer sandbox doors (`developerSandboxes.*`, DV-sandbox-01). Only a person signed in on a device may use
 * them: an API key or a sub-account is refused before anything is read.
 */
export function createDeveloperSandboxesRouter(deps: DeveloperSandboxesDeps) {
  const guarded = async <T>(principal: { kid?: string | undefined; sub_account?: string | undefined }, run: () => Promise<T>) => {
    assertSignedInPerson(principal);
    try {
      return await run();
    } catch (err) {
      refused(err);
    }
  };
  return router({
    developerSandboxes: router({
      create: scopedProcedure('identity:write')
        .input(sandboxCreateInputSchema)
        .output(sandboxCreateOutputSchema)
        .mutation(({ ctx, input }) => guarded(ctx.principal, () => createSandbox(deps, ctx.principal, input))),

      list: scopedProcedure('identity:read')
        .output(sandboxListOutputSchema)
        .query(({ ctx }) => guarded(ctx.principal, () => listSandboxes(deps, ctx.principal.userId))),

      get: scopedProcedure('identity:read')
        .input(sandboxGetInputSchema)
        .output(sandboxGetOutputSchema)
        .query(({ ctx, input }) => guarded(ctx.principal, () => getSandbox(deps, ctx.principal.userId, input.sandboxId))),

      createKey: scopedProcedure('identity:write')
        .input(sandboxKeyCreateInputSchema.extend({ factorProof: optionalFactorProof }))
        .output(sandboxKeyCreateOutputSchema)
        .mutation(({ ctx, input }) => guarded(ctx.principal, () => createSandboxKey(deps, ctx.principal, input))),

      fund: scopedProcedure('identity:write')
        .input(sandboxFundInputSchema)
        .output(sandboxFundOutputSchema)
        .mutation(({ ctx, input }) => guarded(ctx.principal, () => fundSandbox(deps, ctx.principal.userId, input.sandboxId))),
    }),
  });
}
