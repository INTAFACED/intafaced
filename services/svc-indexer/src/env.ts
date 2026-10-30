import { z } from 'zod';
import { edgeEnvSchema, loadEnv, serviceEnvSchema } from '@intafaced/config';
import { DEV_VENUE_ADDRESS, ZERO_VENUE_ADDRESS } from './clob-honesty.js';

export { DEV_VENUE_ADDRESS, ZERO_VENUE_ADDRESS };

/**
 * Environment for svc-indexer.
 *
 * Note what this service does NOT need, and must never acquire:
 *
 *   · no signing key of any kind. A read model originates no transaction, so
 *     there is nothing here for a key to authorise (§16.10)
 *   · no ledger connection, and no `LEDGER_URL`. This plane posts nothing —
 *     `custody-scan` asserts it, and `sovereignty.test.ts` asserts it again
 *   · no write credentials against any other service's schema (§2)
 *
 * If a future change adds a private key or a ledger URL to this file, that
 * change is either wrong or belongs in svc-bridge, which is custodial by design
 * (§17.3).
 *
 * `EDGE_PRINCIPAL_SECRET` is here because this service self-mounts `/trpc`
 * (docs/decisions/mount-boundary.md). Every read procedure is permissionless,
 * so the secret authorises nothing — but the mount recipe is the mount recipe,
 * and a service that cannot tell an edge-vouched principal from a caller-typed
 * one should not be the service that decides it does not need to.
 */
