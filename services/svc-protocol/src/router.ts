import { z } from 'zod';
import { getAddress as toChecksum, isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import {
  protocolBlockersInputSchema,
  protocolCapabilitiesInputSchema,
  protocolCapabilitiesOutputSchema,
  protocolDeploymentsInputSchema,
  protocolDeploymentsOutputSchema,
  protocolGasPriceOutputSchema,
  protocolNetworksListOutputSchema,
  protocolBlockersOutputSchema,
  protocolBlockersRead,
  protocolOpsLabelsOutputSchema,
  protocolOpsMetricsInputSchema,
  protocolOpsMetricsOutputSchema,
  protocolBadgeClaimOutputSchema,
  protocolRepresentationAcceptInputSchema,
  protocolRepresentationAcceptOutputSchema,
  protocolRepresentationStatusInputSchema,
  protocolRepresentationStatusOutputSchema,
  protocolBadgeEligibilityOutputSchema,
  publicJurisdictionProcedure,
  publicProcedure,
  router,
  scopedProcedure,
  TRPCError,
  type BlockerSource,
  protocolSwapPairsOutputSchema,
  protocolTokenPricesOutputSchema,
  PRICE_SETTINGS_UNSET,
  protocolSwapSettingsOutputSchema,
  protocolSwapFeesOutputSchema,
  protocolAllowancesOutputSchema,
  SWAP_SETTINGS_UNSET,
} from '@intafaced/contracts';
import { computeAccountAddress, DEFAULT_USER_SALT, AddressDerivationError } from './accounts/address.js';
import { AccountRegistry, bindingMessage, ClaimRefusedError } from './accounts/registry.js';
import { assertMyAccountsListLimit, MY_ACCOUNTS_LIST_LIMIT_CAP, MyAccountsListLimitUnsetError } from './accounts/my-accounts-list-limit.js';
import type { ProtocolChain } from './chain/client.js';
import { ChainUnavailableError, CHAIN_PUBLIC_TEXT, isZeroAddress } from './chain/availability.js';
import { GasPercentilesUnsetError, type GasPercentileSetting } from './chain/gas-price.js';
import { deployedCodeMatches } from './chain/artifacts.js';
import { RelayRefusedError, SessionRelay } from './session/relay.js';
import {
  createSessionSpec,
  evaluateSessionCall,
  FORBIDDEN_SELECTORS,
  hashSessionSpec,
  readSwapExactInCall,
  sessionSpecInputSchema,
  SessionScopeError,
} from './session/spec.js';
import { SignatureEnvelopeError, type UserOperation } from './chain/userop.js';
import { AmmMathError } from './amm/math.js';
import { freshPoolQuote, PoolTokenError } from './amm/pool-quote.js';
import { pairsReader } from './amm/pairs.js';
import { listAllowances } from './amm/allowances.js';
import { feeLevels, requireFeeCapWei, SwapFeeError } from './amm/fee-levels.js';
import { priceTokens, type PriceSetting } from './amm/prices.js';
import { createTokensRouter } from './amm/tokens-router.js';
import { createPoolFeesProcedures, poolFeesChain } from './amm/pool-fees.js';
import { tokenLogsChain } from './amm/token-reader.js';
import { assertMinAmountOut, requireSwapSlippageBps, SwapSlippageError } from './amm/slippage.js';
import {
  MAX_UINT256,
  buildApprove,
  buildCreatePool,
  buildMintLiquidity,
  buildRevoke,
  buildSwapExactIn,
  planApproval,
  quoteExactIn,
} from './amm/build.js';
import { computeTokenAddress, DEFAULT_TOKEN_SALT, templateArtifact, TokenAddressError } from './launch/address.js';
import { buildCreateToken } from './launch/build.js';
import { MAX_DECIMALS, MAX_NAME_BYTES, MAX_SYMBOL_BYTES, MAX_WHOLE_SUPPLY, parseTokenParams, TokenParamsError } from './launch/params.js';
import { loadInternalSmartAccountsPackage } from './audit/pipeline.js';
import { loadAuditRegistry } from './audit/registry.js';
import { protocolHealthHonesty, protocolHealthHonestySchema } from './health-honesty.js';
import { noPeers, type Peers } from './blockers/peers.js';
import { deploymentsFor, loadNetworkRegistry } from './networks/registry.js';
import { labelsOutput, serviceLabelEntries } from './ops/labels.js';
import { buildMetrics } from './ops/metrics.js';
import {
  badgeClaimKey,
  badgeEligibility,
  BadgeRefusedError,
  claimBadge,
  BADGE_WINDOW_UNSET,
  RAIL_CRYPTO,
  resolveStuckBadgeMint,
  BADGE_STUCK_APPROVAL_REFUSED,
  BADGE_STUCK_APPROVAL_UNWIRED,
  BADGE_STUCK_NOT_STALE,
  type BadgeApprovalConsumer,
  type BadgeMinter,
  type BadgeStore,
  type BadgeWindow,
} from './nft/founding-badge.js';
import {
  acceptRepresentation,
  REPRESENTATION_SIGNATURE_NOT_OWNER,
  REPRESENTATION_UNSET,
  RepresentationRefusedError,
  representationStatus,
  type RepresentationSetting,
  type RepresentationStore,
} from './representation/representation.js';
import {
  issueChallenge,
  LISTING_CHALLENGE_TTL_UNSET,
  LISTING_NONCE_UNKNOWN,
  LISTING_NOT_OWNER,
  LISTING_OWNER_UNKNOWN,
  ListingRefusedError,
  verifyOwnership,
  type ListingStore,
  type OwnershipChain,
} from './listing/ownership.js';
import { ownershipChain } from './listing/ownership-chain.js';
import {
  protocolListingChallengeInputSchema,
  protocolListingChallengeOutputSchema,
  protocolListingVerifyInputSchema,
  protocolListingVerifyOutputSchema,
} from '@intafaced/contracts/protocol-listing';

/**
 * svc-protocol's API.
 *
 * Read the guards, not just the procedures. Almost everything here is
 * `publicJurisdictionProcedure` — no login, no KYC tier, no account gate. That
 * is §22 as code: this module is `custodial: false` on the `protocol` plane, so
 * `checkAccess` returns `allowed.permissionless` and there is nothing to verify,
 * because there is nothing held.
 *
 * The two authenticated procedures are the registry ones, and they are
 * authenticated for a mundane reason: attaching an address to an INTAFACED
 * profile requires knowing whose profile it is. They confer no power over the
 * account. `packages/auth` has no `protocol:write` scope at all — deliberately,
 * the same way it has no `ledger:write` — because no user token, and no
 * platform credential, may ever authorise anything on this plane. The only
 * thing that authorises here is a signature from the user's own key.
 */

const addressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), { message: 'not an EVM address' })
  .transform((v) => toChecksum(v));

const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex');
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be hex');

const userOperationSchema = z.object({
  sender: addressSchema,
  nonce: z.string().regex(/^\d+$/),
  factory: addressSchema.optional(),
  factoryData: hexSchema.optional(),
  callData: hexSchema,
  callGasLimit: z.string().regex(/^\d+$/),
  verificationGasLimit: z.string().regex(/^\d+$/),
  preVerificationGas: z.string().regex(/^\d+$/),
  maxFeePerGas: z.string().regex(/^\d+$/),
  maxPriorityFeePerGas: z.string().regex(/^\d+$/),
  paymaster: addressSchema.optional(),
  paymasterVerificationGasLimit: z.string().regex(/^\d+$/).optional(),
  paymasterPostOpGasLimit: z.string().regex(/^\d+$/).optional(),
  paymasterData: hexSchema.optional(),
  signature: hexSchema,
});

function toUserOperation(input: z.infer<typeof userOperationSchema>): UserOperation {
  return {
    sender: input.sender as Address,
    nonce: BigInt(input.nonce),
    ...(input.factory ? { factory: input.factory as Address } : {}),
    ...(input.factoryData ? { factoryData: input.factoryData as Hex } : {}),
    callData: input.callData as Hex,
    callGasLimit: BigInt(input.callGasLimit),
    verificationGasLimit: BigInt(input.verificationGasLimit),
    preVerificationGas: BigInt(input.preVerificationGas),
    maxFeePerGas: BigInt(input.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(input.maxPriorityFeePerGas),
    ...(input.paymaster ? { paymaster: input.paymaster as Address } : {}),
    ...(input.paymasterVerificationGasLimit ? { paymasterVerificationGasLimit: BigInt(input.paymasterVerificationGasLimit) } : {}),
    ...(input.paymasterPostOpGasLimit ? { paymasterPostOpGasLimit: BigInt(input.paymasterPostOpGasLimit) } : {}),
    ...(input.paymasterData ? { paymasterData: input.paymasterData as Hex } : {}),
    signature: input.signature as Hex,
  };
}

/**
 * Launch parameters, as they arrive on the wire.
 *
 * Shape only. The real validation is `parseTokenParams`, and the split is
 * deliberate: zod gives a caller a 400 with a field path, and `params.ts` gives
 * them a `launch.*` code with a sentence explaining why an irreversible choice
 * was refused. Encoding the second as zod refinements would flatten those
 * sentences into "Invalid input".
 *
 * `totalSupply` is a STRING here and stays one until `parseUnits` turns it into
 * a bigint. It is never `z.number()`, which would silently round any supply past
 * 2^53 — the doctrine on money in a `number`, at the one place the wire touches
 * this service.
 */
const tokenParamsInputSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int(),
  /** Whole tokens, decimal string: "1000000", "21000000.5". */
  totalSupply: z.string(),
  /** Receives the entire supply at construction. */
  recipient: addressSchema,
});

