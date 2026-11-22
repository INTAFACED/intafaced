import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { kycHistoryOutputSchema, kycReasonCodeSchema } from './identity-kyc-cases.js';
import {
  kycSelfieDecideInputSchema,
  kycSelfieForComplianceSchema,
  kycSelfieHandoffSchema,
  kycSelfieReadSchema,
  kycSelfieSchema,
  kycSelfieSubmitInputSchema,
} from './identity-kyc-selfie.js';
import { kycPoaReadInputSchema, kycPoaReadSchema, kycPoaSubmissionSchema, kycPoaSubmitInputSchema } from './identity-kyc-poa.js';
import { kycCapabilitiesOutputSchema, kycCapabilitySchema } from './identity-kyc-capabilities.js';
import { kycAttemptsSchema } from './identity-kyc-attempts.js';
import { kycLevelsDescribeOutputSchema } from './identity-kyc-levels.js';
import { kycTradingChecksResultSchema, kycTradingChecksRunInputSchema, kycTradingChecksSchema } from './identity-kyc-trading-checks.js';
import { kycRecordOutput, submittableTier } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `kyc.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** Compliance reads any person's cases, the same shape the person sees. An unknown user is `auth.not_found`. */
export const IDENTITY_KYC_HISTORY_FOR = defineProcedure({
  ...base,
  name: 'identity.kyc.historyFor',
  kind: 'query',
  path: 'kyc.historyFor',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({ userId: z.string().guid(), limit: z.number().int().min(1).max(200) }),
  output: kycHistoryOutputSchema,
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_KYC_SELFIE_LIST_FOR = defineProcedure({
  ...base,
  name: 'identity.kyc.selfie.listFor',
  kind: 'query',
  path: 'kyc.selfie.listFor',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({ userId: z.string().uuid(), limit: z.number().int().min(1).max(50) }).strict(),
  output: z.object({ selfies: z.array(kycSelfieForComplianceSchema) }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The person's decision after comparing the selfie (its frame opened through `getDocument`) with the ID photo.
 * Same class as a review: MFA, never an agent, never the reviewer's own, and the four-eyes approval binds the
 * selfie and the decision. Checked before the approval is spent.
 */
export const IDENTITY_KYC_SELFIE_DECIDE = defineProcedure({
  ...base,
  name: 'identity.kyc.selfie.decide',
  kind: 'mutation',
  path: 'kyc.selfie.decide',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: kycSelfieDecideInputSchema,
  output: kycSelfieForComplianceSchema,
  samples: [
    { verdict: 'accept', input: { selfieId: '11111111-1111-4111-8111-111111111111', decision: 'accepted' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The review queue. Without it `approve` needs a record id nobody can find. Limit required — omit never invents 50. */
export const IDENTITY_KYC_PENDING = defineProcedure({
  ...base,
  name: 'identity.kyc.pending',
  kind: 'query',
  path: 'kyc.pending',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.array(kycRecordOutput),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The other half of a review. Grants nothing. Dual-control matches approve. A reject names a code from the owner's
 * reason list (I-kyc-compliance-01), checked before the approval is spent: unset refuses `kyc.reason_codes_unset`,
 * a code not listed `kyc.reason_code_unknown`. The case records it with the reviewer's note, which the customer
 * sees only when `noteVisible`, and `kycRejected` goes out after commit. A retry with the same code returns the
 * stored result; another code on a rejected case refuses `kyc.case_state`.
 */
export const IDENTITY_KYC_REJECT = defineProcedure({
  ...base,
  name: 'identity.kyc.reject',
  kind: 'mutation',
  path: 'kyc.reject',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({
    recordId: z.string().guid(),
    reasonCode: kycReasonCodeSchema,
    customerNote: z.string().trim().min(1).max(500).nullish(),
    noteVisible: z.boolean().optional(),
    confirmOperatorId: z.string().max(128).nullish(),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  }),
  output: kycRecordOutput,
  samples: [
    { verdict: 'accept', input: { recordId: '11111111-1111-4111-8111-111111111111', reasonCode: 'abc' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_KYC_PROOF_OF_ADDRESS_LIST_FOR = defineProcedure({
  ...base,
  name: 'identity.kyc.proofOfAddress.listFor',
  kind: 'query',
  path: 'kyc.proofOfAddress.listFor',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({ userId: z.string().uuid(), limit: z.number().int().min(1).max(50) }).strict(),
  output: z.object({ submissions: z.array(kycPoaSubmissionSchema) }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Compliance reads any person's capabilities. An unknown user is `auth.not_found`. */
export const IDENTITY_KYC_CAPABILITIES_GET_FOR = defineProcedure({
  ...base,
  name: 'identity.kyc.capabilities.getFor',
  kind: 'query',
  path: 'kyc.capabilities.getFor',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({ userId: z.string().guid() }),
  output: kycCapabilitiesOutputSchema,
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Switch one capability off for good. The only state compliance sets here is `inactive`; levels turn
 * capabilities on. The code comes from the owner's capability reason list (`IDENTITY_KYC_CAPABILITY_REASONS`;
 * unset refuses `kyc.reason_codes_unset`), and the
 * four-eyes approval binds the person, the capability and the code. Checked before the approval is spent.
 */
export const IDENTITY_KYC_CAPABILITIES_SET = defineProcedure({
  ...base,
  name: 'identity.kyc.capabilities.set',
  kind: 'mutation',
  path: 'kyc.capabilities.set',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({
    userId: z.string().guid(),
    capability: kycCapabilitySchema,
    state: z.literal('inactive'),
    reasonCode: kycReasonCodeSchema,
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  }),
  output: kycCapabilitiesOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: { userId: '11111111-1111-4111-8111-111111111111', capability: 'custody_crypto', state: 'inactive', reasonCode: 'abc' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * A user asks to be verified. Grants nothing.
 *
 * There is no `userId` input, so there is no way to submit on somebody
 * else's behalf — the identity comes from the token and cannot be
 * overridden. An ownership check would be a check on a value the caller
 * supplies; not accepting the value is stronger.
 */
export const IDENTITY_KYC_SUBMIT = defineProcedure({
  ...base,
  name: 'identity.kyc.submit',
  kind: 'mutation',
  path: 'kyc.submit',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({
    tier: submittableTier,
    /** ISO-3166 alpha-2. The matrix is keyed on it, so it is not free text. */
    jurisdiction: z.string().length(2).toUpperCase(),
    /**
     * Deliberately absent: a client-supplied `providerRef` was a free-text
     * side-channel into `kyc_records.provider_ref` (§10 PII isolation —
     * "pointer never holds a name or DOB"). Opaque refs are minted by the
     * encrypted document store (or operator tools) when that store lands;
     * user submit only opens a pending row.
     */
  }),
  output: kycRecordOutput,
  samples: [
    { verdict: 'accept', input: { tier: 'basic', jurisdiction: 'en' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_KYC_ATTEMPTS_READ = defineProcedure({
  ...base,
  name: 'identity.kyc.attempts.read',
  kind: 'query',
  path: 'kyc.attempts.read',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: kycAttemptsSchema,
  samples: [{ verdict: 'accept' }],
});

/** The caller's own capabilities. No `userId` input. */
export const IDENTITY_KYC_CAPABILITIES_GET = defineProcedure({
  ...base,
  name: 'identity.kyc.capabilities.get',
  kind: 'query',
  path: 'kyc.capabilities.get',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: kycCapabilitiesOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/**
 * The caller's own verification cases, newest first, with each one's history and, for a reject, the owner's reason
 * and fix guidance (I-kyc-compliance-01). No `userId` input: nobody reads another person's cases through this.
 */
export const IDENTITY_KYC_HISTORY = defineProcedure({
  ...base,
  name: 'identity.kyc.history',
  kind: 'query',
  path: 'kyc.history',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: kycHistoryOutputSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_KYC_LEVELS_DESCRIBE = defineProcedure({
  ...base,
  name: 'identity.kyc.levels.describe',
  kind: 'query',
  path: 'kyc.levels.describe',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: kycLevelsDescribeOutputSchema,
  outputChecks: { kyc_levels_describe_output_holds: { at: ['output', 'output'], says: 'one current rung; levels are in ladder order' } },
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_KYC_PROOF_OF_ADDRESS_READ = defineProcedure({
  ...base,
  name: 'identity.kyc.proofOfAddress.read',
  kind: 'query',
  path: 'kyc.proofOfAddress.read',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: kycPoaReadInputSchema,
  output: kycPoaReadSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_KYC_PROOF_OF_ADDRESS_SUBMIT = defineProcedure({
  ...base,
  name: 'identity.kyc.proofOfAddress.submit',
  kind: 'mutation',
  path: 'kyc.proofOfAddress.submit',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: kycPoaSubmitInputSchema,
  output: kycPoaSubmissionSchema,
  samples: [
    { verdict: 'accept', input: { type: 'abc', country: 'US', issuedOn: '2026-01-01', contentType: 'USDC', bytesBase64: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_KYC_SELFIE_READ = defineProcedure({
  ...base,
  name: 'identity.kyc.selfie.read',
  kind: 'query',
  path: 'kyc.selfie.read',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: kycSelfieReadSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_KYC_SELFIE_SUBMIT = defineProcedure({
  ...base,
  name: 'identity.kyc.selfie.submit',
  kind: 'mutation',
  path: 'kyc.selfie.submit',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: kycSelfieSubmitInputSchema,
  output: kycSelfieSchema,
  samples: [
    { verdict: 'accept', input: { contentType: 'USDC', bytesBase64: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_KYC_SELFIE_HANDOFF_START = defineProcedure({
  ...base,
  name: 'identity.kyc.selfie.handoff.start',
  kind: 'mutation',
  path: 'kyc.selfie.handoff.start',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: NO_INPUT,
  output: kycSelfieHandoffSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_KYC_TRADING_CHECKS_READ = defineProcedure({
  ...base,
  name: 'identity.kyc.tradingChecks.read',
  kind: 'query',
  path: 'kyc.tradingChecks.read',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: kycTradingChecksSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_KYC_TRADING_CHECKS_RUN = defineProcedure({
  ...base,
  name: 'identity.kyc.tradingChecks.run',
  kind: 'mutation',
  path: 'kyc.tradingChecks.run',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: kycTradingChecksRunInputSchema,
  output: kycTradingChecksResultSchema,
  samples: [
    { verdict: 'accept', input: { legalName: 'USDC', country: 'US', confirmed: true } },
    { verdict: 'refuse', input: 42 },
  ],
});
