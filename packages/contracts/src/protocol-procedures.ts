import { z } from 'zod';
import { defineProcedure, NO_INPUT, type InputCheck, type RefusalStatus, type Refusals } from './procedure.js';
import {
  protocolAuditProductsSchema,
  protocolAuditStatusSchema,
  protocolBlockersInputSchema,
  protocolBlockersOutputSchema,
  protocolHealthHonestySchema,
  protocolPredictedAccountSchema,
} from './protocol-blockers.js';
import { protocolGasPriceOutputSchema, GAS_PERCENTILES_UNSET } from './protocol-gas.js';
import {
  NETWORK_KIND_FORBIDDEN,
  protocolCapabilitiesInputSchema,
  protocolCapabilitiesOutputSchema,
  protocolDeploymentsInputSchema,
  protocolDeploymentsOutputSchema,
  protocolNetworksListOutputSchema,
} from './protocol-networks.js';
import {
  protocolListingChallengeInputSchema,
  protocolListingChallengeOutputSchema,
  protocolListingVerifyInputSchema,
  protocolListingVerifyOutputSchema,
} from './protocol-listing.js';
import {
  PROTOCOL_REPRESENTATION_REFUSALS,
  protocolRepresentationAcceptInputSchema,
  protocolRepresentationAcceptOutputSchema,
  protocolRepresentationStatusInputSchema,
  protocolRepresentationStatusOutputSchema,
} from './protocol-representation.js';
import { protocolSessionsListInputSchema, protocolSessionsListSchema } from './protocol-sessions.js';

/**
 * svc-protocol's root calls, one record per call: health and audit, the chain probe and gas, the blockers read, the network
 * and deployment registries, the smart-account address and session-key builders, the listing ownership proof, the
 * representation and the session-key list. svc-protocol mounts each from here (`mountRecord`), so its path, guard, input,
 * output and named refusals are this file, not its router. Every schema here is the one the router used before, so the
 * wire did not move (`services/svc-protocol/src/wire-replay.test.ts`).
 */

const base = { service: 'svc-protocol', module: 'protocol', transport: 'trpc' } as const;

/** No login, but a region the protocol module is not served in is refused (`publicJurisdictionProcedure('protocol', 'protocol')`). */
const JURISDICTION = { caller: 'jurisdiction', module: 'protocol', plane: 'protocol' } as const;
const PUBLIC = { caller: 'public' } as const;

const refuse = (status: RefusalStatus, ...codes: readonly string[]): Refusals =>
  Object.fromEntries(codes.map((code) => [code, status] as const));
const refusals = (...parts: readonly Refusals[]): Refusals => Object.freeze(Object.assign({}, ...parts) as Refusals);

/** A chain that is absent, unreachable or the wrong one: sent as 503 with the code leading the message. */
const CHAIN_DOWN = refuse(
  'SERVICE_UNAVAILABLE',
  'protocol.chain_not_configured',
  'protocol.chain_unreachable',
  'protocol.contract_not_deployed',
  'protocol.chain_id_mismatch',
);

/** svc-protocol's `SessionScopeError` codes: a session scope the contract would refuse is refused before it is signable. */
const SESSION_SCOPE = refuse(
  'BAD_REQUEST',
  'session.key_required',
  'session.expiry_required',
  'session.expiry_in_past',
  'session.duration_exceeded',
  'session.targets_required',
  'session.targets_too_many',
  'session.zero_target_forbidden',
  'session.self_target_forbidden',
  'session.duplicate_target',
  'session.selectors_required',
  'session.selectors_too_many',
  'session.fallback_selector_forbidden',
  'session.duplicate_selector',
  'session.outbound_transfer_forbidden',
  'session.spend_limit_overflow',
);

// ── Inputs that lived only in the router ────────────────────────────────────────────────────────────────────────────

/**
 * An EVM address in any letter case (viem `isAddress(v, { strict: false })`: `0x` and 40 hex digits, the checksum not
 * read). A predicate, not a pattern, so the refusal reads as it always has; the service checksums the address itself.
 */
