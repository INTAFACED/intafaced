/**
 * A fresh second factor for API-key actions that mint, widen, rotate or reveal.
 *
 * A live session alone is not enough to create or loosen a key: the factor must
 * be a TOTP code, a passkey assertion (over the `auth.stepUpOptions` challenge)
 * or a proof row from the last five minutes. Revoking a key never needs one, so
 * the owner can always switch a key off. API-key and sub-account callers can
 * never take these actions.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import { TRPCError } from '@intafaced/contracts';
import { AuthError, type ApiKeyActionScope, type PayStepUpFactorProof } from './auth-service.js';
import { userCopy } from '../user-copy.js';
import { inTransaction } from './api-key-request-sign.js';

export const factorProofSchema = z.union([
  z.object({ totpCode: z.string().regex(/^\d{6}$/) }).strict(),
  z
    .object({
      webauthn: z.object({
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
      }),
    })
    .strict(),
  z.object({ proofId: z.string().guid() }).strict(),
]);

/** Optional on the wire so a missing proof is the typed refusal, not a parse error. */
export const optionalFactorProof = factorProofSchema.optional();

export interface ApiKeyFactorGate {
  withApiKeyAction<T>(
    input: {
      userId: string;
      sessionId: string;
      proof?: PayStepUpFactorProof | undefined;
      action: string;
      keyId?: string | undefined;
      scopes?: readonly string[] | undefined;
    },
    run: (scope: ApiKeyActionScope) => Promise<T>,
  ): Promise<T>;
}

type Caller = {
  readonly userId: string;
  readonly sid: string;
  readonly kid?: string | undefined;
  readonly sub_account?: string | undefined;
};

function toGateError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof AuthError) {
    const message = userCopy(err.code);
    switch (err.code) {
      case 'auth.step_up_required':
      case 'auth.step_up_expired':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: `${message} [${err.code}]`, cause: err });
      case 'auth.mfa_invalid':
      case 'auth.webauthn_invalid':
      case 'auth.session_invalid':
        return new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
      case 'auth.too_many_attempts':
        return new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: err });
      default:
        return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    }
  }
  throw err;
}

/**
 * Run `run` only for a person with a fresh second factor, in one transaction with its audit row.
 * Nothing changes on a refusal. Errors thrown by `run` itself pass through untouched for the
 * caller's own mapping; only the gate's own refusals become TRPCErrors here.
 */
export async function guardedApiKeyAction<T>(
  gate: ApiKeyFactorGate,
  caller: Caller,
  proof: PayStepUpFactorProof | undefined,
  action: { action: string; keyId?: string; scopes?: readonly string[] },
  run: (scope: ApiKeyActionScope) => Promise<T>,
): Promise<T> {
  if (caller.kid || caller.sub_account) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'API keys and sub-accounts cannot create or change keys' });
  }
  let failure: { error: unknown } | undefined;
  try {
    return await gate.withApiKeyAction({ userId: caller.userId, sessionId: caller.sid, proof, ...action }, async (scope) => {
      try {
        return await run(scope);
      } catch (error) {
        failure = { error };
        throw error;
      }
    });
  } catch (err) {
    if (failure) throw failure.error;
    throw toGateError(err);
  }
}

/**
 * True when the change only narrows an allowlist: the new list is non-empty and
 * every entry was already allowed (or the list was unrestricted before). An empty
 * list is unrestricted, so reaching it, or adding an entry, is a widening.
 */
export function narrowsAllowlist(current: readonly string[], next: readonly string[], norm: (v: string) => string = (v) => v): boolean {
  if (next.length === 0) return false;
  if (current.length === 0) return true;
  const allowed = new Set(current.map(norm));
  return next.every((entry) => allowed.has(norm(entry)));
}

/**
 * Change one key so the narrow-or-widen decision and the write share one transaction.
 *
 * The key row is locked (`readLocked` must `SELECT ... FOR UPDATE`) and `narrows` decides from the
 * locked value, so a concurrent change cannot slip between the read and the write. A change that
 * narrows commits on its own. Anything else, including a change that only turned into a widening
 * because another request got there first, takes the guarded path: the fresh factor is consumed and
 * audited in the same transaction as the write, and the row is locked (and `readLocked`'s own
 * refusals checked) again there.
 */
export async function narrowOrGuardedChange<L, T>(args: {
  sql: Sql;
  gate: ApiKeyFactorGate;
  caller: Caller;
  proof: PayStepUpFactorProof | undefined;
  action: { action: string; keyId: string };
  readLocked: (tx: Sql) => Promise<L>;
  narrows: (locked: L) => boolean;
  write: (tx: Sql) => Promise<T>;
}): Promise<T> {
  if (args.caller.kid || args.caller.sub_account) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'API keys and sub-accounts cannot create or change keys' });
  }
  const narrowed = await inTransaction(args.sql, async (tx) => {
    if (!args.narrows(await args.readLocked(tx))) return undefined;
    return { value: await args.write(tx) };
  });
  if (narrowed) return narrowed.value;
  return guardedApiKeyAction(args.gate, args.caller, args.proof, args.action, async (scope) => {
    await args.readLocked(scope.tx);
    return args.write(scope.tx);
  });
}

/** An allowlist change through `narrowOrGuardedChange`: it narrows when `narrowsAllowlist` says so. */
export async function narrowOrGuardedAllowlistChange<T>(args: {
  sql: Sql;
  gate: ApiKeyFactorGate;
  caller: Caller;
  proof: PayStepUpFactorProof | undefined;
  action: { action: string; keyId: string };
  readLocked: (tx: Sql) => Promise<string[]>;
  nextFrom: (current: string[]) => string[];
  norm?: (v: string) => string;
  write: (tx: Sql) => Promise<T>;
}): Promise<T> {
  const { nextFrom, norm, ...rest } = args;
  return narrowOrGuardedChange({ ...rest, narrows: (current: string[]) => narrowsAllowlist(current, nextFrom(current), norm) });
}
