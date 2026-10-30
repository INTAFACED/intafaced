import { z } from 'zod';
import { edgeEnvSchema, loadEnv, serviceEnvSchema } from '@intafaced/config';

/** A whole number of 0 or more, or null when blank or anything else. Never coerces blank to 0. */
function parseWhole(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  return Number(text);
}
/** A whole number above 0, or null. */
function parsePositiveWhole(raw: string): number | null {
  const n = parseWhole(raw);
  return n !== null && n > 0 ? n : null;
}
import { parseMinReserveUsd, parseUsdTokens } from './amm/prices.js';
import { parseSwapSlippageBps } from './amm/slippage.js';
import { parseFeeCapWei } from './amm/fee-levels.js';

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');
/**
 * Compose `${VAR:-}` injects `''` when the host env is blank. Empty is unset,
 * not Anvil CREATE: the schema default 0x0 applies (paths refuse as not
 * configured). Owner may set a real address explicitly.
 */
const evmAddressDefaultZero = z.preprocess(
  (value) => (value === '' ? undefined : value),
  evmAddress.default('0x0000000000000000000000000000000000000000'),
);

const blankIsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema);

/**
 * Environment for svc-protocol.
 *
 * Note what this service does NOT need, and must never acquire:
 *   · no signing key of any kind. There is no `PRIVATE_KEY` here, because there
 *     is no transaction this service is entitled to originate on a user's
 *     account (§16.10)
 *   · no ledger connection. This plane posts nothing
 *
 * If a future change adds a private key to this file, that change is either
 * wrong or belongs in svc-bridge, which is custodial by design (§17.3).
 *
 * `EDGE_PRINCIPAL_SECRET` is here because this service self-mounts /trpc. It is
 * not a custody key and grants nothing on-chain: it only lets this service tell
 * a principal the edge vouched for from one a caller typed. Most of the surface
 * is permissionless; the registry procedures are not, and they are the reason
 * (docs/decisions/mount-boundary.md).
 */
