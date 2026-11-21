import { z } from 'zod';
import { getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import {
  protocolBlockersRead,
  router,
  TRPCError,
  type BlockerSource,
  PRICE_SETTINGS_UNSET,
  SWAP_SETTINGS_UNSET,
} from '@intafaced/contracts';
import {
  PROTOCOL_AMM_PAIRS,
  PROTOCOL_AMM_PRICES,
  PROTOCOL_AMM_SWAP_SETTINGS,
  PROTOCOL_AMM_FEE_LEVELS,
  PROTOCOL_AMM_FEE_TOKENS,
  PROTOCOL_AMM_FEE_QUOTE,
  PROTOCOL_AMM_PREPARE_FEE_SWAP,
  PROTOCOL_AMM_RELAY_FEE_SWAP,
  PROTOCOL_AMM_ALLOWANCES,
  PROTOCOL_AMM_ROUTES,
  PROTOCOL_AMM_QUOTE_FROM_POOL,
  PROTOCOL_AMM_BUILD_SWAP_EXACT_IN,
  PROTOCOL_AMM_CHECK_APPROVAL,
  PROTOCOL_AMM_BUILD_REVOKE,
} from '@intafaced/contracts/protocol-amm-procedures';
import { computeAccountAddress, AddressDerivationError } from './accounts/address.js';
import { createLiquidityProcedures } from './liquidity/procedures.js';
import type { ProtocolChain } from './chain/client.js';
import { ChainUnavailableError, CHAIN_PUBLIC_TEXT, classifyChainError, isZeroAddress } from './chain/availability.js';
import { GasPercentilesUnsetError, type GasPercentileSetting } from './chain/gas-price.js';
import { chainIdentityReader, type ChainIdentityReader } from './chain/identity.js';
import type { SessionRelay } from './session/relay.js';
import { createSessionSpec, FORBIDDEN_SELECTORS, sessionSpecFromWire, SessionScopeError } from './session/spec.js';
import { AmmMathError } from './amm/math.js';
import { freshPoolQuote, PoolTokenError } from './amm/pool-quote.js';
import { pairsReader } from './amm/pairs.js';
import { listAllowances } from './amm/allowances.js';
import { blockBalances, routeOptions } from './amm/routes.js';
import { feeLevels, requireFeeCapWei, SwapFeeError } from './amm/fee-levels.js';
import {
  feeRefusal,
  planFeeSwap,
  quoteFee,
  readFeeTokens,
  relayFeeSwap,
  requireFeeRelay,
  type FeeRelayChain,
  type FeeRelaySetting,
} from './amm/fee-relay.js';
import { priceTokens, type PriceSetting } from './amm/prices.js';
import { createTokensRouter } from './amm/tokens-router.js';
import { createPortfolioRouter } from './amm/portfolio-router.js';
import { portfolioChain } from './amm/portfolio.js';
import { contractChain, createContractSourceRouter, type ContractChain } from './contract-source/router.js';
import { createBridgeRouter } from './bridge/router.js';
import { bridgeRoutesLoader } from './bridge/routes.js';
import { createVenueFundsRouter } from './venue/router.js';
import { createLendingRouter } from './lending/position.js';
import { createWalletTxRouters } from './wallet-tx/router.js';
import { createEscrowRouter } from './escrow/router.js';
import type { ReplacementSetting } from './wallet-tx/replacement.js';
import { createPoolFeesProcedures, poolFeesChain } from './amm/pool-fees.js';
import { createSwapV2Procedures, type SwapV2Setting } from './amm/swap-v2.js';
import { tokenLogsChain } from './amm/token-reader.js';
import { assertMinAmountOut, requireSwapSlippageBps, SwapSlippageError } from './amm/slippage.js';
import { MAX_UINT256, buildRevoke, buildSwapExactIn, planApproval } from './amm/build.js';
import { loadInternalSmartAccountsPackage } from './audit/pipeline.js';
import { loadProductAudits } from './audit/products.js';
import {
  createAddressReportsRouter,
  createAddressRiskRouter,
  createComplianceRouter,
  type AddressRiskDeps,
  type ComplianceDeps,
} from './address-risk/router.js';
import type { AddressRiskStore } from './address-risk/risk.js';
import { listSessions } from './session/list.js';
import { protocolHealthHonesty } from './health-honesty.js';
import { mountProtocolRecord } from './record-mount.js';
import {
  PROTOCOL_AUDIT_PRODUCTS,
  PROTOCOL_AUDIT_STATUS,
  PROTOCOL_BLOCKERS,
  PROTOCOL_BUILD_REVOKE_ALL_SESSIONS,
  PROTOCOL_BUILD_SESSION_GRANT,
  PROTOCOL_BUILD_SESSION_REVOKE,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_CHAIN_STATUS,
  PROTOCOL_DEPLOYMENTS_LIST,
  PROTOCOL_GAS_PRICE,
  PROTOCOL_HEALTH,
  PROTOCOL_LISTING_OWNERSHIP_CHALLENGE,
  PROTOCOL_LISTING_VERIFY_OWNERSHIP,
  PROTOCOL_NETWORKS_LIST,
  PROTOCOL_PREDICT_ADDRESS,
  PROTOCOL_REPRESENTATION_ACCEPT,
  PROTOCOL_REPRESENTATION_STATUS,
  PROTOCOL_SESSIONS_LIST,
} from '@intafaced/contracts/protocol-procedures';
import { noPeers, type Peers } from './blockers/peers.js';
import { deploymentsFor, loadNetworkRegistry } from './networks/registry.js';
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
  createAddressBookRouter,
  createWalletSessionRouter,
  unwiredAddressBookStore,
  type AddressBookDeps,
} from './address-book/router.js';
import { createVenueWalletRouter, unwiredVenueConnectionStore } from './venue-wallet/router.js';
import type { VenueConnectionDeps } from './venue-wallet/connection.js';
import { createEmbeddedWalletRouter, unwiredEmbeddedWalletStore } from './embedded-wallet/router.js';
import type { EmbeddedWalletDeps } from './embedded-wallet/embedded.js';
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