const schema = serviceEnvSchema.merge(edgeEnvSchema).merge(
  z.object({
    SERVICE_NAME: z.string().default('svc-indexer'),
    // 4013: every port from 4000 to 4012 is taken by another service in
    // docker-compose.apps.yml, and a default that collides is a default that
    // works on a laptop and fails in the fleet.
    HTTP_PORT: z.coerce.number().int().default(4013),

    /**
     * The chain being projected. Matches `PROTOCOL_CHAIN_ID` in svc-protocol.
     *
     * No default. 31337 is Anvil; echoing it when the operator never set a
     * chain id makes a fixture look live. Blank/unset refuse boot. Fixture ABI
     * ≠ live CLOB is #3955 — this is the id half of the same line.
     */
    INDEXER_CHAIN_ID: z.preprocess(
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
              ? 'INDEXER_CHAIN_ID is unset — will not echo Anvil 31337 as live'
              : 'INDEXER_CHAIN_ID must be a positive integer (blank/unset must not echo Anvil 31337 as live)',
        })
        .int()
        .positive(),
    ),

    /**
     * EVM JSON-RPC endpoint. No default.
     *
     * Compose used to interpolate `:-http://evm:8545` while this schema
     * defaulted empty (`NullChainSource`) — a blank host looked live.
     * Blank/unset refuse boot. Owner may set `http://evm:8545` (or any RPC)
     * explicitly. This mill does not invent an endpoint.
     */
    INDEXER_RPC_URL: z.preprocess(
      (value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'string' && value.trim() === '') return undefined;
        return typeof value === 'string' ? value.trim() : value;
      },
      z
        .string({
          error: (issue) =>
            issue.input === undefined
              ? 'INDEXER_RPC_URL is unset — will not invent http://evm:8545 as live'
              : 'INDEXER_RPC_URL must be a non-empty RPC URL (blank/unset must not invent http://evm:8545 as live)',
        })
        .min(1),
    ),

    /**
     * The venue contract whose logs are this read model's only input.
     *
     * No default. Non-prod used to fall through to the disposable Anvil
     * fixture `0x0116686E2291dbd5e317F47faDBFb43B599786Ef` — fixture CLOB
     * dressed as venue. Blank/unset refuse boot. Owner may set that address
     * (or any 20-byte hex) explicitly. `EvmChainSource` still refuses an
     * operator-set zero address (`indexer.venue_unset`) because eth_getLogs
     * against `0x0` returns `[]` forever.
     */
    INDEXER_VENUE_ADDRESS: z.preprocess(
      (value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'string' && value.trim() === '') return undefined;
        return typeof value === 'string' ? value.trim() : value;
      },
      z
        .string({
          error: (issue) =>
            issue.input === undefined
              ? 'INDEXER_VENUE_ADDRESS is unset — will not publish fixture CLOB 0x0116686E2291dbd5e317F47faDBFb43B599786Ef as venue'
              : 'INDEXER_VENUE_ADDRESS must be a 20-byte hex address (blank/unset must not invent fixture CLOB as venue)',
        })
        .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address'),
    ),

    /**
     * First height to index — in practice the venue's deployment block.
     *
     * Not cosmetic. Starting from 0 on a chain that has been running a while
     * means thousands of `eth_getBlockByNumber` + `eth_getLogs` round trips over
     * blocks that provably cannot hold a venue log, because the contract did not
     * exist yet. The projection would still be correct; it would just take hours
     * to say anything.
     *
     * No default. A git-default of 0 publishes genesis as that deployment block
     * when the operator never named one. Blank/unset refuse boot. An
     * operator-set 0 is genesis (anvil) — this mill does not invent a height.
     */
    INDEXER_START_HEIGHT: z.preprocess(
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
              ? 'INDEXER_START_HEIGHT is unset — will not publish genesis-0 as the venue deployment block'
              : 'INDEXER_START_HEIGHT must be an integer ≥ 0 (blank/unset must not publish genesis-0 as the venue deployment block)',
        })
        .int()
        .min(0),
    ),

    /**
     * How deep a reorg this projection can repair.
     *
     * This is NOT the correctness mechanism — see `projection/store.ts`. Blocks
     * are projected as soon as they are seen and unwound if they are orphaned,
     * so a shallow depth never makes the read model wrong, only more expensive
     * to repair. What this number really controls is how much version history
     * `prune()` retains, and therefore the deepest reorg that can be repaired
     * without a full re-index.
     *
     * No default. A git-default of 64 silently published a prune bound the
     * operator never named. Blank/unset refuse boot. An operator-set 64 is
     * that depth — this mill does not invent one.
     */
    INDEXER_FINALITY_DEPTH: z.preprocess(
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
              ? 'INDEXER_FINALITY_DEPTH is unset — will not publish prune bound 64 as live'
              : 'INDEXER_FINALITY_DEPTH must be an integer 1–10000 (blank/unset must not publish prune bound 64 as live)',
        })
        .int()
        .min(1)
        .max(10_000),
    ),

    /** Poll cadence for the ingest loop, in ms. */
    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(600_000).default(2_000),

    /**
     * Blocks pulled per sync pass. Bounds how long one pass holds the loop.
     *
     * No default. A git-default of 200 publishes a blocks-per-pass bound the
     * operator never named. Blank/unset refuse boot. An operator-set 200 is
     * that size — this mill does not invent one.
     */
    /**
     * D-explorer-01: owner-published explorer list window (1..200). Raw here on
     * purpose: blank/unset does NOT refuse boot; `indexer.explorer.blocks.list`
     * refuses `indexer.explorer_list_limit_unset` (same pattern as trpc-windows).
     * No default — never an invented page size.
     */
    INDEXER_EXPLORER_LIST_LIMIT: z.string().optional(),

    /**
     * D-explorer-02: seconds a mempool hash may stay unseen before it is dropped.
     * NO DEFAULT. Blank / unset does not refuse boot. A hash we already saw
     * pending, which the node no longer has, refuses indexer.tx_drop_window_unset
     * rather than inventing a window. Never invent a duration.
     */
    INDEXER_TX_DROP_WINDOW_SECONDS: z.string().optional(),

    /**
     * D-explorer-02: the other networks a transaction hash is looked up on, live, as JSON
     * [{"chainId":<id>,"rpcUrl":"http…"}]. Blank is none: the search answers for the followed network
     * alone. Parsed at boot (`explorer/search-networks.ts`); a malformed list refuses to start.
     */
    INDEXER_SEARCH_NETWORKS: z.string().optional(),

    /**
     * D-explorer-05: the pool factory whose pools the explorer lists (a 20-byte hex address). Any contract can emit
     * a pool's events, so only this factory's PoolCreated logs make a pool. NO DEFAULT: blank or unset does not refuse
     * boot; every pools read refuses indexer.pool_factory_unset. A malformed value refuses to start (`index.ts`).
     */
    INDEXER_POOL_FACTORY_ADDRESS: z.string().optional(),

    INDEXER_BATCH_SIZE: z.preprocess(
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
              ? 'INDEXER_BATCH_SIZE is unset — will not publish blocks-per-pass 200 as live'
              : 'INDEXER_BATCH_SIZE must be an integer 1–10000 (blank/unset must not publish blocks-per-pass 200 as live)',
        })
        .int()
        .min(1)
        .max(10_000),
    ),

    /**
     * Kill-switch mirror for the `indexer.ingest` flag (§14 admin controls).
     *
     * OFF stops the projection advancing. It does not stop anyone reading the
     * chain — every fact in this database is public and available from any node
     * — so what an operator gets here is a pause on OUR ingestion, never a gate
     * on a user's access. A kill-switch that could do more than that would mean
     * this service was load-bearing for someone's funds, and it is not.
     */
    INDEXER_INGEST_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),
  }),
);

export const env = loadEnv(schema);
export type Env = typeof env;
