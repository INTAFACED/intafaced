import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { assetIdSchema } from './asset-id.js';
import { recoveryClaimSignatureSchema, RECOVERY_CLAIM_SIGNATURES_MAX } from './identity-recovery.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `recovery.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const claim = z.object({
  claimId: z.string(),
  status: z.enum(['open', 'executed']),
  round: z.number().int(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
});

export const account = z.object({
  ownerType: z.enum(['user', 'subaccount']),
  assetId: assetIdSchema,
  kind: z.string(),
  spaceId: z.string().nullable(),
  spaceName: z.string().nullable(),
  amount: z.string(),
});

/** Open the claim on one listed account, or answer the open one again, with the text each key signs. Moves nothing. */
export const BANK_RECOVERY_CLAIMS_OPEN = defineProcedure({
  ...base,
  name: 'bank.recovery.claims.open',
  kind: 'mutation',
  path: 'recovery.claims.open',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ ownerUserId: z.string().guid() }),
  output: claim.extend({
    ownerUserId: z.string(),
    handle: z.string(),
    threshold: z.number().int(),
    liveKeys: z.number().int(),
    message: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { ownerUserId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The accounts the caller may claim as heir, each with the balances a sweep moves now and what blocks one. */
export const BANK_RECOVERY_ESTATES = defineProcedure({
  ...base,
  name: 'bank.recovery.estates',
  kind: 'query',
  path: 'recovery.estates',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
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
  samples: [{ verdict: 'accept' }],
});

export const sweep = z.object({
  round: z.number().int(),
  ownerType: z.enum(['user', 'subaccount']),
  /** The named space the value came from, or null for the owner's main account. */
  spaceId: z.string().nullable(),
  assetId: assetIdSchema,
  amount: z.string(),
  status: z.enum(['pending', 'posted', 'refused']),
  ledgerTxId: z.string().nullable(),
  refusalCode: z.string().nullable(),
});

/**
 * Sweep the owner's free balances into the caller's main account once identity accepts these signatures. Asking
 * again resumes an unfinished round with the same keys, or sweeps what arrived since in the next round.
 */
export const BANK_RECOVERY_CLAIMS_EXECUTE = defineProcedure({
  ...base,
  name: 'bank.recovery.claims.execute',
  kind: 'mutation',
  path: 'recovery.claims.execute',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    claimId: z.string().guid(),
    signatures: z.array(recoveryClaimSignatureSchema).min(1).max(RECOVERY_CLAIM_SIGNATURES_MAX),
  }),
  output: z.object({ claim, round: z.number().int().nullable(), sweeps: z.array(sweep) }),
  samples: [
    {
      verdict: 'accept',
      input: {
        claimId: '22222222-2222-4222-8222-222222222222',
        signatures: [
          {
            publicKey: {
              kty: 'EC',
              crv: 'P-256',
              x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            },
            signature: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
          },
        ],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
