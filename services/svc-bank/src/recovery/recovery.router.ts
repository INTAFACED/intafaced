import { z } from 'zod';
import { RECOVERY_CLAIM_SIGNATURES_MAX, recoveryClaimSignatureSchema, router, scopedProcedure } from '@intafaced/contracts';
import { FOUNDER_DESK_SCOPES } from '@intafaced/auth';
import { formatAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import type { RecoveryAccount, RecoveryClaimRecord, RecoverySweepRecord } from './recovery-claims.js';

/**
 * `bank.recovery.*` (RC-identity-08, J-identity-05 #7): the heir's claim room. Each door acts for the signed-in person
 * only: identity is asked about the caller's own id, never an id from input. An API key or a sub-account refuses
 * `bank.recovery_delegated`, and staff (`admin:*` and every founder desk scope, such as `support:ops`, `market:ops` and
 * `campaigns:ops`) refuse `bank.recovery_staff_forbidden`,
 * so no one but the named heir, holding the owner's keys, can move a dead owner's balances.
 */

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;
type RecoveryCaller = {
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly kid?: string | undefined;
  readonly sub_account?: string | undefined;
};

/** Every staff desk scope a founder session may hold, and any `admin:*`: one list, so a new desk scope is refused too. */
const STAFF_SCOPES: ReadonlySet<string> = new Set(FOUNDER_DESK_SCOPES);

/** The heir at their own keyboard, never a delegate and never staff. */
export function recoveryHeir(principal: RecoveryCaller): string {
  if (principal.kid || principal.sub_account) {
    throw new BankError('Sign in as yourself to claim an account [bank.recovery_delegated]', 'bank.recovery_delegated');
  }
  if (principal.scopes.some((s) => s.startsWith('admin:') || STAFF_SCOPES.has(s))) {
    throw new BankError('Staff do not claim or move customer balances [bank.recovery_staff_forbidden]', 'bank.recovery_staff_forbidden');
  }
  return principal.userId;
}

const account = z.object({
  ownerType: z.enum(['user', 'subaccount']),
  assetId: z.string(),
  kind: z.string(),
  spaceId: z.string().nullable(),
  spaceName: z.string().nullable(),
  amount: z.string(),
});
const claim = z.object({
  claimId: z.string(),
  status: z.enum(['open', 'executed']),
  round: z.number().int(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
});
const sweep = z.object({
  round: z.number().int(),
  ownerType: z.enum(['user', 'subaccount']),
  /** The named space the value came from, or null for the owner's main account. */
  spaceId: z.string().nullable(),
  assetId: z.string(),
  amount: z.string(),
  status: z.enum(['pending', 'posted', 'refused']),
  ledgerTxId: z.string().nullable(),
  refusalCode: z.string().nullable(),
});

const accountOut = (a: RecoveryAccount) => ({
  ownerType: a.account.ownerType as 'user' | 'subaccount',
  assetId: a.account.assetId,
  kind: a.account.kind,
  spaceId: a.spaceId,
  spaceName: a.spaceName,
  amount: formatAmount(a.amount),
});
const claimOut = (c: RecoveryClaimRecord) => ({
  claimId: c.id,
  status: c.status,
  round: c.round,
  createdAt: c.createdAt.toISOString(),
  executedAt: c.executedAt?.toISOString() ?? null,
});
const sweepOut = (s: RecoverySweepRecord) => ({
  round: s.round,
  ownerType: s.fromOwnerType,
  spaceId: s.fromOwnerType === 'subaccount' ? s.fromOwnerId : null,
  assetId: s.assetId,
  amount: formatAmount(s.amount),
  status: s.status,
  ledgerTxId: s.ledgerTxId,
  refusalCode: s.refusalCode,
});

export function createRecoveryRouter(bank: BankServices, guard: Guard) {
  return router({
    /** The accounts the caller may claim as heir, each with the balances a sweep moves now and what blocks one. */
    estates: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          estates: z.array(
            z.object({
              userId: z.string(),
              handle: z.string(),
              threshold: z.number().int(),
              liveKeys: z.number().int(),
              claim: claim.nullable(),
              sweepable: z.array(account),
              held: z.array(account),
              blockers: z.array(account),
            }),
          ),
        }),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const heir = recoveryHeir(ctx.principal);
          const estates = await bank.recovery.estates(heir);
          return {
            estates: estates.map((e) => ({
              userId: e.userId,
              handle: e.handle,
              threshold: e.threshold,
              liveKeys: e.liveKeys,
              claim: e.claim ? claimOut(e.claim) : null,
              sweepable: e.sweepable.map(accountOut),
              held: e.held.map(accountOut),
              blockers: e.blockers.map(accountOut),
            })),
          };
        }),
      ),

    claims: router({
      /** Open the claim on one listed account, or answer the open one again, with the text each key signs. Moves nothing. */
      open: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ ownerUserId: z.string().guid() }))
        .output(
          claim.extend({
            ownerUserId: z.string(),
            handle: z.string(),
            threshold: z.number().int(),
            liveKeys: z.number().int(),
            message: z.string(),
          }),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const opened = await bank.recovery.open(recoveryHeir(ctx.principal), input.ownerUserId);
            return {
              ...claimOut(opened.claim),
              ownerUserId: opened.claim.ownerUserId,
              handle: opened.handle,
              threshold: opened.threshold,
              liveKeys: opened.liveKeys,
              message: opened.message,
            };
          }),
        ),

      /**
       * Sweep the owner's free balances into the caller's main account once identity accepts these signatures. Asking
       * again resumes an unfinished round with the same keys, or sweeps what arrived since in the next round.
       */
      execute: scopedProcedure('bank:write', { module: 'bank' })
        .input(
          z.object({
            claimId: z.string().guid(),
            signatures: z.array(recoveryClaimSignatureSchema).min(1).max(RECOVERY_CLAIM_SIGNATURES_MAX),
          }),
        )
        .output(z.object({ claim, round: z.number().int().nullable(), sweeps: z.array(sweep) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const done = await bank.recovery.execute(recoveryHeir(ctx.principal), input.claimId, input.signatures);
            return { claim: claimOut(done.claim), round: done.round, sweeps: done.sweeps.map(sweepOut) };
          }),
        ),
    }),
  });
}