const evmAddress = z.string().refine((v) => /^0x[a-fA-F0-9]{40}$/.test(v), { message: 'not an EVM address' });
const EVM_ADDRESS_SAYS = 'an EVM address: 0x and 40 hex digits, in any letter case (the checksum is not read)';
const evmAddressCheck = (first: string, ...rest: readonly string[]): InputCheck => ({
  at: rest.length === 0 ? first : [first, ...rest],
  says: EVM_ADDRESS_SAYS,
});

/** The salt a wallet's first smart account is derived with when none is given: 32 zero bytes. */
export const PROTOCOL_DEFAULT_USER_SALT = `0x${'00'.repeat(32)}` as const;

export const protocolPredictAddressInputSchema = z.object({
  owner: evmAddress,
  userSalt: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex')
    .default(PROTOCOL_DEFAULT_USER_SALT),
});

const uint48 = z
  .number()
  .int()
  .min(0)
  .max(2 ** 48 - 1);

/** A session key's scope as it arrives: unix seconds, wei as a decimal string, exact targets and 4-byte selectors. */
export const protocolSessionSpecInputSchema = z.object({
  key: evmAddress,
  validAfter: uint48.default(0),
  validUntil: uint48,
  spendLimitWei: z.string().regex(/^\d+$/, 'wei must be a non-negative integer string'),
  targets: z.array(evmAddress),
  selectors: z.array(z.string().regex(/^0x[0-9a-fA-F]{8}$/, 'a selector is 4 bytes')),
});
export type ProtocolSessionSpecInput = z.infer<typeof protocolSessionSpecInputSchema>;

export const protocolBuildSessionGrantInputSchema = z.object({ account: evmAddress, spec: protocolSessionSpecInputSchema });
export const protocolBuildSessionRevokeInputSchema = z.object({ account: evmAddress, sessionKey: evmAddress });
export const protocolBuildRevokeAllSessionsInputSchema = z.object({ account: evmAddress });

// ── Outputs that lived only in the router ───────────────────────────────────────────────────────────────────────────

/** An unsigned owner call this service built. `value` is always "0": nothing it builds moves native value. */
export const protocolUnsignedOwnerCallSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string(),
  summary: z.string(),
});
export const protocolSessionGrantOutputSchema = protocolUnsignedOwnerCallSchema.extend({
  specHash: z.string(),
  validUntil: z.number(),
});

/** `auditStatus`: the committed internal package; `audited` is a literal false until an external package hashes. */
export const protocolAuditStatusOutputSchema = protocolAuditStatusSchema.extend({ artifactHash: z.string().regex(/^0x[0-9a-f]{64}$/) });

/**
 * `chainStatus`: what the chain answered, in the order the service sends it. `expectedChainId` and `actualChainId` are set only
 * for `protocol.chain_id_mismatch`; `usable` and `launchUsable` are true only when a real chain answered and that suite is
 * deployed on it.
 */
export const protocolChainStatusOutputSchema = z.object({
  reachable: z.boolean(),
  configuredChainId: z.number(),
  observedChainId: z.number().nullable(),
  blockNumber: z.string().nullable(),
  /** Factory AND implementation are both non-zero. Config, not evidence. */
  suiteConfigured: z.boolean(),
  /** READ FROM THE CHAIN: both addresses hold contract code. */
  suiteDeployed: z.boolean(),
  /** `PROTOCOL_TOKEN_FACTORY_ADDRESS` is non-zero. Config, not evidence. */
  tokenFactoryConfigured: z.boolean(),
  /** READ FROM THE CHAIN: the launch factory holds contract code. */
  tokenFactoryDeployed: z.boolean(),
  refusalCode: z.string().nullable(),
  reason: z.string().nullable(),
  expectedChainId: z.number().int().nonnegative().nullable(),
  actualChainId: z.number().int().nonnegative().nullable(),
  usable: z.boolean(),
  launchUsable: z.boolean(),
});

// ── The records ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ADDRESS = '0x00000000000000000000000000000000000000aa';
const ADDRESS_MIXED = '0x00000000000000000000000000000000000000Aa';