const schema = serviceEnvSchema.merge(edgeEnvSchema).merge(
  z.object({
    SERVICE_NAME: z.string().default('svc-protocol'),
    HTTP_PORT: z.coerce.number().int().default(4004),

    /**
     * The EVM chain the contract suite is deployed to (§17.2 P0: proven rails).
     *
     * No default. 31337 is Anvil; echoing it when the operator never set a
     * chain id makes a fixture look live. Blank/unset refuse boot. Operator
     * may set 31337 explicitly. Pair of INDEXER_CHAIN_ID (#3971).
     */
    PROTOCOL_CHAIN_ID: z.preprocess(
      (value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'string' && value.trim() === '') return undefined;
        if (typeof value === 'string') {
          const n = Number(value.trim());
          return Number.isFinite(n) ? n : value;
        }
        return value;
      },
      z
        .number({
          error: (issue) =>
            issue.input === undefined
              ? 'PROTOCOL_CHAIN_ID is unset — will not echo Anvil 31337 as live'
              : 'PROTOCOL_CHAIN_ID must be a positive integer (blank/unset must not echo Anvil 31337 as live)',
        })
        .int()
        .positive(),
    ),
    /**
     * EVM JSON-RPC endpoint. No default.
     *
     * Compose used to interpolate `:-http://evm:8545` while this schema
     * defaulted `http://localhost:8545` — a blank host invented a chain.
     * Blank/unset refuse boot. Owner may set `http://evm:8545` (or any RPC)
     * explicitly. This mill does not invent an endpoint.
     */
    PROTOCOL_RPC_URL: z.preprocess(
      (value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'string' && value.trim() === '') return undefined;
        return typeof value === 'string' ? value.trim() : value;
      },
      z
        .string({
          error: (issue) =>
            issue.input === undefined
              ? 'PROTOCOL_RPC_URL is unset — will not invent http://evm:8545 as live'
              : 'PROTOCOL_RPC_URL must be a non-empty RPC URL (blank/unset must not invent http://evm:8545 as live)',
        })
        .url(),
    ),

    /**
     * ERC-4337 EntryPoint on THIS venue's chain. No default.
     *
     * Ethereum's v0.7 singleton `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
     * is a public contract we do not own. Echoing it when the operator never
     * named an address publishes that chain's EntryPoint as ours. Blank/unset
     * refuse boot. Operator may set that address explicitly.
     */
    PROTOCOL_ENTRYPOINT_ADDRESS: z.preprocess(
      (value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'string' && value.trim() === '') return undefined;
        return typeof value === 'string' ? value.trim() : value;
      },
      z
        .string({
          error: (issue) =>
            issue.input === undefined
              ? 'PROTOCOL_ENTRYPOINT_ADDRESS is unset — will not publish Ethereum EntryPoint 0x0000000071727De22E5E9d8BAf0edAc6f37da032 as this venue'
              : 'PROTOCOL_ENTRYPOINT_ADDRESS must be a 20-byte hex address (blank/unset must not invent Ethereum EntryPoint as this venue)',
        })
        .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address'),
    ),
    PROTOCOL_FACTORY_ADDRESS: evmAddressDefaultZero,
    PROTOCOL_IMPLEMENTATION_ADDRESS: evmAddressDefaultZero,
    /** Constant-product PoolFactory (protocol.amm). Zero until deployed on the target chain. */
    PROTOCOL_AMM_FACTORY_ADDRESS: evmAddressDefaultZero,
    /**
     * The token the token pages state every price and volume in (D-portfolio-wallet-06, -07). An owner setting with
     * NO DEFAULT: blank or zero is null and `tokens.*` refuses `protocol.tokens_quote_unset`.
     */
    PROTOCOL_TOKENS_QUOTE_TOKEN: z
      .string()
      .default('')
      .refine(
        (raw) => raw.trim() === '' || /^0x[0-9a-fA-F]{40}$/.test(raw.trim()),
        'PROTOCOL_TOKENS_QUOTE_TOKEN must be blank or an address',
      )
      .transform((raw) => (raw.trim() === '' || /^0x0{40}$/.test(raw.trim()) ? null : (raw.trim() as `0x${string}`))),
    /**
     * Worst slippage a swap builder or session check will accept, in bps.
     *
     * NO DEFAULT. Blank / unset / non-integer → null; `buildSwapExactIn` and
     * `checkSessionCall` refuse `protocol.swap_slippage_unset`. 0 means the
     * minimum must equal the fresh quote. Above 5000 is the same refusal —
     * 10_000 bps would make the floor 0. Never invent 50.
     */
    PROTOCOL_SWAP_SLIPPAGE_BPS: z.string().default('').transform(parseSwapSlippageBps),
    /**
     * How long the swap form may use one quote before it must read the pool again, in whole seconds (D-swap-02).
     * NO DEFAULT: blank or not a positive integer is null and `amm.swapSettings` refuses `protocol.swap_settings_unset`.
     */
    PROTOCOL_SWAP_QUOTE_TTL_SECONDS: z.string().default('').transform(parsePositiveWhole),
    /**
     * Blocks on top of a swap's own block before the form calls it filled (D-swap-01). 0 means its own block is enough.
     * NO DEFAULT: blank refuses `protocol.swap_settings_unset`, like the quote lifetime.
     */
    PROTOCOL_SWAP_CONFIRMATIONS: z.string().default('').transform(parseWhole),
    /**
     * The fee cap: the most per unit of gas, in whole wei, that the swap form lets a person offer at any network fee
     * level or as a custom fee (D-swap-11). NO DEFAULT: blank or not a positive whole number is null and
     * `amm.feeLevels` refuses `protocol.swap_fee_cap_unset`, so no level is offered and Swap stays off.
     */
    PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI: z.string().default('').transform(parseFeeCapWei),
    /**
     * The reference tokens a USD price is read against, each counted as one US dollar (D-swap-11): comma-separated
     * addresses on PROTOCOL_CHAIN_ID. NO DEFAULT: blank refuses `protocol.price_settings_unset`.
     */
    PROTOCOL_PRICE_USD_TOKENS: z
      .string()
      .default('')
      .refine((raw) => raw.trim() === '' || parseUsdTokens(raw) !== null, 'PROTOCOL_PRICE_USD_TOKENS must be blank or addresses')
      .transform(parseUsdTokens),
    /**
     * The reliability filter: the least a pool must hold on its priced side, in whole US dollars, for its price to be
     * shown. NO DEFAULT: blank refuses `protocol.price_settings_unset`.
     */
    PROTOCOL_PRICE_MIN_RESERVE_USD: z
      .string()
      .default('')
      .refine(
        (raw) => raw.trim() === '' || parseMinReserveUsd(raw) !== null,
        'PROTOCOL_PRICE_MIN_RESERVE_USD must be blank or whole US dollars above 0',
      )
      .transform(parseMinReserveUsd),
    /**
     * `TokenFactory` for `launch.token-factory` (§8.4). Zero until deployed.
     *
     * A loud zero, for the same reason as the two above: deriving a CREATE2
     * address from `factory = 0x0` yields a real, checksummed, entirely
     * fictional token address — and a creator can publish it and take money at
     * it. Every launch path refuses on this check before any arithmetic runs.
     */
    PROTOCOL_TOKEN_FACTORY_ADDRESS: evmAddressDefaultZero,

    /**
     * Public ERC-4337 bundler. Optional: without it the service still builds
     * and verifies operations, and the user submits them. A missing bundler
     * degrades convenience, never access — that is what permissionless means.
     */
    PROTOCOL_BUNDLER_URL: z.string().url().optional(),

    /**
     * svc-indexer and svc-dex, read by `protocol.blockers` through their public procedures. No defaults: a blank URL or
     * timeout means "not connected in this environment", never a guessed localhost or an invented wait.
     */
    INDEXER_URL: blankIsUnset(z.string().url().optional()),
    DEX_URL: blankIsUnset(z.string().url().optional()),
    PROTOCOL_PEER_TIMEOUT_MS: blankIsUnset(z.coerce.number().int().min(100).max(30_000).optional()),

    /**
     * Founding badge Drop phase I window (RC-more-catalogue-04), founder setting. Both ISO instants or the badge
     * refuses `badge.window_unset`; no default window.
     */
    PROTOCOL_BADGE_WINDOW_OPENS_AT: blankIsUnset(z.string().datetime().optional()),
    PROTOCOL_BADGE_WINDOW_CLOSES_AT: blankIsUnset(z.string().datetime().optional()),
    /**
     * Owner-set age (seconds) after which a founding-badge mint slot counts as stuck and an operator may clear it.
     * No default: blank refuses the clear with `badge.stuck_age_unset`.
     */
    PROTOCOL_BADGE_STUCK_MINT_AGE_SECONDS: blankIsUnset(z.coerce.number().int().min(60).max(2_592_000).optional()),
    /**
     * svc-identity action approval (four-eyes) for the stuck-mint clear, shared-secret (dual) mode. Either blank:
     * the clear refuses `badge.stuck_approval_unwired`. svc-protocol has no S2S key (service-keys.ts), so a
     * keypair-only identity refuses this call: it fails closed.
     */
    IDENTITY_URL: blankIsUnset(z.string().url().optional()),
    INTERNAL_SERVICE_SECRET: blankIsUnset(z.string().min(32).optional()),

    /**
     * Protocol ops desk metrics window (D-order-controls-04). An owner setting with no default: blank refuses the metrics
     * read with `owner.decision` unless the caller names a window.
     */
    PROTOCOL_OPS_WINDOW_SECONDS: blankIsUnset(z.coerce.number().int().min(60).max(2_592_000).optional()),

    /**
     * The sanctions representation a wallet signs once before its first signing action (D-developer-compliance-03).
     * The wording is counsel's and the version is the owner's. No default: either blank refuses
     * `compliance.representation_unset` and no signing action starts. A new version asks every wallet again.
     */
    PROTOCOL_REPRESENTATION_VERSION: blankIsUnset(
      z
        .string()
        .max(64)
        .regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, dash or underscore')
        .optional(),
    ),
    PROTOCOL_REPRESENTATION_TEXT: blankIsUnset(z.string().max(4000).optional()),

    /**
     * Gas tracker percentiles and history length (D-explorer-01). No default.
     * Blank or malformed refuses `protocol.gasPrice` with `protocol.gas_percentiles_unset`.
     * TEST fixtures may pass `10,50,90` and a block count; this schema does not.
     */
    PROTOCOL_GAS_PERCENTILES: z.string().default(''),
    PROTOCOL_GAS_HISTORY_BLOCKS: z.string().default(''),

    /** Kill-switch mirror for `protocol.smartAccounts` (§14 admin controls). */
    PROTOCOL_RELAY_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

    /**
     * 32-byte hex wrap for S-L6 venue API ciphertext. Empty = vault fail-closed
     * (HSM-backed KEK is Nitro / Class X). Not a chain signing key.
     */
    PROTOCOL_VENUE_VAULT_WRAP: z.string().optional(),
  }),
);

export const env = loadEnv(schema);
export type Env = typeof env;