/** An approval amount is a positive decimal integer; zero is a revoke and has its own call. */
const approvalAmountSchema = z
  .string()
  .regex(/^[1-9]\d{0,77}$/, 'protocol.approval_amount_invalid: use a positive whole number, or revoke to remove an approval');

function parseApprovalAmount(text: string): bigint {
  const amount = BigInt(text);
  if (amount > MAX_UINT256) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'protocol.approval_amount_invalid: that amount does not fit a token balance.' });
  }
  return amount;
}

/** A zero token or spender is never a real target. */
function requireApprovalTargets(token: Address, spender: Address): void {
  if (isZeroAddress(token) || isZeroAddress(spender)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'protocol.approval_target_zero: the token and the spender must be real addresses.',
    });
  }
}

const unsignedCallOutput = z.object({
  to: z.string(),
  data: z.string(),
  /** Always "0" here. Nothing this service builds moves native value. */
  value: z.string(),
  summary: z.string(),
});

/**
 * Refuse every launch path against an unconfigured factory (default is 0x0).
 *
 * This is the check that stops the worst thing this service could do. CREATE2
 * arithmetic against `factory = 0x0` succeeds — it returns a real, checksummed
 * address that looks exactly like a token address and belongs to a contract
 * nothing will ever deploy. A creator would publish it, and the money buyers
 * sent there would be gone to nobody.
 */
function requireTokenFactoryConfigured(tokenFactory: string): void {
  if (isZeroAddress(tokenFactory)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'launch.factory_not_configured: no TokenFactory is deployed on this chain (PROTOCOL_TOKEN_FACTORY_ADDRESS). ' +
        'Refusing to derive a token address from the zero address — it would be a real-looking address that ' +
        'nothing will ever be deployed to. Contracts are in-repo under contracts/launch/.',
    });
  }
}

/** Refuse create2 arithmetic against an unconfigured factory/impl (defaults are 0x0). */
function requireAccountFactoryConfigured(factory: string, implementation: string): void {
  if (isZeroAddress(factory) || isZeroAddress(implementation)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Smart account factory/implementation is not configured (PROTOCOL_FACTORY_ADDRESS / PROTOCOL_IMPLEMENTATION_ADDRESS).',
    });
  }
}