/**
 * svc-protocol's API.
 *
 * Read the guards, not just the procedures. Almost everything here is
 * `publicJurisdictionProcedure` — no login, no KYC tier, no account gate. That
 * is §22 as code: this module is `custodial: false` on the `protocol` plane, so
 * `checkAccess` returns `allowed.permissionless` and there is nothing to verify,
 * because there is nothing held.
 *
 * A call that needs a signed-in person needs them only to know whose profile a
 * row belongs to; it confers no power over the account. `packages/auth` has no
 * `protocol:write` scope at all — deliberately,
 * the same way it has no `ledger:write` — because no user token, and no
 * platform credential, may ever authorise anything on this plane. The only
 * thing that authorises here is a signature from the user's own key.
 */

/** An approval amount (a positive decimal integer, the record's shape) that does not fit a token balance refuses. */
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
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Protocol request failed', cause: err });
}

/** Posts a signed fee-token swap to the relayer as JSON; 10 s at most, so a silent relayer refuses instead of hanging. */
async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export interface ProtocolRouterDeps {
  chain: ProtocolChain;
  /** The process's one chain identity reader (`chain/identity.ts`); built from `chain` when absent. */
  chainIdentity?: ChainIdentityReader;
  relay: SessionRelay;
  /** Mirrors the `protocol.smartAccounts` kill-switch (§14). */
  relayEnabled: () => boolean;
  /** Pool factory address on PROTOCOL_CHAIN_ID (0x0 = not deployed yet). */
  ammFactoryAddress: () => Address;
  /** `PROTOCOL_LIQUIDITY_ROUTER_ADDRESS` (D-liquidity-02..04). Absent or zero: liquidity calls refuse. */
  liquidityRouter?: () => Address | null;
  /** `PROTOCOL_AMM_FEE_TIERS_BPS` (D-liquidity-03). Absent or null: `amm.feeTiers` refuses `amm.fee_tiers_unset`. */
  feeTiers?: () => number[] | null;
  /**
   * `PROTOCOL_SWAP_SLIPPAGE_BPS`. Null when blank. The swap builder and the
   * session check refuse — they do not invent a tolerance.
   */
  swapSlippageBps: () => number | null;
  /**
   * Router v2, SovereignPermit and the wrapped native token (D-swap-03, D-swap-intents-01, -02). Null or absent: the v2
   * swap procedures refuse `protocol.router_v2_unset`.
   */
  swapV2?: () => SwapV2Setting | null;
  /** `PROTOCOL_PERMIT_LIFETIME_CAP_SECONDS`. Null or absent: `amm.buildPermit` refuses `protocol.permit.lifetime_unset`. */
  permitLifetimeCapSeconds?: () => number | null;
  /** `PROTOCOL_SWAP_QUOTE_TTL_SECONDS`. Null or absent: `amm.swapSettings` refuses. */
  swapQuoteTtlSeconds?: () => number | null;
  /** `PROTOCOL_SWAP_CONFIRMATIONS`. Null or absent: `amm.swapSettings` refuses. */
  swapConfirmations?: () => number | null;
  /** `PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI`, the fee cap. Null or absent: `amm.feeLevels` refuses `protocol.swap_fee_cap_unset`. */
  swapFeeCapWei?: () => bigint | null;
  /**
   * `PROTOCOL_FEE_RELAY_ADDRESS`, `_URL` and `_GAS_LIMIT` (RC-dex-protocol-02). Null or absent: paying the network fee in
   * a token refuses `protocol.fee_relay_unset`.
   */
  feeRelay?: () => FeeRelaySetting | null;
  /** `PROTOCOL_CLAIM_ESCROW_ADDRESS` (D-swap-12). Null, zero or absent: claim links refuse `protocol.claim_escrow_unset`. */
  claimEscrow?: () => Address | null;
  /**
   * The sovereign P2P escrow (RC-p2p-01): `PROTOCOL_P2P_ESCROW_ADDRESS` and whether the configured chain is a mainnet.
   * Absent: not deployed (`protocol.escrow_not_deployed`), and treated as mainnet (`audit.external`) until told otherwise.
   */
  p2pEscrow?: () => { escrow: Address | null; mainnet: boolean };
  /** `PROTOCOL_VENUE_ADDRESS` (D-bridge-chain-04). Null, zero or absent: venue funds refuse `protocol.venue_unset`. */
  venue?: () => Address | null;
  /**
   * `PROTOCOL_LENDING_MARKET_ADDRESS` (D-portfolio-wallet-04). Null, zero or absent: a lending position refuses
   * `protocol.lending_market_unset`.
   */
  lendingMarket?: () => Address | null;
  /**
   * `PROTOCOL_TX_FEE_BUMP_BPS` and `PROTOCOL_TX_FEE_CEILING_WEI` (RC-dex-protocol-01). Absent or null: speed up and cancel
   * refuse `protocol.fee_bump_unset` / `protocol.fee_ceiling_unset`.
   */
  replacement?: () => ReplacementSetting;
  /** How a signed fee-token swap is posted to the relayer; `fetch` with a timeout when absent. */
  postRelay?: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  /** `PROTOCOL_PRICE_USD_TOKENS` and `PROTOCOL_PRICE_MIN_RESERVE_USD`. Null or absent: `amm.prices` refuses. */
  priceSetting?: () => PriceSetting | null;
  /** `PROTOCOL_TOKENS_QUOTE_TOKEN`: what the token pages state prices in. Null or absent: `tokens.*` refuses. */
  tokensQuoteToken?: () => Address | null;
  /** What the indexer and the DEX report about themselves, for `blockers`. Absent = not connected. */
  peers?: Peers;
  /** `PROTOCOL_PEER_TIMEOUT_MS`: the published bound for the bundler probe. Absent = the probe is not made. */
  probeTimeoutMs?: () => number | undefined;
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
   * The wallet address book and wallet groups (D-portfolio-wallet-03), opened with a wallet session the wallet signs.
   * Absent = not wired, which refuses `protocol.wallet_session_unset`.
   */
  addressBook?: Omit<AddressBookDeps, 'chainId'>;
  /** The address risk card's label store and the scam report queue (D-developer-compliance-01). Absent = not wired. */
  addressRisk?: Omit<AddressRiskDeps, 'chainId'>;
  /** The operator compliance queue over the same tables; absent, every `compliance.*` call fails as a server error. */
  compliance?: Omit<ComplianceDeps, 'chainId' | 'now' | 'trustDesk'> & { trustDesk?: ComplianceDeps['trustDesk'] };
  /**
   * The venue wallet connection (J-wallet-09): a signed-in person's own wallet, connected by its signature. Absent = not
   * wired: every setting reads blank and connecting refuses by name.
   */
  venueWallet?: Omit<VenueConnectionDeps, 'chainId'>;
  /**
   * The embedded self-custody wallet (J-wallet-22): the owner's provider makes the person's wallet with their passkey.
   * Absent = not wired: the provider setting reads blank and creating refuses `wallet.embedded_provider_unset`.
   */
  embeddedWallet?: EmbeddedWalletDeps;
}

