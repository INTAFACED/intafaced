import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { destinationViewOutput, rampProgrammeOutput } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `ramps.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** What this deployment's ramp programme is — including that it is not one. */
export const BANK_RAMPS_PROGRAMME = defineProcedure({
  ...base,
  name: 'bank.ramps.programme',
  kind: 'query',
  path: 'ramps.programme',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: rampProgrammeOutput,
  samples: [{ verdict: 'accept' }],
});

/**
 * Fiat settle probe. Refuses with a typed code when no svc-pay adapter can
 * settle fiat (empty / sandbox / absent). Does not invent FX. Live partner
 * rails remain Class X — this door never claims simulated: false.
 */
export const BANK_RAMPS_FIAT_SETTLE = defineProcedure({
  ...base,
  name: 'bank.ramps.fiatSettle',
  kind: 'query',
  path: 'ramps.fiatSettle',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    canSettle: z.literal(true),
    onrampRailId: z.string(),
    offrampRailId: z.string(),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_RAMPS_DESTINATIONS_APPROVAL_CONFIRM_LINK = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.approval.confirmLink',
  kind: 'mutation',
  path: 'ramps.destinations.approval.confirmLink',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: z.object({ token: z.string().min(1).max(256) }).strict(),
  output: destinationViewOutput,
  samples: [
    { verdict: 'accept', input: { token: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The assets an address may be saved for, each with the networks it is sent on: svc-ledger's registry, filtered
 * to active assets that allow withdrawals. An empty list is the honest answer while nothing is published.
 */
export const BANK_RAMPS_DESTINATIONS_NETWORKS = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.networks',
  kind: 'query',
  path: 'ramps.destinations.networks',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(
    z
      .object({
        assetId: z.string(),
        precision: z.number().int(),
        networks: z.array(z.object({ networkId: z.string(), label: z.string() }).strict()),
        defaultNetworkId: z.string().nullable(),
      })
      .strict(),
  ),
  samples: [{ verdict: 'accept' }],
});

export const BANK_RAMPS_DESTINATIONS_LIST = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.list',
  kind: 'query',
  path: 'ramps.destinations.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(destinationViewOutput),
  samples: [{ verdict: 'accept' }],
});

/**
 * Whether money may be sent to one saved address now (W-withdraw-09), or what stands in the way first: the owner's
 * security lock (`locked`, with `lockUnlocksAt` once an unlock is asked for), an entry not held as active
 * (`blocked`), a new address not approved yet (`approval_pending`, with `approvalLinkExpiresAt` while an emailed link
 * works), no published cooling-off (`cooling_unset`) or a cooling-off still running (`cooling`, with
 * `coolingOffEndsAt`). Read-only (`bank:read`); the send path applies the same rules and refuses on its own.
 */
export const BANK_RAMPS_DESTINATIONS_READINESS = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.readiness',
  kind: 'query',
  path: 'ramps.destinations.readiness',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ destinationId: z.string().guid() }).strict(),
  output: z
    .object({
      destinationId: z.string().guid(),
      state: z.enum(['ready', 'locked', 'blocked', 'approval_pending', 'cooling_unset', 'cooling']),
      coolingOffEndsAt: z.string().nullable(),
      lockUnlocksAt: z.string().nullable(),
      approvalLinkExpiresAt: z.string().nullable(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { destinationId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_RAMPS_DESTINATIONS_APPROVAL_ON_DEVICE = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.approval.onDevice',
  kind: 'mutation',
  path: 'ramps.destinations.approval.onDevice',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: z.object({ destinationId: z.string().guid() }).strict(),
  output: destinationViewOutput,
  samples: [
    { verdict: 'accept', input: { destinationId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_RAMPS_DESTINATIONS_APPROVAL_REQUEST_MAIL = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.approval.requestMail',
  kind: 'mutation',
  path: 'ramps.destinations.approval.requestMail',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ destinationId: z.string().guid() }).strict(),
  output: z.object({ destinationId: z.string(), expiresAt: z.string() }).strict(),
  samples: [
    { verdict: 'accept', input: { destinationId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_RAMPS_DESTINATIONS_OWNERSHIP_START = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.ownership.start',
  kind: 'mutation',
  path: 'ramps.destinations.ownership.start',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ destinationId: z.string().guid() }).strict(),
  output: z.object({ proofId: z.string().guid(), destinationId: z.string().guid(), message: z.string(), expiresAt: z.string() }).strict(),
  samples: [
    { verdict: 'accept', input: { destinationId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_RAMPS_DESTINATIONS_OWNERSHIP_VERIFY = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.ownership.verify',
  kind: 'mutation',
  path: 'ramps.destinations.ownership.verify',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ proofId: z.string().guid(), signature: z.string().min(1).max(200) }).strict(),
  output: z
    .object({
      proofId: z.string().guid(),
      destinationId: z.string().guid(),
      state: z.enum(['none', 'pending', 'verified', 'expired']),
      verifiedAt: z.string().nullable(),
      validUntil: z.string().nullable(),
      offerExpiresAt: z.string().nullable(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { proofId: '11111111-1111-4111-8111-111111111111', signature: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Check an address before the confirmation step, with the rules `save` applies: `address` is `checksum_mismatch`
 * when its mixed case does not match its EIP-55 checksum (a changed character), and `lookalike` names the saved
 * entry it shows like but is not (address poisoning). With a `network`, `fraudListed` says whether the owner's fraud list
 * holds the address on that network or on every network (W-withdraw-03); without one it is false and unasked. Read-only
 * (`bank:read`); `save` enforces all three again.
 */
export const BANK_RAMPS_DESTINATIONS_CHECK = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.check',
  kind: 'query',
  path: 'ramps.destinations.check',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ ref: z.string().min(1).max(256), network: z.string().min(2).max(32).optional() }).strict(),
  output: z
    .object({
      address: z.enum(['ok', 'invalid', 'checksum_mismatch']),
      lookalike: z.object({ destinationId: z.string().guid(), label: z.string().nullable(), refMasked: z.string() }).strict().nullable(),
      fraudListed: z.boolean(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { ref: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Save an address-book entry. `trade:withdraw` (the step-up scope), like removing one: a leaked key or a
 * stolen access token must not be able to add the address that money is then sent to. The same
 * (asset, network, address, tag) again returns the stored entry. The label is unique per customer, and the
 * number of entries is the owner's `BANK_ADDRESS_BOOK_CAP` (blank refuses `bank.address_book_cap_unset`). The
 * network must be one svc-ledger's registry lists for the asset now (`bank.withdraw_network_unsupported`),
 * checked first: once an asset or network is delisted, saving that entry again refuses even if it is stored.
 * A mixed-case address must match its checksum (`bank.address_checksum_mismatch`), and an address that shows like
 * a saved one but is not refuses `bank.address_lookalike` unless `confirmLookalike` is true (the customer checked).
 * An address on the owner's fraud list for that network or every network refuses `bank.destination_fraud_listed`
 * before anything is stored (W-withdraw-03).
 */
export const BANK_RAMPS_DESTINATIONS_SAVE = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.save',
  kind: 'mutation',
  path: 'ramps.destinations.save',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: z
    .object({
      assetId: z.string().min(1).max(16),
      network: z.string().min(2).max(32),
      ref: z.string().min(1).max(256),
      tag: z.string().min(1).max(64).optional(),
      label: z.string().min(1).max(64),
      confirmLookalike: z.boolean().optional(),
    })
    .strict(),
  output: destinationViewOutput,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', network: 'USDC', ref: 'USDC', label: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Remove, with the same step-up scope as saving. A withdrawal that already copied the address is not touched. */
export const BANK_RAMPS_DESTINATIONS_REMOVE = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.remove',
  kind: 'mutation',
  path: 'ramps.destinations.remove',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: z.object({ destinationId: z.string().guid(), idempotencyKey: z.string().min(1).max(128) }),
  output: z.object({ destinationId: z.string(), removed: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { destinationId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