/** Every domain error becomes a client error with its own code intact. */
function toTrpcError(err: unknown): TRPCError {
  /**
   * A refusal that was already shaped stays shaped.
   *
   * Without this, any `TRPCError` thrown inside a procedure's own `try` block
   * falls all the way through to the `INTERNAL_SERVER_ERROR` at the bottom, and
   * a deliberate 400 arrives at the caller as "Protocol request failed" with its
   * message discarded.
   */
  if (err instanceof TRPCError) return err;
  if (err instanceof RepresentationRefusedError) {
    const code =
      err.code === REPRESENTATION_UNSET
        ? 'PRECONDITION_FAILED'
        : err.code === REPRESENTATION_SIGNATURE_NOT_OWNER
          ? 'FORBIDDEN'
          : 'CONFLICT';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  if (err instanceof ListingRefusedError) {
    const code =
      err.code === LISTING_CHALLENGE_TTL_UNSET || err.code === LISTING_OWNER_UNKNOWN
        ? 'PRECONDITION_FAILED'
        : err.code === LISTING_NOT_OWNER
          ? 'FORBIDDEN'
          : err.code === LISTING_NONCE_UNKNOWN
            ? 'NOT_FOUND'
            : 'CONFLICT';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  if (err instanceof BadgeRefusedError) {
    const code =
      err.code === BADGE_STUCK_APPROVAL_REFUSED
        ? 'FORBIDDEN'
        : err.code === BADGE_STUCK_NOT_STALE
          ? 'CONFLICT'
          : err.code === BADGE_STUCK_APPROVAL_UNWIRED
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  /**
   * The chain being absent is not this service failing.
   *
   * 503 with the refusal code in the message, so a caller can tell "there is no
   * chain here" from "svc-protocol is broken". A 500 would invite a retry that
   * can never succeed, and — the reason this branch is first — anything falling
   * through to the bottom of this function becomes
   * `INTERNAL_SERVER_ERROR: 'Protocol request failed'`, which is precisely the
   * opaque answer a user cannot act on.
   */
  if (err instanceof ChainUnavailableError) {
    const customer = /:\/\/|\bSOCKET\b/.test(err.message) ? CHAIN_PUBLIC_TEXT[err.code] : err.message;
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: `${err.code}: ${customer}`, cause: err });
  }
  if (err instanceof SessionScopeError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof ClaimRefusedError) {
    const code = err.code === 'registry.already_claimed' ? 'CONFLICT' : 'BAD_REQUEST';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  if (err instanceof MyAccountsListLimitUnsetError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  /**
   * A malformed signature envelope is the caller's mistake, not ours.
   *
   * Found the first time `relayUserOperation` was called with a live chain
   * behind it: a signature that is not `1 mode byte + 65 bytes` throws
   * `SignatureEnvelopeError`, which nothing here recognised, so it fell to the
   * bottom of this function and arrived as
   * `INTERNAL_SERVER_ERROR: 'Protocol request failed'`. That is the same opaque
   * answer #193 removed from the chain paths — a 500 invites a retry of an
   * operation that can never be accepted, and hides the one thing the caller
   * needs to know, which is that their bytes are the wrong shape.
   */
  if (err instanceof SignatureEnvelopeError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof RelayRefusedError) {
    const code = err.code === 'relay.bundler_unavailable' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  if (err instanceof AddressDerivationError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof AmmMathError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof GasPercentilesUnsetError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof SwapSlippageError) {
    const code = err.code === 'protocol.swap_slippage_unset' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  if (err instanceof PoolTokenError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof SwapFeeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  /**
   * A launch parameter the platform will not put its name on, or an address
   * that does not parse. Both are the caller's input, and both carry their own
   * `launch.*` code — which the message keeps, because "invalid supply" without
   * the reason is not something a creator can act on, and the decision they are
   * about to make is irreversible.
   */
  if (err instanceof TokenParamsError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.code}: ${err.message}`, cause: err });
  }
  if (err instanceof TokenAddressError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.code}: ${err.message}`, cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Protocol request failed', cause: err });
}

export interface ProtocolRouterDeps {
  chain: ProtocolChain;
  registry: AccountRegistry;
  relay: SessionRelay;
  /** Mirrors the `protocol.smartAccounts` kill-switch (§14). */
  relayEnabled: () => boolean;
  /** Pool factory address on PROTOCOL_CHAIN_ID (0x0 = not deployed yet). */
  ammFactoryAddress: () => Address;
  /**
   * `PROTOCOL_SWAP_SLIPPAGE_BPS`. Null when blank. The swap builder and the
   * session check refuse — they do not invent a tolerance.
   */
  swapSlippageBps: () => number | null;
  /** `PROTOCOL_SWAP_QUOTE_TTL_SECONDS`. Null or absent: `amm.swapSettings` refuses. */
  swapQuoteTtlSeconds?: () => number | null;
  /** `PROTOCOL_SWAP_CONFIRMATIONS`. Null or absent: `amm.swapSettings` refuses. */
  swapConfirmations?: () => number | null;
  /** `PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI`, the fee cap. Null or absent: `amm.feeLevels` refuses `protocol.swap_fee_cap_unset`. */
  swapFeeCapWei?: () => bigint | null;
  /** `PROTOCOL_PRICE_USD_TOKENS` and `PROTOCOL_PRICE_MIN_RESERVE_USD`. Null or absent: `amm.prices` refuses. */
  priceSetting?: () => PriceSetting | null;
  /** `PROTOCOL_TOKENS_QUOTE_TOKEN`: what the token pages state prices in. Null or absent: `tokens.*` refuses. */
  tokensQuoteToken?: () => Address | null;
  /** What the indexer and the DEX report about themselves, for `blockers`. Absent = not connected. */
  peers?: Peers;
  /** `PROTOCOL_PEER_TIMEOUT_MS`: the published bound for the bundler probe. Absent = the probe is not made. */
  probeTimeoutMs?: () => number | undefined;
  /** `PROTOCOL_OPS_WINDOW_SECONDS`: the ops metrics window when the caller names none. Blank = refuse `owner.decision`. */
  opsWindowSeconds?: () => number | undefined;
  /**
   * D-explorer-01 owner percentiles and history length. Null or absent refuses
   * `protocol.gas_percentiles_unset` before any chain read.
   */
  gasPercentiles?: () => GasPercentileSetting | null;
  /** Clock for `protocol.gasPrice.asOf`. Tests pin it. */
  now?: () => Date;
  /** Test seam for the network registry source; defaults to the owner's `deployments/networks.json`. */
  loadNetworks?: () => ReturnType<typeof loadNetworkRegistry>;
  /**
   * Contract ownership proof (D-launch-listing-01). `ttlSeconds()` is null while the owner's challenge lifetime is blank
   * (`protocol.listing.challenge_ttl_unset`). Absent = not wired, which refuses the same way. `chain` defaults to the
   * service's own client.
   */
  listing?: {
    store: ListingStore;
    ttlSeconds: () => number | null;
    chain?: OwnershipChain;
    now?: () => Date;
  };
  /**
   * The first-signing representation (D-developer-compliance-03). `setting()` is null while counsel's text or the owner's
   * version is blank (`compliance.representation_unset`). Absent = not wired, which refuses the same way.
   */
  representation?: {
    store: RepresentationStore;
    setting: () => RepresentationSetting | null;
  };
  /**
   * Founding badge (RC-more-catalogue-04). `index.ts` always wires it; the minter's `signerFor` returns null until a signer lands, so claims refuse `rail.crypto` from `claimBadge`.
   * `window()` is the founder-published Drop phase I window; null = blank (`badge.window_unset`).
   * `mainnet()` is true only for a production network (claims refuse `audit.external`).
   */
  badge?: {
    store: BadgeStore;
    minter: BadgeMinter;
    window: () => BadgeWindow | null;
    mainnet: () => boolean;
    now?: () => Date;
    /** Identity four-eyes approval for the operator stuck-mint clear; null/absent = `badge.stuck_approval_unwired`. */
    approvals?: BadgeApprovalConsumer | null;
    /** Owner-set stale age (seconds) for the stuck-mint clear; undefined = `badge.stuck_age_unset`. */
    stuckMintAgeSeconds?: () => number | undefined;
  };
}

/** Never reached with a setting: an unwired representation has none, so it refuses `compliance.representation_unset` first. */
const unwiredRepresentationStore: RepresentationStore = {
  find: async () => null,
  put: async () => {
    throw new Error('representation store is not wired');
  },
};

export function createProtocolRouter(deps: ProtocolRouterDeps) {
  const { chain, registry, relay } = deps;
  const readPairs = pairsReader(chain);
  // The ownership proof's chain reads, built once: the challenge's chain id and the verify reads come from this one object.
  let ownership: OwnershipChain | null = null;
  const listingChain = (): OwnershipChain => (ownership ??= deps.listing?.chain ?? ownershipChain(chain));
  // amm.prices is public: one block's time is read once and shared, like the pairs read it sits on.
  let blockTime: { block: string; at: Promise<Date> } | null = null;
  const timeOfBlock = (block: string): Promise<Date> => {
    if (blockTime?.block !== block) {
      const at = chain.blockTimestamp(BigInt(block));
      blockTime = { block, at };
      at.catch(() => {
        if (blockTime?.at === at) blockTime = null;
      });
    }
    return blockTime!.at;
  };
  const peers = deps.peers ?? noPeers;

  function requireRelayEnabled() {
    if (!deps.relayEnabled()) {
      // Note what a kill-switch can and cannot do here. It stops US from
      // relaying. It does not stop a user transacting: their account is on a
      // public chain and they can submit the same operation to any bundler.
      // A kill-switch on this plane is a switch on our convenience, never on
      // their access.
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Relaying is disabled. Your account is unaffected — submit directly to any bundler.',
      });
    }
  }

  return router({
    health: publicProcedure.output(protocolHealthHonestySchema).query(() =>
      protocolHealthHonesty({
        relayEnabled: deps.relayEnabled(),
        factoryConfigured: !isZeroAddress(chain.config.factory) && !isZeroAddress(chain.config.implementation),
      }),
    ),

    /**
     * S-J1 — audit pipeline as data, not a badge. The committed package is
     * internal; `audited` is a literal false until a Nitro-paid external
     * package hashes. Tests pass ≠ audited:true.
     */
    auditStatus: publicProcedure
      .output(
        z.object({
          id: z.string(),
          kind: z.literal('internal'),
          packagePath: z.string(),
          artifactHash: z.string().regex(/^0x[0-9a-f]{64}$/),
          signedBy: z.string().nullable(),
          signedAt: z.string().nullable(),
          audited: z.literal(false),
        }),
      )
      .query(() => loadInternalSmartAccountsPackage()),

    /**
     * Full registry: internal packages, optional external claims, live suite
     * sourceHash from committed artefacts. `audited:true` only when Nitro
     * commits a firm report in `src/audit/external-claims.json` with a matching
     * hash. Empty intake ships `anyAudited: false`.
     */
    auditRegistry: publicProcedure
      .output(
        z.object({
          packages: z.array(
            z.object({
              id: z.string(),
              kind: z.enum(['none', 'internal', 'external']),
              packagePath: z.string(),
              artifactHash: z.string().regex(/^0x[0-9a-f]{64}$/),
              signedBy: z.string().nullable(),
              signedAt: z.string().nullable(),
              audited: z.boolean(),
            }),
          ),
          suites: z.array(
            z.object({
              suite: z.string(),
              sourceHash: z.string().regex(/^0x[0-9a-f]{64}$/),
              sourceFiles: z.array(z.string()),
            }),
          ),
          auditedCount: z.number().int().nonnegative(),
          packageCount: z.number().int().nonnegative(),
          suiteCount: z.number().int().nonnegative(),
          anyAudited: z.boolean(),
        }),
      )
      .query(() => loadAuditRegistry()),

    /**
     * IS ANY OF THIS REAL YET? — the question `health` cannot answer.
     *
     * `health` is process liveness: `ok: true` when the process is up, chain
     * `status: 'unprobed'`. It does not echo `PROTOCOL_CHAIN_ID` (Anvil 31337
     * by default). This procedure probes and reports what it found. It is the
     * one place in this router that returns a refusal as *data* rather than
     * throwing it: a product surface has to render "no chain configured" as a
     * state, and a status endpoint that 503s cannot be distinguished from one
     * that is down. Every other path here throws, because every other path
     * would otherwise have to invent a value.
     */
    chainStatus: publicJurisdictionProcedure('protocol', 'protocol')
      .output(
        z.object({
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
          /**
           * Set only for `protocol.chain_id_mismatch`: the chain this service
           * derives addresses for, and the chain the RPC answered as.
           * Chain ids are public. The endpoint is not on this object.
           */
          expectedChainId: z.number().int().nonnegative().nullable(),
          actualChainId: z.number().int().nonnegative().nullable(),
          /** True only when a real chain answered AND the smart-account suite is deployed on it. */
          usable: z.boolean(),
          /**
           * The same claim for `launch.token-factory`, kept separate.
           *
           * One `usable` covering both would go false for whichever feature was
           * not deployed and take the other down with it.
           */
          launchUsable: z.boolean(),
        }),
      )
      .query(async () => {
        const status = await chain.status();
        return {
          ...status,
          usable: status.reachable && status.suiteDeployed,
          launchUsable: status.reachable && status.tokenFactoryDeployed,
        };
      }),

    /**
     * Gas tracker for `/chain` (D-explorer-01). `eth_gasPrice` always; low, average
     * and high are the owner percentiles of `eth_feeHistory` over the last N blocks.
     * A blank setting refuses before the node is asked. No base fee from the node
     * leaves `baseFeePerGasWei` and `priorityFeeWei` null — the card shows only `gasPriceWei`.
     */
    gasPrice: publicJurisdictionProcedure('protocol', 'protocol')
      .output(protocolGasPriceOutputSchema)
      .query(async () => {
        try {
          const setting = deps.gasPercentiles?.() ?? null;
          if (!setting) throw new GasPercentilesUnsetError();
          return await chain.gasPrice(setting, deps.now?.() ?? new Date());
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * WHAT STANDS IN FRONT OF EACH PROTOCOL ACTION, from one engine (D-order-controls-02).
     *
     * Chain, audit and health are read here; the indexer and the DEX are read through their public procedures. A source
     * that does not answer is reported as such and blocks exactly like a "no". `plannedSelector` lets a session key be
     * checked against the session spec, which refuses transfers and approvals; the room cannot know that.
     */
    blockers: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolBlockersInputSchema.default({}))
      .output(protocolBlockersOutputSchema)
      .query(async ({ input, ctx }) => {
        const region = typeof ctx.region === 'string' ? ctx.region : undefined;
        const settle = async <T>(read: () => Promise<T> | T, reason: string): Promise<BlockerSource<T>> => {
          try {
            return { status: 'ok', data: await read() };
          } catch {
            return { status: 'down', reason: 'unreachable', message: reason };
          }
        };
        const [chainSource, audit, indexer, dex] = await Promise.all([
          settle(async () => {
            const status = await chain.status();
            return {
              ...status,
              usable: status.reachable && status.suiteDeployed,
              launchUsable: status.reachable && status.tokenFactoryDeployed,
            };
          }, 'The network could not be checked.'),
          settle(() => loadInternalSmartAccountsPackage(), 'The audit record could not be read.'),
          peers.indexer(region),
          peers.dex(region),
        ]);
        const refusedBy = input.plannedSelector ? FORBIDDEN_SELECTORS.get(input.plannedSelector.toLowerCase() as Hex) : undefined;
        return protocolBlockersRead(
          {
            chain: chainSource,
            audit,
            indexer,
            dex,
            health: {
              status: 'ok',
              data: {
                relayEnabled: deps.relayEnabled(),
                factoryConfigured: !isZeroAddress(chain.config.factory) && !isZeroAddress(chain.config.implementation),
              },
            },
            sessionPolicy: refusedBy ? { refusedBy: refusedBy.slice(0, refusedBy.indexOf('(')) } : null,
          },
          new Date().toISOString(),
        );
      }),

    /** The owner-published network registry. A field the owner has not published is null, never filled in. */
    networks: router({
      list: publicProcedure.output(protocolNetworksListOutputSchema).query(() => {
        try {
          return { networks: (deps.loadNetworks ?? loadNetworkRegistry)() };
        } catch (err) {
          throw new TRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message:
              err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'protocol.network_registry_unavailable',
            cause: err,
          });
        }
      }),
    }),

    /**
     * The Protocol ops desk reads: founder metrics and the compliance label audit. The hide, delist and restore writes
     * live in svc-ops, which consumes identity's four-eyes approval; this plane holds no platform credential.
     */
    ops: router({
      metrics: scopedProcedure('admin:read', { module: 'protocol', plane: 'protocol' })
        .input(protocolOpsMetricsInputSchema.default({}))
        .output(protocolOpsMetricsOutputSchema)
        .query(async ({ input, ctx }) => {
          const windowSeconds = input.windowSeconds ?? deps.opsWindowSeconds?.();
          if (windowSeconds === undefined) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'owner.decision: the owner has not published a metrics window.' });
          }
          const region = typeof ctx.region === 'string' ? ctx.region : undefined;
          const [indexer, dex, reachable] = await Promise.all([
            peers.indexer(region),
            peers.dex(region),
            chain
              .status()
              .then((status) => status.reachable)
              .catch(() => null),
          ]);
          return buildMetrics({ now: new Date(), windowSeconds, indexer, dex, chainReachable: reachable });
        }),

      labels: scopedProcedure('admin:compliance', { module: 'protocol', plane: 'protocol' })
        .output(protocolOpsLabelsOutputSchema)
        .query(async () => {
          const audit = await loadInternalSmartAccountsPackage();
          return labelsOutput(
            serviceLabelEntries({ networks: loadNetworkRegistry(), configuredChainId: chain.config.chainId, audit }),
            new Date(),
          );
        }),
    }),

    /** The deployed-contract registry and router versions for a chain. A chain with no recorded deployment is NOT_FOUND. */
    deployments: router({
      list: publicProcedure
        .input(protocolDeploymentsInputSchema)
        .output(protocolDeploymentsOutputSchema)
        .query(({ input }) => {
          let found;
          try {
            found = deploymentsFor(input.chainId);
          } catch (err) {
            throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'protocol.deployments_unavailable', cause: err });
          }
          if (!found) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `protocol.deployments_unknown_chain: no deployment is recorded for chain ${input.chainId}.`,
            });
          }
          return found;
        }),
    }),

    /** What the node and bundler can do, measured. Only the configured chain is probed; any other chain id reports nothing probed. */
    capabilities: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolCapabilitiesInputSchema)
      .output(protocolCapabilitiesOutputSchema)
      .query(async ({ input }) => {
        if (input.chainId !== chain.config.chainId) {
          return {
            chainId: input.chainId,
            probed: false,
            pendingTag: null,
            bundlerReachable: null,
            paymasterFunded: null,
            preconfirmations: 'unknown' as const,
          };
        }
        const probe = await chain.probeCapabilities(deps.probeTimeoutMs?.());
        return {
          chainId: input.chainId,
          probed: true,
          ...probe,
          // A plain node offers no preconfirmation feed to find; the room says "not offered on this network".
          preconfirmations: probe.pendingTag === null ? ('unknown' as const) : ('not_offered' as const),
        };
      }),

    /**
     * The address a key will own, before anything is deployed. Permissionless:
     * this is arithmetic over public constants, and gating it would be theatre.
     * Refuses when factory/impl are still the zero-address defaults.
     */
    predictAddress: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ owner: addressSchema, userSalt: bytes32Schema.default(DEFAULT_USER_SALT) }))
      .output(
        z.object({
          address: z.string(),
          chainId: z.number(),
          factory: z.string(),
          implementation: z.string(),
          deployed: z.boolean(),
        }),
      )
      .query(async ({ input }) => {
        requireAccountFactoryConfigured(chain.config.factory, chain.config.implementation);
        try {
          const address = computeAccountAddress({
            factory: chain.config.factory,
            implementation: chain.config.implementation,
            owner: input.owner as Address,
            userSalt: input.userSalt as Hex,
          });
          return {
            address,
            chainId: chain.config.chainId,
            factory: chain.config.factory,
            implementation: chain.config.implementation,
            deployed: await chain.isDeployed(address),
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** Unsigned calldata for deployment. The user signs it; anyone may send it. */
    buildDeployment: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ owner: addressSchema, userSalt: bytes32Schema.default(DEFAULT_USER_SALT) }))
      .output(unsignedCallOutput.extend({ predictedAddress: z.string() }))
      .query(({ input }) => {
        requireAccountFactoryConfigured(chain.config.factory, chain.config.implementation);
        const call = relay.buildDeployment(input.owner as Address, input.userSalt as Hex);
        return {
          to: call.to,
          data: call.data,
          value: call.value.toString(),
          summary: call.summary,
          predictedAddress: computeAccountAddress({
            factory: chain.config.factory,
            implementation: chain.config.implementation,
            owner: input.owner as Address,
            userSalt: input.userSalt as Hex,
          }),
        };
      }),

    /**
     * Validate a session scope and return the calldata that grants it.
     *
     * Nothing is granted here. A scope that the contract would refuse is
     * rejected before it ever becomes something to sign — including, always,
     * any scope carrying withdrawal power.
     */
    buildSessionGrant: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ account: addressSchema, spec: sessionSpecInputSchema }))
      .output(unsignedCallOutput.extend({ specHash: z.string(), validUntil: z.number() }))
      .query(({ input }) => {
        try {
          const spec = createSessionSpec(input.spec, {
            account: input.account as Address,
            now: Math.floor(Date.now() / 1000),
          });
          const call = relay.buildSessionGrant(input.account as Address, spec);
          return {
            to: call.to,
            data: call.data,
            value: call.value.toString(),
            summary: call.summary,
            specHash: call.specHash,
            validUntil: spec.validUntil,
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    buildSessionRevoke: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ account: addressSchema, sessionKey: addressSchema }))
      .output(unsignedCallOutput)
      .query(({ input }) => {
        const call = relay.buildSessionRevoke(input.account as Address, input.sessionKey as Address);
        return { to: call.to, data: call.data, value: call.value.toString(), summary: call.summary };
      }),

    /** The panic button. One call, every session dead. Owner only, on chain. */
    buildRevokeAllSessions: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ account: addressSchema }))
      .output(unsignedCallOutput)
      .query(({ input }) => {
        const call = relay.buildRevokeAllSessions(input.account as Address);
        return { to: call.to, data: call.data, value: call.value.toString(), summary: call.summary };
      }),

    /**
     * On-chain session state. The chain answers; we only relay the question.
     *
     * ── Why this reads the account's code first ──────────────────────────────
     *
     * `exists: false` is a claim about what the owner granted. It must only ever
     * be returned when a deployed account was actually asked and answered "no
     * session for that key". Two other situations produce the same *shape* and
     * mean something completely different:
     *
     *   · the account is not deployed — nobody has granted anything because
     *     there is nothing to grant on
     *   · the chain is unreachable — nobody looked
     *
     * Both of those now refuse. Reporting either as `exists: false, live: false`
     * would tell a user their agent's permissions are absent when the truth is
     * unknown, and a user who believes that will not go looking for the session
     * that is in fact live. `isDeployed` costs one `eth_getCode` and is what
     * makes the negative answer trustworthy.
     */
    sessionStatus: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ account: addressSchema, sessionKey: addressSchema }))
      .output(
        z.object({
          exists: z.boolean(),
          live: z.boolean(),
          specHash: z.string().nullable(),
          validAfter: z.number().nullable(),
          validUntil: z.number().nullable(),
          /** Cumulative native value moved under this session, in wei. */
          spentWei: z.string().nullable(),
          revoked: z.boolean().nullable(),
        }),
      )
      .query(async ({ input }) => {
        try {
          const account = input.account as Address;

          if (!(await chain.isDeployed(account))) {
            throw new ChainUnavailableError(
              'protocol.contract_not_deployed',
              `${account} holds no contract code on chain ${chain.config.chainId}, so it has granted no sessions ` +
                `and cannot be asked about one. This is not the same as having no session.`,
            );
          }

          const record = await chain.sessionOf(account, input.sessionKey as Address);
          if (!record) {
            return {
              exists: false,
              live: false,
              specHash: null,
              validAfter: null,
              validUntil: null,
              spentWei: null,
              revoked: null,
            };
          }
          return {
            exists: true,
            live: await chain.isSessionLive(account, input.sessionKey as Address),
            specHash: record.specHash,
            validAfter: record.validAfter,
            validUntil: record.validUntil,
            spentWei: record.spentWei.toString(),
            revoked: record.revoked,
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Would this call be allowed under this session? Answered without gas, by
     * the same rules the contract applies. Used by agents (§19) before acting.
     */
    checkSessionCall: publicJurisdictionProcedure('protocol', 'protocol')
      .input(
        z.object({
          account: addressSchema,
          spec: sessionSpecInputSchema,
          target: addressSchema,
          value: z.string().regex(/^\d+$/).default('0'),
          data: hexSchema,
          spentWei: z.string().regex(/^\d+$/).default('0'),
        }),
      )
      .output(z.object({ allowed: z.boolean(), code: z.string(), reason: z.string(), spentAfterWei: z.string() }))
      .query(async ({ input }) => {
        try {
          const now = Math.floor(Date.now() / 1000);
          const spec = createSessionSpec(input.spec, { account: input.account as Address, now });
          const data = input.data as Hex;
          const swap = readSwapExactInCall(data);
          let swapBound: { quoteOut: bigint; slippageBps: number } | undefined;
          if (swap && swap !== 'truncated') {
            // Blank config refuses before the quote and before any call is blessed.
            const slippageBps = requireSwapSlippageBps(deps.swapSlippageBps());
            const pool = swap.kind === 'router' ? swap.pool : (input.target as Address);
            const quoted = await freshPoolQuote(chain, pool, swap.tokenIn, swap.amountIn);
            swapBound = { quoteOut: quoted.amountOut, slippageBps };
          }
          const decision = evaluateSessionCall({
            spec,
            account: input.account as Address,
            target: input.target as Address,
            value: BigInt(input.value),
            data,
            spentWei: BigInt(input.spentWei),
            now,
            ...(swapBound ? { swapBound } : {}),
          });
          return { ...decision, spentAfterWei: decision.spentAfterWei.toString() };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** The hash a user is really signing when they grant a session. */
    sessionSpecHash: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ account: addressSchema, spec: sessionSpecInputSchema }))
      .output(z.object({ specHash: z.string() }))
      .query(({ input }) => {
        try {
          const spec = createSessionSpec(input.spec, {
            account: input.account as Address,
            now: Math.floor(Date.now() / 1000),
          });
          return { specHash: hashSessionSpec(spec) };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Forward an operation the user already signed.
     *
     * `relay.submit` re-derives the operation hash and refuses anything whose
     * signature is not the owner's, or a live session key's. The service is a
     * courier here and the verification is what proves it.
     */
    relayUserOperation: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ account: addressSchema, userOp: userOperationSchema }))
      .output(z.object({ userOpHash: z.string(), authority: z.enum(['owner', 'session']) }))
      .mutation(async ({ input }) => {
        requireRelayEnabled();
        try {
          return await relay.submit(toUserOperation(input.userOp), input.account as Address);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Contract ownership proof (D-launch-listing-01). Public: the token's owner may be signed out. A challenge is a fresh
     * one-time message; a proof is stored only when the token's on-chain owner signed it.
     */
    listing: router({
      ownershipChallenge: publicJurisdictionProcedure('protocol', 'protocol')
        .input(protocolListingChallengeInputSchema)
        .output(protocolListingChallengeOutputSchema)
        .mutation(async ({ input }) => {
          try {
            const l = deps.listing;
            if (!l) throw new ListingRefusedError(LISTING_CHALLENGE_TTL_UNSET, 'Ownership proofs are not wired on this service.');
            const now = l.now?.() ?? new Date();
            const c = await issueChallenge(l.store, listingChain(), l.ttlSeconds(), input.token as Address, now);
            return {
              nonce: c.nonce,
              token: c.token,
              chainId: c.chainId,
              message: c.message,
              issuedAt: c.issuedAt.toISOString(),
              expiresAt: c.expiresAt.toISOString(),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
      verifyOwnership: publicJurisdictionProcedure('protocol', 'protocol')
        .input(protocolListingVerifyInputSchema)
        .output(protocolListingVerifyOutputSchema)
        .mutation(async ({ input }) => {
          try {
            const l = deps.listing;
            if (!l) throw new ListingRefusedError(LISTING_CHALLENGE_TTL_UNSET, 'Ownership proofs are not wired on this service.');
            const proof = await verifyOwnership(
              l.store,
              listingChain(),
              { nonce: input.nonce, signature: input.signature as Hex },
              l.now?.() ?? new Date(),
            );
            return {
              token: proof.token,
              signer: proof.signer,
              blockNumber: proof.blockNumber.toString(),
              verifiedAt: proof.verifiedAt.toISOString(),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    /**
     * The representation a wallet signs once per version before its first signing action. Public like the rest of this
     * plane: the visitor may be signed out. `accept` writes only on proof that the address signed `status.message`.
     */
    representation: router({
      status: publicJurisdictionProcedure('protocol', 'protocol')
        .input(protocolRepresentationStatusInputSchema)
        .output(protocolRepresentationStatusOutputSchema)
        .query(async ({ input }) => {
          try {
            const r = deps.representation;
            const status = await representationStatus(
              r?.store ?? unwiredRepresentationStore,
              r?.setting() ?? null,
              chain.config.chainId,
              input.address as Address,
            );
            return { ...status, acceptedAt: status.acceptedAt?.toISOString() ?? null };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
      accept: publicJurisdictionProcedure('protocol', 'protocol')
        .input(protocolRepresentationAcceptInputSchema)
        .output(protocolRepresentationAcceptOutputSchema)
        .mutation(async ({ input }) => {
          try {
            const r = deps.representation;
            const record = await acceptRepresentation(r?.store ?? unwiredRepresentationStore, r?.setting() ?? null, chain.config.chainId, {
              address: input.address as Address,
              version: input.version,
              signature: input.signature as Hex,
            });
            return { address: record.address, version: record.version, acceptedAt: record.acceptedAt.toISOString() };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    // ── Founding badge (RC-more-catalogue-04) ─────────────────────────────
    // Account = signed principal; address = that account's own registered smart account. Never a body field.
    badge: router({
      eligibility: scopedProcedure('protocol:read', { module: 'protocol', plane: 'protocol' })
        .output(protocolBadgeEligibilityOutputSchema)
        .query(async ({ ctx }) => {
          try {
            const b = deps.badge;
            if (!b) throw new BadgeRefusedError(BADGE_WINDOW_UNSET, 'founding badge is not wired on this service');
            return await badgeEligibility(
              { store: b.store, minter: b.minter, window: b.window(), now: b.now ?? (() => new Date()) },
              ctx.principal.userId,
              { chainId: chain.config.chainId, mainnet: b.mainnet() },
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
      // `protocol:read` like claimAccount: no platform scope authorises on this plane (no protocol:write by design).
      // What authorises the claim is the owner key's signature over `badgeClaimMessage`, verified in `claimBadge`.
      claim: scopedProcedure('protocol:read', { module: 'protocol', plane: 'protocol' })
        .input(z.object({ signature: hexSchema.optional() }).optional())
        .output(protocolBadgeClaimOutputSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            const b = deps.badge;
            if (!b) throw new BadgeRefusedError(RAIL_CRYPTO, `no signer configured for chain ${chain.config.chainId}`);
            const [own] = await registry.accountsOf(ctx.principal.userId, 1);
            const r = await claimBadge(
              { store: b.store, minter: b.minter, window: b.window(), now: b.now ?? (() => new Date()) },
              ctx.principal.userId,
              own ? { address: own.address, owner: own.owner } : null,
              { chainId: chain.config.chainId, mainnet: b.mainnet() },
              input?.signature ?? null,
            );
            return {
              key: r.key,
              chainId: r.chainId,
              to: r.to,
              txHash: r.txHash,
              label: r.label,
              audited: r.audited,
              mintingSince: r.txHash ? null : (r.mintingSince?.toISOString() ?? null),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
      // Operator-only: clear a mint slot stuck after a crash mid-mint. `admin:write` on the protocol plane, plus a
      // four-eyes svc-identity approval bound to the exact payload; the audit row is written with the clear.
      resolveStuckMint: scopedProcedure('admin:write', { module: 'protocol', plane: 'protocol' })
        .input(
          z
            .object({
              accountId: z.string().guid(),
              evidence: z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('minted'), txHash: hexSchema }).strict(),
                z.object({ kind: z.literal('not_minted'), attestedBy: z.string().max(128), checkedAt: z.string().datetime() }).strict(),
              ]),
              reason: z.string().max(500),
              approvalId: z.string().max(128),
              operationId: z.string().max(128),
            })
            .strict(),
        )
        .output(z.object({ cleared: z.boolean(), key: z.string(), txHash: hexSchema.nullable() }))
        .mutation(async ({ ctx, input }) => {
          try {
            const b = deps.badge;
            if (!b) throw new BadgeRefusedError(BADGE_STUCK_APPROVAL_UNWIRED, 'founding badge is not wired on this service');
            const evidence =
              input.evidence.kind === 'minted'
                ? { kind: 'minted' as const, txHash: input.evidence.txHash as `0x${string}` }
                : { kind: 'not_minted' as const, attestedBy: input.evidence.attestedBy, checkedAt: new Date(input.evidence.checkedAt) };
            const r = await resolveStuckBadgeMint(
              {
                store: b.store,
                approvals: b.approvals ?? null,
                staleAfterSeconds: b.stuckMintAgeSeconds?.(),
                now: b.now ?? (() => new Date()),
              },
              {
                accountId: input.accountId,
                evidence,
                reason: input.reason,
                actorId: ctx.principal.userId,
                approvalId: input.approvalId,
                operationId: input.operationId,
              },
            );
            return { cleared: r !== null, key: badgeClaimKey(input.accountId), txHash: r?.txHash ?? null };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    // ── Registry (a read model, not custody) ──────────────────────────────

    /** The message to sign to link an account. It authorises nothing. */
    bindingMessage: scopedProcedure('protocol:read', { module: 'protocol', plane: 'protocol' })
      .input(z.object({ address: addressSchema }))
      .output(z.object({ message: z.string() }))
      .query(({ ctx, input }) => ({
        message: bindingMessage({
          userId: ctx.principal.userId,
          chainId: chain.config.chainId,
          address: input.address as Address,
        }),
      })),

    claimAccount: scopedProcedure('protocol:read', { module: 'protocol', plane: 'protocol' })
      .input(
        z.object({
          owner: addressSchema,
          address: addressSchema,
          userSalt: bytes32Schema.default(DEFAULT_USER_SALT),
          signature: hexSchema,
        }),
      )
      .output(z.object({ id: z.string(), address: z.string(), owner: z.string(), deployed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          const record = await registry.claim({
            userId: ctx.principal.userId,
            owner: input.owner as Address,
            userSalt: input.userSalt as Hex,
            address: input.address as Address,
            signature: input.signature as Hex,
            deployed: await chain.isDeployed(input.address as Address),
          });
          return { id: record.id, address: record.address, owner: record.owner, deployed: record.deployed };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    myAccounts: scopedProcedure('protocol:read', { module: 'protocol', plane: 'protocol' })
      /**
       * `limit` is optional so omit reaches `protocol.my_accounts_list_limit_unset`
       * instead of a Zod "Required". Blank is not 50; pass 50 explicitly when that
       * is the page you want.
       */
      .input(z.object({ limit: z.number().int().min(1).max(MY_ACCOUNTS_LIST_LIMIT_CAP).optional() }).optional())
      .output(z.array(z.object({ id: z.string(), address: z.string(), owner: z.string(), deployed: z.boolean() })))
      .query(async ({ ctx, input }) => {
        try {
          const limit = assertMyAccountsListLimit(input?.limit);
          const records = await registry.accountsOf(ctx.principal.userId, limit);
          return records.map((r) => ({ id: r.id, address: r.address, owner: r.owner, deployed: r.deployed }));
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * AMM (`protocol.amm`) — constant-product pools on the Protocol Plane.
     *
     * Permissionless quotes and unsigned calldata only. The platform never
     * holds LP keys and never posts to the ledger here.
     */
    tokens: createTokensRouter({
      chain: tokenLogsChain(
        chain,
        () => chain.client,
        () => chain.config.rpcUrl,
      ),
      factory: () => deps.ammFactoryAddress(),
      quoteToken: () => deps.tokensQuoteToken?.() ?? null,
      toTrpcError,
    }),

    amm: router({
      ...createPoolFeesProcedures({
        chain: poolFeesChain(
          () => chain.client,
          () => chain.config.rpcUrl,
          () => chain.headBlock(),
        ),
        factory: () => deps.ammFactoryAddress(),
        toTrpcError,
      }),
      /**
       * PURE MATH OVER RESERVES THE CALLER SUPPLIES. Not a market quote.
       *
       * Read the input list: `reserveIn` and `reserveOut` are parameters. This
       * procedure does not know which pool they came from, whether such a pool
       * exists, or how old they are. It is `getAmountOut` behind a network hop —
       * useful for a client that already holds a reserve snapshot and wants the
       * exact figure the contract would compute, and useless as a price.
       *
       * `quoteFromPool` is the one that sources its own reserves from the chain,
       * and it is what a product surface must call. This one is kept because a
       * caller that has reserves from elsewhere should not have to re-implement
       * the rounding — the whole point of mirroring
       * `ConstantProductPool._getAmountOut` is that there is exactly one
       * implementation of it.
       */
      quoteExactIn: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            amountIn: z.string().regex(/^\d+$/),
            reserveIn: z.string().regex(/^\d+$/),
            reserveOut: z.string().regex(/^\d+$/),
            feeBps: z
              .number({ error: (issue) => (issue.input === undefined ? 'feeBps is unset — will not invent 30 bps' : undefined) })
              .int()
              .min(0)
              .max(1000),
          }),
        )
        .output(
          z.object({
            amountOut: z.string(),
            priceImpactBps: z.number().int(),
            /** Always false here. The caller supplied the reserves; no chain was read. */
            reservesFromChain: z.literal(false),
          }),
        )
        .query(({ input }) => {
          try {
            const q = quoteExactIn({
              amountIn: BigInt(input.amountIn),
              reserveIn: BigInt(input.reserveIn),
              reserveOut: BigInt(input.reserveOut),
              feeBps: input.feeBps,
            });
            return { amountOut: q.amountOut.toString(), priceImpactBps: q.priceImpactBps, reservesFromChain: false as const };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Every pool the configured factory lists and the tokens they trade, read from the chain (D-swap-01). An unset
       * factory refuses by name; an unreadable chain refuses `protocol.chain_unreachable`. Never a list from config.
       */
      pairs: publicJurisdictionProcedure('protocol', 'protocol')
        .output(protocolSwapPairsOutputSchema)
        .query(async () => {
          const factory = deps.ammFactoryAddress();
          if (isZeroAddress(factory))
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
            });
          try {
            return await readPairs(factory);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Every listed token's USD price from the pools, at one block, with the block's own time (D-swap-11). A pool under
       * the owner's minimum reserve gives no price; blank settings refuse before any read.
       */
      prices: publicJurisdictionProcedure('protocol', 'protocol')
        .output(protocolTokenPricesOutputSchema)
        .query(async () => {
          const setting = deps.priceSetting?.() ?? null;
          if (!setting)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `${PRICE_SETTINGS_UNSET}: PROTOCOL_PRICE_USD_TOKENS and PROTOCOL_PRICE_MIN_RESERVE_USD are owner settings; refuse rather than invent a reference or a minimum.`,
            });
          const factory = deps.ammFactoryAddress();
          if (isZeroAddress(factory))
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
            });
          try {
            const pairs = await readPairs(factory);
            const asOf = await timeOfBlock(pairs.blockNumber);
            return { blockNumber: pairs.blockNumber, asOf: asOf.toISOString(), prices: priceTokens(pairs, setting) };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** The owner's swap settings: the slippage ceiling, the quote lifetime and the confirmations. Blank refuses. */
      swapSettings: publicJurisdictionProcedure('protocol', 'protocol')
        .output(protocolSwapSettingsOutputSchema)
        .query(() => {
          try {
            const slippageCeilingBps = requireSwapSlippageBps(deps.swapSlippageBps());
            const quoteTtlSeconds = deps.swapQuoteTtlSeconds?.() ?? null;
            const confirmations = deps.swapConfirmations?.() ?? null;
            if (quoteTtlSeconds === null || confirmations === null)
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `${SWAP_SETTINGS_UNSET}: PROTOCOL_SWAP_QUOTE_TTL_SECONDS and PROTOCOL_SWAP_CONFIRMATIONS are owner settings; refuse rather than invent them.`,
              });
            return { slippageCeilingBps, quoteTtlSeconds, confirmations };
          } catch (err) {
            throw err instanceof TRPCError ? err : toTrpcError(err);
          }
        }),

      /**
       * The swap form's network fee levels (D-swap-11): Slow, Normal and Fast are the owner percentiles of the last N
       * blocks' priority fees, on top of the next block's base fee, with the owner's fee cap. Both owner settings are
       * checked before the node is asked; a blank one refuses by name. No paymaster is wired, so `sponsored` is false.
       */
      feeLevels: publicJurisdictionProcedure('protocol', 'protocol')
        .output(protocolSwapFeesOutputSchema)
        .query(async () => {
          try {
            const cap = requireFeeCapWei(deps.swapFeeCapWei?.());
            const setting = deps.gasPercentiles?.() ?? null;
            if (!setting) throw new GasPercentilesUnsetError();
            return feeLevels(await chain.gasPrice(setting, deps.now?.() ?? new Date()), cap);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * The live allowances `owner` has given for the tokens the factory's pools trade (D-swap-09), read at one block:
       * each listed pool and each spender in the owner's recent Approval logs, kept only when `allowance()` is above zero.
       * Allowances are public chain data, so the address asked about is the scope and no session is needed.
       */
      allowances: publicJurisdictionProcedure('protocol', 'protocol')
        .input(z.object({ owner: addressSchema }))
        .output(protocolAllowancesOutputSchema)
        .query(async ({ input }) => {
          const factory = deps.ammFactoryAddress();
          if (isZeroAddress(factory))
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
            });
          try {
            return await listAllowances(chain, await readPairs(factory), input.owner as Address);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** Live reserves, oriented by the pool's own `token0`. Refuses if it cannot read them. */
      poolReserves: publicJurisdictionProcedure('protocol', 'protocol')
        .input(z.object({ pool: addressSchema }))
        .output(
          z.object({
            pool: z.string(),
            token0: z.string(),
            reserve0: z.string(),
            reserve1: z.string(),
            feeBps: z.number().int(),
            blockTimestampLast: z.number().int(),
          }),
        )
        .query(async ({ input }) => {
          try {
            const pool = input.pool as Address;
            const [reserves, token0, feeBps] = await Promise.all([
              chain.poolReserves(pool),
              chain.poolToken0(pool),
              chain.poolFeeBps(pool),
            ]);
            return {
              pool,
              token0,
              reserve0: reserves.reserve0.toString(),
              reserve1: reserves.reserve1.toString(),
              feeBps,
              blockTimestampLast: reserves.blockTimestampLast,
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * THE REAL QUOTE — reserves read from the pool, not accepted from the caller.
       *
       * This is the procedure that makes the AMM math reachable. It reads
       * `getReserves`, `token0` and `feeBps` from the pool, orients the reserves
       * against `tokenIn`, and applies the same `getAmountOut` the contract will.
       * Nothing is defaulted: if the chain cannot be read the call refuses with
       * `protocol.chain_unreachable`, and if the address holds no code it refuses
       * with `protocol.contract_not_deployed`.
       *
       * It refuses in this environment, every time, because there is no chain
       * (SOCKET §13 `socket.evm-rpc`). That is the honest state of
       * `protocol.amm` and it is why the tracker keeps it blocked.
       *
       * Two limits worth stating rather than discovering:
       *   · `blockTimestampLast` is the pool's own last-touch time, NOT the head
       *     block's. It cannot bound how stale this quote is. Measuring that
       *     needs the head block timestamp, which is a second read.
       *   · the three reads are concurrent but not atomic. `token0` and `feeBps`
       *     are immutable so they cannot skew; reserves are a single call, so a
       *     quote is consistent with one observation even though it is not
       *     pinned to a block. Pinning needs an explicit `blockNumber` argument.
       */
      quoteFromPool: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            pool: addressSchema,
            tokenIn: addressSchema,
            amountIn: z.string().regex(/^\d+$/),
          }),
        )
        .output(
          z.object({
            amountOut: z.string(),
            priceImpactBps: z.number().int(),
            reserveIn: z.string(),
            reserveOut: z.string(),
            feeBps: z.number().int(),
            /** Always true here — that is the difference from `quoteExactIn`. */
            reservesFromChain: z.literal(true),
            blockTimestampLast: z.number().int(),
          }),
        )
        .query(async ({ input }) => {
          try {
            const pool = input.pool as Address;
            /**
             * `token1` is read so an unrecognised token cannot be treated as
             * token1. That would be a fabricated price for a pair the pool
             * does not trade. `freshPoolQuote` names the mismatch.
             */
            const quoted = await freshPoolQuote(chain, pool, toChecksum(input.tokenIn), BigInt(input.amountIn));
            return {
              amountOut: quoted.amountOut.toString(),
              priceImpactBps: quoted.priceImpactBps,
              reserveIn: quoted.reserveIn.toString(),
              reserveOut: quoted.reserveOut.toString(),
              feeBps: quoted.feeBps,
              reservesFromChain: true as const,
              blockTimestampLast: quoted.blockTimestampLast,
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      buildCreatePool: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            tokenA: addressSchema,
            tokenB: addressSchema,
            feeBps: z
              .number({ error: (issue) => (issue.input === undefined ? 'feeBps is unset — will not invent 30 bps' : undefined) })
              .int()
              .min(0)
              .max(1000),
          }),
        )
        .output(unsignedCallOutput)
        .query(({ input }) => {
          const factory = deps.ammFactoryAddress();
          if (isZeroAddress(factory)) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS). Contracts are in-repo under contracts/amm/.',
            });
          }
          const call = buildCreatePool(factory, input.tokenA as Address, input.tokenB as Address, input.feeBps);
          return { to: call.to, data: call.data, value: call.value, summary: call.summary };
        }),

      buildSwapExactIn: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            pool: addressSchema,
            tokenIn: addressSchema,
            amountIn: z.string().regex(/^\d+$/),
            minAmountOut: z.string().regex(/^\d+$/),
            to: addressSchema,
          }),
        )
        .output(unsignedCallOutput)
        .query(async ({ input }) => {
          try {
            // Config first: a blank tolerance refuses before the quote and
            // before `buildSwapExactIn` encodes anything.
            const slippageBps = requireSwapSlippageBps(deps.swapSlippageBps());
            const pool = input.pool as Address;
            const tokenIn = toChecksum(input.tokenIn);
            const amountIn = BigInt(input.amountIn);
            const minAmountOut = BigInt(input.minAmountOut);
            const quoted = await freshPoolQuote(chain, pool, tokenIn, amountIn);
            assertMinAmountOut(minAmountOut, quoted.amountOut, slippageBps);
            const call = buildSwapExactIn(pool, tokenIn, amountIn, minAmountOut, input.to as Address);
            return { to: call.to, data: call.data, value: call.value, summary: call.summary };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      buildMintLiquidity: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            pool: addressSchema,
            to: addressSchema,
            amount0Desired: z.string().regex(/^\d+$/),
            amount1Desired: z.string().regex(/^\d+$/),
          }),
        )
        .output(unsignedCallOutput)
        .query(({ input }) => {
          const call = buildMintLiquidity(
            input.pool as Address,
            input.to as Address,
            BigInt(input.amount0Desired),
            BigInt(input.amount1Desired),
          );
          return { to: call.to, data: call.data, value: call.value, summary: call.summary };
        }),

      /**
       * Does `spender` already hold enough allowance from `owner` for `amount` of `token`, and if not, which calls fix it?
       * Read at one pinned block, which the answer names. Exact amount unless `unlimited: true` is passed by name.
       */
      checkApproval: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            owner: addressSchema,
            token: addressSchema,
            spender: addressSchema,
            amount: approvalAmountSchema,
            unlimited: z.boolean().default(false),
          }),
        )
        .output(
          z.object({
            needsApproval: z.boolean(),
            resetFirst: z.boolean(),
            current: z.string(),
            blockNumber: z.string(),
            unlimited: z.boolean(),
            calls: z.array(unsignedCallOutput),
          }),
        )
        .query(async ({ input }) => {
          try {
            const [owner, token, spender] = [toChecksum(input.owner), toChecksum(input.token), toChecksum(input.spender)];
            requireApprovalTargets(token, spender);
            const amount = parseApprovalAmount(input.amount);
            const read = await chain.tokenAllowance(token, owner, spender);
            const directChangeReverts =
              read.value > 0n && read.value < amount ? await chain.directApproveReverts(token, owner, spender, amount) : false;
            const plan = planApproval({ token, spender, amount, current: read.value, unlimited: input.unlimited, directChangeReverts });
            return {
              needsApproval: plan.needsApproval,
              resetFirst: plan.resetFirst,
              current: read.value.toString(),
              blockNumber: read.blockNumber.toString(),
              unlimited: plan.needsApproval && input.unlimited,
              calls: plan.calls.map((call) => ({ to: call.to, data: call.data, value: call.value, summary: call.summary })),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** `approve(spender, amount)` for exactly `amount`; `unlimited: true` is the only way to ask for more. */
      buildApprove: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            token: addressSchema,
            spender: addressSchema,
            amount: approvalAmountSchema,
            unlimited: z.boolean().default(false),
          }),
        )
        .output(unsignedCallOutput)
        .query(({ input }) => {
          try {
            const [token, spender] = [toChecksum(input.token), toChecksum(input.spender)];
            requireApprovalTargets(token, spender);
            const call = buildApprove(token, spender, parseApprovalAmount(input.amount), input.unlimited);
            return { to: call.to, data: call.data, value: call.value, summary: call.summary };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** `approve(spender, 0)`. */
      buildRevoke: publicJurisdictionProcedure('protocol', 'protocol')
        .input(z.object({ token: addressSchema, spender: addressSchema }))
        .output(unsignedCallOutput)
        .query(({ input }) => {
          try {
            const [token, spender] = [toChecksum(input.token), toChecksum(input.spender)];
            requireApprovalTargets(token, spender);
            const call = buildRevoke(token, spender);
            return { to: call.to, data: call.data, value: call.value, summary: call.summary };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    /**
     * LAUNCH (`launch.token-factory`, §8.4) — ERC-20 deploy from an in-repo template.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * THE PRODUCT DECISIONS THIS SURFACE MAKES, STATED WHERE THEY LIVE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A token deploy is money-adjacent and irreversible, so the answers are
     * here rather than implied by the code:
     *
     *   · WHO MAY DEPLOY — anyone. Permissionless, `publicJurisdictionProcedure`,
     *     no login and no KYC tier, because §22 ties verification to custody and
     *     the platform holds nothing here. Note what that does NOT mean: the
     *     platform never originates the transaction. It builds bytes the creator
     *     signs, so "who may deploy" is really "whoever holds a key and can pay
     *     gas" — which is what permissionless means on this plane.
     *   · WHAT SUPPLY AND DECIMALS ARE PERMITTED — `launch/params.ts`. Decimals
     *     0–18; supply a decimal string of whole tokens, at most 10^20 − 1 so it
     *     stays representable in the ledger's `numeric(38,18)`.
     *   · WHETHER THE DEPLOYER KEEPS MINT AUTHORITY — no. Nobody does. The
     *     template has no mint function at all (`contracts/launch/SovereignToken.sol`).
     *     There is no flag on this API that can change that, deliberately.
     *
     * Nothing here posts to the ledger and nothing here holds a balance: a
     * launched token's supply lives in the creator's own contract on a public
     * chain, which is why §0.6 is not in play. A launch FEE would be — and it is
     * not charged here, by design.
     */
    launch: router({
      /**
       * Is a launch possible right now, and against what?
       *
       * A status procedure rather than a thrown refusal, for the same reason
       * `chainStatus` is: a product surface has to render "launching is not
       * available here" as a state. It reports the template's `sourceHash` so a
       * creator — or an auditor — can tie an address they were shown to the
       * exact bytes that produced it.
       */
      status: publicJurisdictionProcedure('protocol', 'protocol')
        .output(
          z.object({
            chainId: z.number(),
            factory: z.string(),
            /** Non-zero address configured. Says somebody set an env var. */
            configured: z.boolean(),
            /** READ FROM THE CHAIN: the factory holds contract code. */
            deployed: z.boolean(),
            /** Reachable AND deployed. The only field a UI should gate on. */
            usable: z.boolean(),
            refusalCode: z.string().nullable(),
            template: z.object({
              contractName: z.string(),
              /** sha256 over the compilation input — solc version, settings, sources. */
              sourceHash: z.string(),
              solcVersion: z.string(),
              evmVersion: z.string(),
              /**
               * FALSE, and it will stay false until somebody pays for an audit.
               * The tracker calls this feature "ERC-20 deploy from audited
               * templates"; compiler output is not an audit, and a creator
               * deserves to be told which one they are getting.
               */
              audited: z.literal(false),
            }),
            limits: z.object({
              maxDecimals: z.number(),
              maxNameBytes: z.number(),
              maxSymbolBytes: z.number(),
              /** Whole tokens, as a decimal string — never a number. */
              maxWholeSupply: z.string(),
            }),
            mintAuthorityRetained: z.literal(false),
          }),
        )
        .query(async () => {
          const template = templateArtifact();
          const status = await chain.status();
          return {
            chainId: chain.config.chainId,
            factory: chain.tokenFactory,
            configured: status.tokenFactoryConfigured,
            deployed: status.tokenFactoryDeployed,
            usable: status.reachable && status.tokenFactoryDeployed,
            refusalCode: status.refusalCode,
            template: {
              contractName: template.contractName,
              sourceHash: template.sourceHash,
              solcVersion: template.solcVersion,
              evmVersion: template.evmVersion,
              audited: loadInternalSmartAccountsPackage().audited,
            },
            limits: {
              maxDecimals: MAX_DECIMALS,
              maxNameBytes: MAX_NAME_BYTES,
              maxSymbolBytes: MAX_SYMBOL_BYTES,
              maxWholeSupply: MAX_WHOLE_SUPPLY.toString(),
            },
            mintAuthorityRetained: false as const,
          };
        }),

      /**
       * The address a token will have, before it exists.
       *
       * Refuses on an unconfigured factory before any arithmetic runs, and
       * reports `deployed` from a real `eth_getCode` rather than assuming. The
       * scaled supply comes back as a string so a caller can show a creator
       * exactly what will be minted without ever holding it as a number.
       */
      predictTokenAddress: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            creator: addressSchema,
            userSalt: bytes32Schema.default(DEFAULT_TOKEN_SALT),
            params: tokenParamsInputSchema,
          }),
        )
        .output(
          z.object({
            address: z.string(),
            chainId: z.number(),
            factory: z.string(),
            /** Base units, scaled by `decimals`. A string on the wire, always. */
            scaledTotalSupply: z.string(),
            /** READ FROM THE CHAIN. A predicted address normally has no code. */
            deployed: z.boolean(),
            templateSourceHash: z.string(),
          }),
        )
        .query(async ({ input }) => {
          requireTokenFactoryConfigured(chain.tokenFactory);
          try {
            const params = parseTokenParams({ ...input.params, recipient: input.params.recipient as Address });
            const address = computeTokenAddress({
              factory: chain.tokenFactory,
              creator: input.creator as Address,
              userSalt: input.userSalt as Hex,
              params,
            });
            return {
              address,
              chainId: chain.config.chainId,
              factory: chain.tokenFactory,
              scaledTotalSupply: params.totalSupply.toString(),
              deployed: await chain.isDeployed(address),
              templateSourceHash: templateArtifact().sourceHash,
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Unsigned calldata for the launch. The creator signs it; anyone may send it.
       *
       * Reads nothing, so it answers with the chain down — the same bargain
       * `buildDeployment` makes. The bytes are valid whenever the factory
       * address is, and a creator can hold them.
       */
      buildTokenDeployment: publicJurisdictionProcedure('protocol', 'protocol')
        .input(
          z.object({
            creator: addressSchema,
            userSalt: bytes32Schema.default(DEFAULT_TOKEN_SALT),
            params: tokenParamsInputSchema,
          }),
        )
        .output(unsignedCallOutput.extend({ predictedAddress: z.string(), scaledTotalSupply: z.string() }))
        .query(({ input }) => {
          requireTokenFactoryConfigured(chain.tokenFactory);
          try {
            const params = parseTokenParams({ ...input.params, recipient: input.params.recipient as Address });
            const predictedAddress = computeTokenAddress({
              factory: chain.tokenFactory,
              creator: input.creator as Address,
              userSalt: input.userSalt as Hex,
              params,
            });
            const call = buildCreateToken(chain.tokenFactory, input.userSalt as Hex, params, predictedAddress);
            return {
              to: call.to,
              data: call.data,
              value: call.value.toString(),
              summary: call.summary,
              predictedAddress,
              scaledTotalSupply: params.totalSupply.toString(),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * What a launched token says about itself, plus its provenance.
       *
       * Every field is read from the chain. `creator` is `null` when the token
       * did not come from our factory — unknown provenance, which is the honest
       * answer and the one §35 (deployer reputation) needs. Reporting `0x0`
       * there would be an address that looks like an answer.
       *
       * Refuses rather than returning empty metadata when the address holds no
       * code: `name: ""` for a token nobody deployed is the fabrication this
       * whole surface exists to avoid.
       */
      tokenInfo: publicJurisdictionProcedure('protocol', 'protocol')
        .input(z.object({ token: addressSchema }))
        .output(
          z.object({
            token: z.string(),
            name: z.string(),
            symbol: z.string(),
            decimals: z.number().int(),
            /** Base units. String on the wire — see the doctrine on money in a `number`. */
            totalSupply: z.string(),
            initialHolder: z.string(),
            /** Null = not launched through this factory. Not the zero address. */
            creator: z.string().nullable(),
            fromThisFactory: z.boolean(),
            /**
             * The deployed runtime IS the compiled template, once the
             * constructor-written `immutable` values are masked out.
             *
             * Read, not assumed. `fromThisFactory` says our factory recorded
             * the creator; this says the code at the address really is the
             * template — the check that catches a factory whose recorded
             * provenance no longer matches what it deploys.
             *
             * The masking is not a loosening. See `deployedCodeMatches`: a
             * byte-identical comparison is FALSE for every correct deployment,
             * because `decimals`, `totalSupply` and `initialHolder` are spliced
             * into the runtime at construction.
             */
            matchesTemplate: z.boolean(),
          }),
        )
        .query(async ({ input }) => {
          try {
            const token = input.token as Address;

            // `isDeployed` first, for the reason `sessionStatus` reads it
            // first: an ERC-20 read against an address with no code is a decode
            // failure, and it must never be flattened into empty metadata.
            if (!(await chain.isDeployed(token))) {
              throw new ChainUnavailableError(
                'protocol.contract_not_deployed',
                `${token} holds no contract code on chain ${chain.config.chainId}, so there is no token there to describe. ` +
                  `This is not a token with empty metadata.`,
              );
            }

            const metadata = await chain.tokenMetadata(token);
            // Provenance needs a factory to ask. With none configured the
            // answer is "unknown", which is exactly what `null` says — the
            // metadata above is still real and still worth returning.
            const creator = isZeroAddress(chain.tokenFactory) ? null : await chain.tokenCreator(token);
            const runtime = await chain.runtimeCode(token);

            return {
              token,
              name: metadata.name,
              symbol: metadata.symbol,
              decimals: metadata.decimals,
              totalSupply: metadata.totalSupply.toString(),
              initialHolder: metadata.initialHolder,
              creator,
              fromThisFactory: creator !== null,
              matchesTemplate: deployedCodeMatches(templateArtifact(), runtime),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),
  });
}

export type ProtocolRouter = ReturnType<typeof createProtocolRouter>;