/** An unwired label store answers nothing: every read and report fails as a server error rather than inventing a record. */
const unwiredAddressRiskStore: AddressRiskStore = {
  labels: () => Promise.reject(new Error('address risk store is not wired')),
  openReportCount: () => Promise.reject(new Error('address risk store is not wired')),
  insertReport: () => Promise.reject(new Error('address risk store is not wired')),
};

const unwiredComplianceStore: ComplianceDeps['store'] = {
  queue: () => Promise.reject(new Error('compliance store is not wired')),
  ask: () => Promise.reject(new Error('compliance store is not wired')),
  approve: () => Promise.reject(new Error('compliance store is not wired')),
};
const notWired = () => Promise.reject(new Error('trust desk store is not wired'));
const unwiredTrustDeskStore: ComplianceDeps['trustDesk'] = {
  tiers: notWired,
  askTier: notWired,
  approveTier: notWired,
  removeTier: notWired,
  checklists: notWired,
  openChecklist: notWired,
  approveChecklist: notWired,
  nameTags: notWired,
  requestNameTag: notWired,
  approveNameTag: notWired,
};

/** Never reached with a setting: an unwired representation has none, so it refuses `compliance.representation_unset` first. */
const unwiredRepresentationStore: RepresentationStore = {
  find: async () => null,
  put: async () => {
    throw new Error('representation store is not wired');
  },
};