export const PROTOCOL_HEALTH = defineProcedure({
  ...base,
  name: 'protocol.health',
  kind: 'query',
  path: 'health',
  access: PUBLIC,
  refusals: refusals(),
  input: NO_INPUT,
  output: protocolHealthHonestySchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_AUDIT_STATUS = defineProcedure({
  ...base,
  name: 'protocol.auditStatus',
  kind: 'query',
  path: 'auditStatus',
  access: PUBLIC,
  refusals: refusals(),
  input: NO_INPUT,
  output: protocolAuditStatusOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_AUDIT_PRODUCTS = defineProcedure({
  ...base,
  name: 'protocol.auditProducts',
  kind: 'query',
  path: 'auditProducts',
  access: PUBLIC,
  refusals: refusals(),
  input: NO_INPUT,
  output: protocolAuditProductsSchema,
  samples: [{ verdict: 'accept' }],
});

/** The one read that returns a missing chain as data (`refusalCode`), never as a refusal. */
export const PROTOCOL_CHAIN_STATUS = defineProcedure({
  ...base,
  name: 'protocol.chainStatus',
  kind: 'query',
  path: 'chainStatus',
  access: JURISDICTION,
  refusals: refusals(),
  input: NO_INPUT,
  output: protocolChainStatusOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_GAS_PRICE = defineProcedure({
  ...base,
  name: 'protocol.gasPrice',
  kind: 'query',
  path: 'gasPrice',
  access: JURISDICTION,
  refusals: refusals(refuse('PRECONDITION_FAILED', GAS_PERCENTILES_UNSET), CHAIN_DOWN),
  input: NO_INPUT,
  output: protocolGasPriceOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_BLOCKERS = defineProcedure({
  ...base,
  name: 'protocol.blockers',
  kind: 'query',
  path: 'blockers',
  access: JURISDICTION,
  refusals: refusals(),
  input: protocolBlockersInputSchema.default({}),
  output: protocolBlockersOutputSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'accept', input: { plannedSelector: '0xa9059cbb' } },
    { verdict: 'refuse', input: { plannedSelector: 'transfer' } },
    { verdict: 'refuse', input: { other: 1 } },
  ],
});

export const PROTOCOL_NETWORKS_LIST = defineProcedure({
  ...base,
  name: 'protocol.networks.list',
  kind: 'query',
  path: 'networks.list',
  access: PUBLIC,
  refusals: refusals(refuse('SERVICE_UNAVAILABLE', 'protocol.network_registry_invalid', NETWORK_KIND_FORBIDDEN)),
  input: NO_INPUT,
  output: protocolNetworksListOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** A chain with no recorded deployment is NOT_FOUND (`protocol.deployments_unknown_chain` leads its message; no named code). */
export const PROTOCOL_DEPLOYMENTS_LIST = defineProcedure({
  ...base,
  name: 'protocol.deployments.list',
  kind: 'query',
  path: 'deployments.list',
  access: PUBLIC,
  refusals: refusals(),
  input: protocolDeploymentsInputSchema,
  output: protocolDeploymentsOutputSchema,
  samples: [
    { verdict: 'accept', input: { chainId: 84532 } },
    { verdict: 'refuse', input: { chainId: 0 } },
    { verdict: 'refuse', input: { chainId: '84532' } },
  ],
});

export const PROTOCOL_CAPABILITIES = defineProcedure({
  ...base,
  name: 'protocol.capabilities',
  kind: 'query',
  path: 'capabilities',
  access: JURISDICTION,
  refusals: refusals(),
  input: protocolCapabilitiesInputSchema,
  output: protocolCapabilitiesOutputSchema,
  samples: [
    { verdict: 'accept', input: { chainId: 31337 } },
    { verdict: 'refuse', input: { chainId: -1 } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Arithmetic over public constants; refused while the factory and implementation are still the zero-address defaults. */
export const PROTOCOL_PREDICT_ADDRESS = defineProcedure({
  ...base,
  name: 'protocol.predictAddress',
  kind: 'query',
  path: 'predictAddress',
  access: JURISDICTION,
  refusals: refusals(refuse('BAD_REQUEST', 'protocol.invalid_address', 'protocol.invalid_salt'), CHAIN_DOWN),
  input: protocolPredictAddressInputSchema,
  output: protocolPredictedAccountSchema,
  checks: { evmAddress: evmAddressCheck('input.owner') },
  samples: [
    { verdict: 'accept', input: { owner: ADDRESS } },
    { verdict: 'accept', input: { owner: ADDRESS_MIXED, userSalt: `0x${'11'.repeat(32)}` } },
    { verdict: 'refuse', input: { owner: ADDRESS, userSalt: '0x11' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { owner: '0x1234' }, by: 'evmAddress' },
  ],
});

const SPEC = {
  key: '0x00000000000000000000000000000000000000bb',
  validUntil: 1_800_003_600,
  spendLimitWei: '1000000000000000000',
  targets: ['0x00000000000000000000000000000000000000cc'],
  selectors: ['0x38ed1739'],
};

/** Nothing is granted here: a scope the contract would refuse, including any withdrawal power, is refused before signing. */
export const PROTOCOL_BUILD_SESSION_GRANT = defineProcedure({
  ...base,
  name: 'protocol.buildSessionGrant',
  kind: 'query',
  path: 'buildSessionGrant',
  access: JURISDICTION,
  refusals: refusals(SESSION_SCOPE),
  input: protocolBuildSessionGrantInputSchema,
  output: protocolSessionGrantOutputSchema,
  checks: { evmAddress: evmAddressCheck('input.account', 'input.spec.key', 'input.spec.targets[]') },
  samples: [
    { verdict: 'accept', input: { account: ADDRESS, spec: SPEC } },
    { verdict: 'accept', input: { account: ADDRESS, spec: { ...SPEC, validAfter: 1_800_000_000 } } },
    { verdict: 'refuse', input: { account: ADDRESS, spec: { ...SPEC, spendLimitWei: '-1' } } },
    { verdict: 'refuse', input: { account: ADDRESS, spec: { ...SPEC, selectors: ['0x38ed'] } } },
    { verdict: 'refuse', input: { account: ADDRESS } },
    { verdict: 'refuse', input: { account: ADDRESS, spec: { ...SPEC, targets: ['venue'] } }, by: 'evmAddress' },
  ],
});

export const PROTOCOL_BUILD_SESSION_REVOKE = defineProcedure({
  ...base,
  name: 'protocol.buildSessionRevoke',
  kind: 'query',
  path: 'buildSessionRevoke',
  access: JURISDICTION,
  refusals: refusals(),
  input: protocolBuildSessionRevokeInputSchema,
  output: protocolUnsignedOwnerCallSchema,
  checks: { evmAddress: evmAddressCheck('input.account', 'input.sessionKey') },
  samples: [
    { verdict: 'accept', input: { account: ADDRESS, sessionKey: SPEC.key } },
    { verdict: 'refuse', input: { account: ADDRESS } },
    { verdict: 'refuse', input: { account: ADDRESS, sessionKey: 'key' }, by: 'evmAddress' },
  ],
});

/** The panic button: one unsigned owner call that ends every session key at once. */
export const PROTOCOL_BUILD_REVOKE_ALL_SESSIONS = defineProcedure({
  ...base,
  name: 'protocol.buildRevokeAllSessions',
  kind: 'query',
  path: 'buildRevokeAllSessions',
  access: JURISDICTION,
  refusals: refusals(),
  input: protocolBuildRevokeAllSessionsInputSchema,
  output: protocolUnsignedOwnerCallSchema,
  checks: { evmAddress: evmAddressCheck('input.account') },
  samples: [
    { verdict: 'accept', input: { account: ADDRESS } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { account: 'me' }, by: 'evmAddress' },
  ],
});

const LISTING = {
  challengeTtlUnset: 'protocol.listing.challenge_ttl_unset',
  ownerUnknown: 'protocol.listing.owner_unknown',
  notOwner: 'protocol.listing.not_owner',
  nonceUnknown: 'protocol.listing.nonce_unknown',
  nonceUsed: 'protocol.listing.nonce_used',
  challengeExpired: 'protocol.listing.challenge_expired',
} as const;

/** A fresh one-time message for the token's owner to sign. Public: the owner may be signed out. */
export const PROTOCOL_LISTING_OWNERSHIP_CHALLENGE = defineProcedure({
  ...base,
  name: 'protocol.listing.ownershipChallenge',
  kind: 'mutation',
  path: 'listing.ownershipChallenge',
  access: JURISDICTION,
  refusals: refusals(refuse('PRECONDITION_FAILED', LISTING.challengeTtlUnset, LISTING.ownerUnknown), CHAIN_DOWN),
  input: protocolListingChallengeInputSchema,
  output: protocolListingChallengeOutputSchema,
  samples: [
    { verdict: 'accept', input: { token: ADDRESS } },
    { verdict: 'refuse', input: { token: '' } },
    { verdict: 'refuse', input: { token: ADDRESS, chainId: 1 } },
  ],
});

/** Stores a proof only when the token's on-chain owner signed the challenge. */
export const PROTOCOL_LISTING_VERIFY_OWNERSHIP = defineProcedure({
  ...base,
  name: 'protocol.listing.verifyOwnership',
  kind: 'mutation',
  path: 'listing.verifyOwnership',
  access: JURISDICTION,
  refusals: refusals(
    refuse('PRECONDITION_FAILED', LISTING.challengeTtlUnset, LISTING.ownerUnknown),
    refuse('FORBIDDEN', LISTING.notOwner),
    refuse('NOT_FOUND', LISTING.nonceUnknown),
    refuse('CONFLICT', LISTING.nonceUsed, LISTING.challengeExpired),
    CHAIN_DOWN,
  ),
  input: protocolListingVerifyInputSchema,
  output: protocolListingVerifyOutputSchema,
  samples: [
    { verdict: 'accept', input: { nonce: '0123456789abcdef0123456789abcdef', signature: `0x${'ab'.repeat(65)}` } },
    { verdict: 'refuse', input: { nonce: 'nonce', signature: `0x${'ab'.repeat(65)}` } },
    { verdict: 'refuse', input: { nonce: '0123456789abcdef0123456789abcdef', signature: '0xab' } },
  ],
});

const [REPRESENTATION_UNSET, REPRESENTATION_VERSION_STALE, REPRESENTATION_SIGNATURE_NOT_OWNER] = PROTOCOL_REPRESENTATION_REFUSALS;

/** The representation a wallet signs once per version, and whether this address has. Public: the visitor may be signed out. */
export const PROTOCOL_REPRESENTATION_STATUS = defineProcedure({
  ...base,
  name: 'protocol.representation.status',
  kind: 'query',
  path: 'representation.status',
  access: JURISDICTION,
  refusals: refusals(refuse('PRECONDITION_FAILED', REPRESENTATION_UNSET)),
  input: protocolRepresentationStatusInputSchema,
  output: protocolRepresentationStatusOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS } },
    { verdict: 'refuse', input: { address: 'me' } },
  ],
});

/** Writes only on proof that the address signed `status.message`. */
export const PROTOCOL_REPRESENTATION_ACCEPT = defineProcedure({
  ...base,
  name: 'protocol.representation.accept',
  kind: 'mutation',
  path: 'representation.accept',
  access: JURISDICTION,
  refusals: refusals(
    refuse('PRECONDITION_FAILED', REPRESENTATION_UNSET),
    refuse('CONFLICT', REPRESENTATION_VERSION_STALE),
    refuse('FORBIDDEN', REPRESENTATION_SIGNATURE_NOT_OWNER),
  ),
  input: protocolRepresentationAcceptInputSchema,
  output: protocolRepresentationAcceptOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS, version: 'v1', signature: `0x${'ab'.repeat(65)}` } },
    { verdict: 'accept', input: { address: ADDRESS, version: 'v1', signature: `0x${'ab'.repeat(64)}` } },
    { verdict: 'refuse', input: { address: ADDRESS, version: '', signature: `0x${'ab'.repeat(65)}` } },
    { verdict: 'refuse', input: { address: ADDRESS, version: 'v1', signature: '0xab' } },
  ],
});

/** Every key the account granted, from its own logs, with the on-chain status at one block. Public, like the chain. */
export const PROTOCOL_SESSIONS_LIST = defineProcedure({
  ...base,
  name: 'protocol.sessions.list',
  kind: 'query',
  path: 'sessions.list',
  access: JURISDICTION,
  refusals: refusals(CHAIN_DOWN),
  input: protocolSessionsListInputSchema,
  output: protocolSessionsListSchema,
  samples: [
    { verdict: 'accept', input: { account: ADDRESS } },
    { verdict: 'refuse', input: { account: '0x12' } },
    { verdict: 'refuse', input: {} },
  ],
});