export function createProtocolRouter(deps: ProtocolRouterDeps) {
  const { chain, relay } = deps;
  const readPairs = pairsReader(chain);
  // The ownership proof's chain reads, built once: the challenge's chain id and the verify reads come from this one object.
  let ownership: OwnershipChain | null = null;
  // Which chain the rows read from it belong to (chain id and genesis), so a row from a TEST chain started again reads as
  // absent. One reader for the process (`index.ts`), shared with the registry.
  const chainIdentity: ChainIdentityReader = deps.chainIdentity ?? chainIdentityReader(chain);
  const listingChain = (): OwnershipChain => (ownership ??= deps.listing?.chain ?? ownershipChain(chain, chainIdentity));
  const routeBalances = blockBalances(chain);
  let contracts: ContractChain | null = null;
  /** The fee relay's reads go to the same node as every other chain read. */
  const feeChain = (): FeeRelayChain => chain.client as unknown as FeeRelayChain;
  /** A refusal already shaped keeps its code; a chain failure is classified (unreachable, absent contract) by name. */
  const feeRelayError = (err: unknown): TRPCError =>
    err instanceof TRPCError || err instanceof SwapFeeError || err instanceof SwapSlippageError || err instanceof PoolTokenError
      ? toTrpcError(err)
      : toTrpcError(classifyChainError(err, 'amm.feeRelay', chain.config.rpcUrl));
  /**
   * A fee-token swap only ever names a pool the configured factory lists, read from the chain: the relayer pays the gas
   * of whatever it sends, so a pool of the caller's own making (one that behaves in the pre-send check and burns the gas
   * when sent) is refused before anything is built or posted.
   */
  const requireFactoryPool = async (pool: Address) => {
    const factory = deps.ammFactoryAddress();
    if (isZeroAddress(factory))
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
      });
    const listed = (await readPairs(factory)).pools.some((entry) => entry.pool.toLowerCase() === pool.toLowerCase());
    if (!listed)
      throw feeRefusal(
        'BAD_REQUEST',
        'protocol.fee_swap_pool_unlisted',
        `${pool} is not a pool the network's factory lists; a fee-token swap uses listed pools only.`,
      );
  };
  /** The most per gas a person may offer: refused above the owner's cap, never lowered to it. */
  const withinFeeCap = (maxFee: bigint): bigint => {
    const cap = requireFeeCapWei(deps.swapFeeCapWei?.());
    if (maxFee > cap)
      throw feeRefusal('BAD_REQUEST', 'protocol.swap_fee_over_cap', `${maxFee} wei per gas is above the owner's fee cap of ${cap}.`);
    return maxFee;
  };

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
  const addressBookDeps: AddressBookDeps = {
    chainId: () => chain.config.chainId,
    ...(deps.addressBook ?? {
      store: unwiredAddressBookStore,
      session: () => null,
      maxContacts: () => undefined,
      maxGroups: () => undefined,
    }),
  };

  const venueWalletDeps: VenueConnectionDeps = {
    chainId: () => chain.config.chainId,
    ...(deps.venueWallet ?? {
      store: unwiredVenueConnectionStore,
      session: () => null,
      ttlSeconds: () => null,
      sanctions: () => null,
    }),
  };

  const addressRiskDeps: AddressRiskDeps = {
    chainId: () => chain.config.chainId,
    ...(deps.addressRisk ?? { store: unwiredAddressRiskStore, screeningLoaded: () => false }),
  };

  return router({
    health: mountProtocolRecord(PROTOCOL_HEALTH, () =>
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
    auditStatus: mountProtocolRecord(PROTOCOL_AUDIT_STATUS, () => loadInternalSmartAccountsPackage()),

    /** The audit room's per-product rows: an owner-recorded external report per product, or none. Never inferred. */
    auditProducts: mountProtocolRecord(PROTOCOL_AUDIT_PRODUCTS, () => loadProductAudits()),

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
    chainStatus: mountProtocolRecord(PROTOCOL_CHAIN_STATUS, async () => {
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
    gasPrice: mountProtocolRecord(PROTOCOL_GAS_PRICE, async () => {
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
    blockers: mountProtocolRecord(PROTOCOL_BLOCKERS, async ({ input, ctx }) => {
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
      list: mountProtocolRecord(PROTOCOL_NETWORKS_LIST, () => {
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

    /** The deployed-contract registry and router versions for a chain. A chain with no recorded deployment is NOT_FOUND. */
    deployments: router({
      list: mountProtocolRecord(PROTOCOL_DEPLOYMENTS_LIST, ({ input }) => {
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
    capabilities: mountProtocolRecord(PROTOCOL_CAPABILITIES, async ({ input }) => {
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
    predictAddress: mountProtocolRecord(PROTOCOL_PREDICT_ADDRESS, async ({ input }) => {
      requireAccountFactoryConfigured(chain.config.factory, chain.config.implementation);
      try {
        const address = computeAccountAddress({
          factory: chain.config.factory,
          implementation: chain.config.implementation,
          owner: toChecksum(input.owner),
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

    /**
     * Validate a session scope and return the calldata that grants it.
     *
     * Nothing is granted here. A scope that the contract would refuse is
     * rejected before it ever becomes something to sign — including, always,
     * any scope carrying withdrawal power.
     */
    buildSessionGrant: mountProtocolRecord(PROTOCOL_BUILD_SESSION_GRANT, ({ input }) => {
      try {
        const account = toChecksum(input.account);
        const spec = createSessionSpec(sessionSpecFromWire(input.spec), {
          account,
          now: Math.floor(Date.now() / 1000),
        });
        const call = relay.buildSessionGrant(account, spec);
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

    buildSessionRevoke: mountProtocolRecord(PROTOCOL_BUILD_SESSION_REVOKE, ({ input }) => {
      const call = relay.buildSessionRevoke(toChecksum(input.account), toChecksum(input.sessionKey));
      return { to: call.to, data: call.data, value: call.value.toString(), summary: call.summary };
    }),

    /** The panic button. One call, every session dead. Owner only, on chain. */
    buildRevokeAllSessions: mountProtocolRecord(PROTOCOL_BUILD_REVOKE_ALL_SESSIONS, ({ input }) => {
      const call = relay.buildRevokeAllSessions(toChecksum(input.account));
      return { to: call.to, data: call.data, value: call.value.toString(), summary: call.summary };
    }),

    /**
     * Contract ownership proof (D-launch-listing-01). Public: the token's owner may be signed out. A challenge is a fresh
     * one-time message; a proof is stored only when the token's on-chain owner signed it.
     */
    listing: router({
      ownershipChallenge: mountProtocolRecord(PROTOCOL_LISTING_OWNERSHIP_CHALLENGE, async ({ input }) => {
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
      verifyOwnership: mountProtocolRecord(PROTOCOL_LISTING_VERIFY_OWNERSHIP, async ({ input }) => {
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
      status: mountProtocolRecord(PROTOCOL_REPRESENTATION_STATUS, async ({ input }) => {
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
      accept: mountProtocolRecord(PROTOCOL_REPRESENTATION_ACCEPT, async ({ input }) => {
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

    // ── Wallet address book (D-portfolio-wallet-03): src/address-book/router.ts ──
    walletSession: createWalletSessionRouter(addressBookDeps),
    addressBook: createAddressBookRouter(addressBookDeps),
    addressRisk: createAddressRiskRouter(addressRiskDeps),
    addressReports: createAddressReportsRouter(addressRiskDeps),
    compliance: createComplianceRouter({
      chainId: () => chain.config.chainId,
      store: deps.compliance?.store ?? unwiredComplianceStore,
      trustDesk: deps.compliance?.trustDesk ?? unwiredTrustDeskStore,
      now: () => new Date(),
    }),
    // ── Venue wallet connection (J-wallet-09): src/venue-wallet/router.ts ──
    venueWallet: createVenueWalletRouter(venueWalletDeps),
    // ── Embedded self-custody wallet (J-wallet-22): src/embedded-wallet/router.ts ──
    embeddedWallet: createEmbeddedWalletRouter(
      deps.embeddedWallet ?? { store: unwiredEmbeddedWalletStore, setting: () => ({ kind: 'unset' }) },
    ),

    // ── Session keys list (D-portfolio-wallet-02): src/session/list.ts ──
    sessions: router({
      /** Every key the account granted, from its own logs, with the on-chain status at one block. Public, like the chain. */
      list: mountProtocolRecord(PROTOCOL_SESSIONS_LIST, async ({ input }) => {
        try {
          return await listSessions(chain.client, { account: input.account, chainId: chain.config.chainId });
        } catch (err) {
          // A chain failure is named as the chain's; anything else (a shape bug) is an internal error, never "unreachable".
          throw toTrpcError(err instanceof z.ZodError ? err : classifyChainError(err, 'sessions.list', chain.config.rpcUrl));
        }
      }),
    }),

    // ── Claim links (D-swap-12) and speed up / cancel (RC-dex-protocol-01): src/wallet-tx/ ──
    ...createWalletTxRouters({
      chain: () => chain.client,
      claimEscrow: () => deps.claimEscrow?.() ?? null,
      replacement: () => deps.replacement?.() ?? { bumpBps: null, ceilingWei: null },
      toTrpcError,
    }),

    // ── Sovereign P2P escrow (RC-p2p-01): src/escrow/ ──
    escrow: createEscrowRouter({
      chain: () => chain.client,
      setting: () => ({ chainId: chain.config.chainId, ...(deps.p2pEscrow?.() ?? { escrow: null, mainnet: true }) }),
      toTrpcError,
    }),

    // ── Trading venue funds (D-bridge-chain-04): src/venue/ ──
    venue: createVenueFundsRouter({
      chain: () => chain.client,
      venue: () => deps.venue?.() ?? null,
      directApproveReverts: (token, owner, spender, amount) => chain.directApproveReverts(token, owner, spender, amount),
      toTrpcError,
    }),

    // ── Lending position (D-portfolio-wallet-04): src/lending/position.ts ──
    lending: createLendingRouter({
      chain: () => chain.client,
      market: () => deps.lendingMarket?.() ?? null,
      toTrpcError,
    }),

    // ── Registry (a read model, not custody) ──────────────────────────────

    /**
     * AMM (`protocol.amm`) — constant-product pools on the Protocol Plane.
     *
     * Permissionless quotes and unsigned calldata only. The platform never
     * holds LP keys and never posts to the ledger here.
     */
    /**
     * A contract's source status, proxy and Read/Write tabs (D-explorer-06): matched against this service's own committed
     * builds; Read is an eth_call at one block, Write builds the call the person's wallet signs.
     */
    contract: createContractSourceRouter({ chain: () => (contracts ??= contractChain(chain)), toTrpcError }),

    /** The owner-published bridge route table (D-bridge-chain-03); blank refuses `bridge.routes_unset`. */
    bridge: createBridgeRouter({ loadRoutes: bridgeRoutesLoader() }),

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

    portfolio: createPortfolioRouter({
      chain: portfolioChain(
        tokenLogsChain(
          chain,
          () => chain.client,
          () => chain.config.rpcUrl,
        ),
        () => chain.client,
        () => chain.config.rpcUrl,
      ),
      factory: () => deps.ammFactoryAddress(),
      priceSetting: () => deps.priceSetting?.() ?? null,
      toTrpcError,
    }),

    amm: router({
      ...createLiquidityProcedures({
        client: () => chain.client,
        rpcUrl: () => chain.config.rpcUrl,
        factory: () => deps.ammFactoryAddress(),
        router: () => deps.liquidityRouter?.() ?? null,
        feeTiers: () => deps.feeTiers?.() ?? null,
        quoteTtlSeconds: () => deps.swapQuoteTtlSeconds?.() ?? null,
        slippageBps: () => deps.swapSlippageBps(),
        readPairs: (factory) => readPairs(factory),
        toTrpcError,
      }),
      ...createPoolFeesProcedures({
        chain: poolFeesChain(
          () => chain.client,
          () => chain.config.rpcUrl,
          () => chain.headBlock(),
        ),
        factory: () => deps.ammFactoryAddress(),
        toTrpcError,
      }),
      ...createSwapV2Procedures({
        client: () => chain.client,
        chainId: () => chain.config.chainId,
        setting: () => deps.swapV2?.() ?? null,
        permitLifetimeCapSeconds: () => deps.permitLifetimeCapSeconds?.() ?? null,
        slippageCeilingBps: () => requireSwapSlippageBps(deps.swapSlippageBps()),
        pairs: async () => {
          const factory = deps.ammFactoryAddress();
          if (isZeroAddress(factory))
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
            });
          return readPairs(factory);
        },
        toTrpcError: (err) =>
          err instanceof TRPCError || err instanceof SwapSlippageError
            ? toTrpcError(err)
            : toTrpcError(classifyChainError(err, 'amm.v2', chain.config.rpcUrl)),
      }),

      /**
       * Every pool the configured factory lists and the tokens they trade, read from the chain (D-swap-01). An unset
       * factory refuses by name; an unreadable chain refuses `protocol.chain_unreachable`. Never a list from config.
       */
      pairs: mountProtocolRecord(PROTOCOL_AMM_PAIRS, async () => {
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
      prices: mountProtocolRecord(PROTOCOL_AMM_PRICES, async () => {
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
      swapSettings: mountProtocolRecord(PROTOCOL_AMM_SWAP_SETTINGS, () => {
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
      feeLevels: mountProtocolRecord(PROTOCOL_AMM_FEE_LEVELS, async () => {
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
       * The tokens that may pay a swap's network fee (RC-dex-protocol-02): every token the relay lists, with whether it is
       * allowlisted today, the relay's published markup and the gas a relayed swap is priced for. Blank settings refuse
       * `protocol.fee_relay_unset`.
       */
      feeTokens: mountProtocolRecord(PROTOCOL_AMM_FEE_TOKENS, async () => {
        const setting = requireFeeRelay(deps.feeRelay?.());
        try {
          return await readFeeTokens(feeChain(), setting);
        } catch (err) {
          throw feeRelayError(err);
        }
      }),

      /**
       * What the gas of a relayed swap costs in `feeToken` at the most per gas the person chose (one of the fee levels, or
       * a custom fee within the cap), priced by the relay contract from the oracle mark plus its published markup. A token
       * off the allowlist, or a stale or missing oracle mark, refuses by name: the person pays in native currency.
       */
      feeQuote: mountProtocolRecord(PROTOCOL_AMM_FEE_QUOTE, async ({ input }) => {
        const setting = requireFeeRelay(deps.feeRelay?.());
        try {
          const maxFee = withinFeeCap(BigInt(input.maxFeePerGasWei));
          return await quoteFee(feeChain(), setting, toChecksum(input.feeToken), maxFee);
        } catch (err) {
          throw feeRelayError(err);
        }
      }),

      /**
       * A swap whose network fee is paid in `feeToken`: the pool is read again and the minimum checked against the owner's
       * slippage ceiling, as for `buildSwapExactIn`; then the quote, a permit per token the relay pulls, and the FeeSwap
       * order the person signs. Both expire after the owner's quote lifetime.
       */
      prepareFeeSwap: mountProtocolRecord(PROTOCOL_AMM_PREPARE_FEE_SWAP, async ({ input }) => {
        const setting = requireFeeRelay(deps.feeRelay?.());
        try {
          const slippageBps = requireSwapSlippageBps(deps.swapSlippageBps());
          const lifetime = deps.swapQuoteTtlSeconds?.() ?? null;
          if (lifetime === null)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `${SWAP_SETTINGS_UNSET}: PROTOCOL_SWAP_QUOTE_TTL_SECONDS is an owner setting; refuse rather than invent how long a signed order lives.`,
            });
          const maxFee = withinFeeCap(BigInt(input.maxFeePerGasWei));
          const pool = toChecksum(input.pool);
          const tokenIn = toChecksum(input.tokenIn);
          const amountIn = BigInt(input.amountIn);
          const minAmountOut = BigInt(input.minAmountOut);
          await requireFactoryPool(pool);
          const quoted = await freshPoolQuote(chain, pool, tokenIn, amountIn);
          assertMinAmountOut(minAmountOut, quoted.amountOut, slippageBps);
          return await planFeeSwap(
            feeChain(),
            setting,
            chain.config.chainId,
            { owner: toChecksum(input.owner), pool, tokenIn, amountIn, minAmountOut, feeToken: toChecksum(input.feeToken) },
            maxFee,
            lifetime,
          );
        } catch (err) {
          throw feeRelayError(err);
        }
      }),

      /**
       * Hands a signed fee-token swap to the relayer once it checks out: the signature is the owner's, the per-gas fee is
       * within the cap and matches the gas signed for, the relay prices the fee at no more than the signed charge, and the
       * call succeeds against the chain now. The relayer sends it and pays the gas; the answer is its hash.
       */
      relayFeeSwap: mountProtocolRecord(PROTOCOL_AMM_RELAY_FEE_SWAP, async ({ input }) => {
        const setting = requireFeeRelay(deps.feeRelay?.());
        try {
          const cap = requireFeeCapWei(deps.swapFeeCapWei?.());
          // The same pool and minimum checks as when the order was prepared, against the chain as it is now.
          const slippageBps = requireSwapSlippageBps(deps.swapSlippageBps());
          const pool = input.order.pool as Address;
          await requireFactoryPool(pool);
          const quoted = await freshPoolQuote(chain, pool, toChecksum(input.order.tokenIn), BigInt(input.order.amountIn));
          assertMinAmountOut(BigInt(input.order.minAmountOut), quoted.amountOut, slippageBps);
          return await relayFeeSwap(feeChain(), setting, chain.config.chainId, input, cap, deps.postRelay ?? postJson);
        } catch (err) {
          throw feeRelayError(err);
        }
      }),

      /**
       * The live allowances `owner` has given for the tokens the factory's pools trade (D-swap-09), read at one block:
       * each listed pool and each spender in the owner's recent Approval logs, kept only when `allowance()` is above zero.
       * Allowances are public chain data, so the address asked about is the scope and no session is needed.
       */
      allowances: mountProtocolRecord(PROTOCOL_AMM_ALLOWANCES, async ({ input }) => {
        const factory = deps.ammFactoryAddress();
        if (isZeroAddress(factory))
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
          });
        try {
          return await listAllowances(chain, await readPairs(factory), toChecksum(input.owner));
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

      /**
       * Route options (J-dex-protocol-02 #4): every factory pool for the pair, ranked for `amountIn` at one block, best
       * first; a lost leg says how much less it gives, an excluded one keeps its place, an unsynced pool reads
       * `unavailable: stale` and is never quoted or dropped. The pool venue only (D-swap-05's books, hops and splits are
       * svc-dex's).
       */
      routes: mountProtocolRecord(PROTOCOL_AMM_ROUTES, async ({ input }) => {
        const factory = deps.ammFactoryAddress();
        if (isZeroAddress(factory))
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
          });
        if (input.tokenIn.toLowerCase() === input.tokenOut.toLowerCase())
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'protocol.route_same_token: pay and receive name the same token.' });
        try {
          return await routeOptions(routeBalances, await readPairs(factory), {
            tokenIn: toChecksum(input.tokenIn),
            tokenOut: toChecksum(input.tokenOut),
            amountIn: BigInt(input.amountIn),
            exclude: input.exclude.map((address) => toChecksum(address)),
          });
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
      quoteFromPool: mountProtocolRecord(PROTOCOL_AMM_QUOTE_FROM_POOL, async ({ input }) => {
        try {
          const pool = toChecksum(input.pool);
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

      buildSwapExactIn: mountProtocolRecord(PROTOCOL_AMM_BUILD_SWAP_EXACT_IN, async ({ input }) => {
        try {
          // Config first: a blank tolerance refuses before the quote and
          // before `buildSwapExactIn` encodes anything.
          const slippageBps = requireSwapSlippageBps(deps.swapSlippageBps());
          const pool = toChecksum(input.pool);
          const tokenIn = toChecksum(input.tokenIn);
          const amountIn = BigInt(input.amountIn);
          const minAmountOut = BigInt(input.minAmountOut);
          const quoted = await freshPoolQuote(chain, pool, tokenIn, amountIn);
          assertMinAmountOut(minAmountOut, quoted.amountOut, slippageBps);
          const call = buildSwapExactIn(pool, tokenIn, amountIn, minAmountOut, toChecksum(input.to));
          return { to: call.to, data: call.data, value: call.value, summary: call.summary };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

      /**
       * Does `spender` already hold enough allowance from `owner` for `amount` of `token`, and if not, which calls fix it?
       * Read at one pinned block, which the answer names. Exact amount unless `unlimited: true` is passed by name.
       */
      checkApproval: mountProtocolRecord(PROTOCOL_AMM_CHECK_APPROVAL, async ({ input }) => {
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

      /** `approve(spender, 0)`. */
      buildRevoke: mountProtocolRecord(PROTOCOL_AMM_BUILD_REVOKE, ({ input }) => {
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
  });
}

export type ProtocolRouter = ReturnType<typeof createProtocolRouter>;
