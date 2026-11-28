import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from './testing/boot.js';
import type { ChainBlock } from './chain/source.js';
import { ERC20_TRANSFER_TOPIC } from './explorer/address.js';
import { POOL_CREATED_TOPIC, POOL_SWAP_TOPIC, POOL_SYNC_TOPIC } from './explorer/pools.js';
import { PostgresProjectionStore } from './projection/postgres-store.js';
import { businessBlockFor, checkAccess, KYC_TIERS, MODULES, regionsWithEntries, UNSET_SCREENING_LIST } from '@intafaced/config';

const CHAIN = 31337;

/**
 * §22 AND §16.10, ASSERTED FROM INSIDE THE SERVICE.
 *
 * `custody-scan` checks the custody boundary from outside, over the whole repo.
 * This file checks it from in here, for two reasons: a repo-wide scanner can be
 * loosened in one place and quietly stop covering this service, and a scanner
 * cannot assert what `checkAccess` actually returns for this module.
 *
 * ── One dependency that needs its justification in the open ────────────────
 *
 * This service DOES depend on `@intafaced/ledger-client`, which svc-protocol
 * deliberately does not. It imports exactly one thing from it: the `/money`
 * subpath — `parseAmount`, `formatAmount`, `Amount`. That module is pure
 * arithmetic over scaled bigints with no I/O, no client and no recipe, and it
 * is the canonical answer to non-negotiable #3 ("never store money in a
 * `number`"). `packages/market-data` imports it for the same reason and ships
 * to the browser.
 *
 * The alternative was a second decimal parser living in this service, which is
 * how two implementations of money end up disagreeing in the last decimal
 * place. The tests below draw the line where it belongs: the money subpath is
 * allowed, the root export and the recipes are not, and that is checked here
 * per-file rather than left to the reviewer's memory.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = sourceFiles(join(serviceRoot, 'src')).map((path) => ({ path, body: readFileSync(path, 'utf8') }));
/** Everything except this file, which necessarily quotes the patterns it bans. */
const shipped = files.filter((f) => !f.path.endsWith('sovereignty.test.ts'));

describe('svc-indexer · §22 — permissionless by architecture', () => {
  it('is registered non-custodial, on the protocol plane only', () => {
    expect(MODULES.indexer).toMatchObject({ service: 'svc-indexer', custodial: false, planes: ['protocol'] });
  });

  it('returns allowed.permissionless for every served region and every tier', () => {
    // A whole-region business block (the US, OWNER 237) is not served; it is asserted refused below.
    const regions = [...regionsWithEntries(), 'DE', 'XX', 'JP', 'NG'].filter((r) => businessBlockFor(r) === undefined);
    expect(regions).toEqual(expect.arrayContaining(['GB', 'DE', 'XX', 'JP', 'NG']));
    for (const region of regions) {
      for (const kycTier of KYC_TIERS) {
        const decision = checkAccess({
          module: 'indexer',
          plane: 'protocol',
          region,
          kycTier,
          regionFailClosed: false,
          screeningFailClosed: false,
        });
        expect(decision.code, `${region}/${kycTier}`).toBe('allowed.permissionless');
        expect(decision.allowed).toBe(true);
      }
    }
  });

  // OWNER 237 (8 Nov 2026): "US block: the US is blocked at launch as well as sanctioned countries, on the existing
  // per-country switch." Zero-KYC never makes a blocked region served, and the refusal never asks for KYC.
  it('refuses the US denied.region_blocked at every tier, blocked by the business, never asking for KYC', () => {
    for (const kycTier of KYC_TIERS) {
      const decision = checkAccess({
        module: 'indexer',
        plane: 'protocol',
        region: 'US',
        kycTier,
        regionFailClosed: false,
        screeningFailClosed: false,
      });
      expect(decision.allowed, kycTier).toBe(false);
      expect(decision.code, kycTier).toBe('denied.region_blocked');
      expect(decision.blockedBy, kycTier).toBe('business');
      expect(decision.requiredTier, kycTier).toBeUndefined();
    }
  });

  it('does not operate on the fiat plane at all', () => {
    expect(
      checkAccess({ module: 'indexer', plane: 'fiat', region: 'DE', kycTier: 'full', regionFailClosed: false, screeningFailClosed: false })
        .code,
    ).toBe('denied.plane_unsupported');
  });

  it('structural permissionlessness does not clear an unconfigured request', () => {
    const query = { module: 'indexer', plane: 'protocol', region: 'XX', kycTier: 'none', screening: UNSET_SCREENING_LIST } as const;
    const structural = checkAccess({ ...query, regionFailClosed: false, screeningFailClosed: false });
    expect(structural.allowed).toBe(true);
    expect(structural.code).toBe('allowed.permissionless');
    expect(structural.regionResolved).toBe(false);
    expect(structural.screening).toMatchObject({ listConfigured: false, declaration: 'unset', moneyGrade: 'unconfigured' });

    const request = checkAccess({ ...query, regionFailClosed: true, screeningFailClosed: true });
    expect(request.allowed).toBe(false);
    expect(request.code).toBe('denied.screening_unconfigured');
    expect(request.regionResolved).toBe(false);
    expect(request.screening).toMatchObject({ listConfigured: false, declaration: 'unset', moneyGrade: 'unconfigured' });
  });

  /**
   * The control. If `checkAccess` were returning `allowed.permissionless` for
   * everything, the assertions above would pass and mean nothing.
   */
  it('still gates a custodial module — the assertions above are not vacuous', () => {
    expect(
      checkAccess({ module: 'bank', plane: 'fiat', region: 'DE', kycTier: 'none', regionFailClosed: false, screeningFailClosed: false })
        .code,
    ).toBe('denied.kyc_required');
  });
});

describe('svc-indexer · §16.10 — the custody boundary, from inside', () => {
  it('never calls ledger.post', () => {
    for (const { path, body } of shipped) {
      expect(body, path).not.toMatch(/\bledger\s*\.\s*post\s*\(/);
    }
  });

  it('imports no ledger write recipe and no writable LedgerClient', () => {
    for (const { path, body } of shipped) {
      expect(body, path).not.toMatch(/from\s+['"]@intafaced\/ledger-client\/recipes['"]/);
      expect(body, path).not.toMatch(/import[^;]*\bLedgerClient\b[^;]*from\s+['"]@intafaced\/ledger-client['"]/s);
      expect(body, path).not.toMatch(/\brecipes\s*\./);
    }
  });

  /**
   * The ledger-client dependency is allowed at exactly one entry point.
   *
   * The root export re-exports `recipes`, `LedgerClient` and every account
   * helper. `/money` re-exports arithmetic. Importing the root would put the
   * whole write surface one autocomplete away, and `custody-scan` only catches
   * it once someone has already named a recipe.
   */
  it('reaches ledger-client only through the money subpath', () => {
    for (const { path, body } of shipped) {
      for (const match of body.matchAll(/from\s+['"](@intafaced\/ledger-client[^'"]*)['"]/g)) {
        expect(match[1], `${path} imports ${match[1]}`).toBe('@intafaced/ledger-client/money');
      }
    }
  });

  it('declares no ledger URL and no signing key in its environment', async () => {
    // Every variable the service's env schema declares, read from the schema the boot loads.
    vi.resetModules();
    for (const [key, value] of Object.entries(BOOT_ENV)) vi.stubEnv(key, value);
    try {
      const { schema } = await import('./env.js');
      const declared = Object.keys(schema.shape);
      expect(declared).toEqual(expect.arrayContaining(['INDEXER_CHAIN_ID', 'INDEXER_RPC_URL', 'EDGE_PRINCIPAL_SECRET']));
      for (const name of declared) {
        expect(name, `${name} is declared in env.ts`).not.toMatch(/PRIVATE_KEY|MNEMONIC|SEED|LEDGER_URL|SIGNER/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('creates no wallet client and derives no account from a key', () => {
    for (const { path, body } of shipped) {
      expect(body, path).not.toMatch(/createWalletClient|privateKeyToAccount|mnemonicToAccount/);
    }
  });

  /**
   * PublicClient-only is the production write-surface ban. Live tests may talk
   * to anvil through script helpers; production `src/` (non-test) must never
   * name a chain-write verb that would move a user's funds.
   */
  it('never sends a chain transaction from non-test source', () => {
    const production = shipped.filter((f) => !f.path.endsWith('.test.ts'));
    expect(production.length, 'expected production sources').toBeGreaterThan(5);
    for (const { path, body } of production) {
      expect(body, path).not.toMatch(/\b(sendTransaction|writeContract|sendRawTransaction|deployContract)\b/);
    }
  });

  it('EVM adapter constructs a PublicClient and never a WalletClient', async () => {
    // Build the adapter against viem as it is, noting each client it asks viem for.
    const made: string[] = [];
    vi.resetModules();
    vi.doMock('viem', async (importOriginal) => {
      const real = await importOriginal<typeof import('viem')>();
      return {
        ...real,
        createPublicClient: ((...args: Parameters<typeof real.createPublicClient>) => {
          made.push('public');
          return real.createPublicClient(...args);
        }) as typeof real.createPublicClient,
        createWalletClient: ((...args: Parameters<typeof real.createWalletClient>) => {
          made.push('wallet');
          return real.createWalletClient(...args);
        }) as typeof real.createWalletClient,
      };
    });
    try {
      const { EvmChainSource } = await import('./chain/evm/source.js');
      const source = new EvmChainSource({
        chainId: 1,
        rpcUrl: 'http://rpc.test:8545',
        venue: '0x1111111111111111111111111111111111111111',
      });
      expect(source).toBeDefined();
      expect(made.length).toBeGreaterThan(0);
      expect(new Set(made)).toEqual(new Set(['public']));
    } finally {
      vi.doUnmock('viem');
      vi.resetModules();
    }
  });

  it('tsconfig ships only src/** so scripts/ keys cannot enter dist', () => {
    const tsconfig = JSON.parse(readFileSync(join(serviceRoot, 'tsconfig.json'), 'utf8')) as {
      include?: string[];
    };
    expect(tsconfig.include).toEqual(['src/**/*']);
  });

  /**
   * A read model has no business writing anywhere but its own schema (§2).
   * Every table this service touches is declared in its own migration.
   *
   * The Postgres store is driven, every method of it, against a stand-in that
   * records each statement it is sent. Every INSERT, UPDATE and DELETE must name
   * one of the service's own tables, unqualified (the connection's search_path is
   * the service's schema), and nothing may move the search_path itself. A store
   * method not in the table below fails the test, so a new write is driven too.
   */
  it('writes to no schema but its own', async () => {
    const own = new Set([
      'blocks',
      'book_levels',
      'explorer_block_facts',
      'explorer_block_traces',
      'explorer_internal_txs',
      'explorer_pools',
      'explorer_swaps',
      'explorer_syncs',
      'explorer_tx_logs',
      'explorer_tokens',
      'explorer_transfers',
      'explorer_tx_seen',
      'explorer_txs',
      'fills',
      'positions',
    ]);
    const sent: string[] = [];
    const rows = () => Object.assign([], { count: 0 });
    const tag = (first: unknown, ..._values: unknown[]): unknown => {
      if (Array.isArray(first) && 'raw' in first) {
        sent.push(first.join('$?'));
        return Promise.resolve(rows());
      }
      // sql(rows, ...columns) and other helper forms: an inert fragment.
      return { fragment: true };
    };
    const sql = Object.assign(tag, {
      array: (v: unknown) => v,
      json: (v: unknown) => v,
      unsafe: async (text: string) => {
        sent.push(text);
        return rows();
      },
      begin: async (...args: unknown[]) => {
        const fn = args.at(-1);
        if (typeof fn !== 'function') throw new Error('begin without a callback');
        return fn(sql);
      },
    });
    const store = new PostgresProjectionStore(sql as never, CHAIN);

    const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
    const A = '0x' + 'a'.repeat(40);
    const B = '0x' + 'b'.repeat(40);
    const TX = '0x' + '1'.repeat(64);
    const block: ChainBlock = {
      chainId: CHAIN,
      height: 7,
      hash: '0x' + '7'.repeat(64),
      parentHash: '0x' + '6'.repeat(64),
      timestamp: 1_700_000_000,
      header: { gasUsed: 21_000n, gasLimit: 30_000_000n, baseFeePerGas: 7n, miner: A, txCount: 1, size: 600 },
      transactions: [
        {
          hash: TX,
          index: 0,
          from: A,
          to: B,
          valueWei: 1n,
          nonce: 0,
          gasLimit: 21_000n,
          gasPriceWei: 1n,
          gasConsumed: 21_000n,
          status: 'success',
          revertReason: null,
          input: '0x',
          createdContract: null,
          logs: [
            { logIndex: 0, address: B, topics: [ERC20_TRANSFER_TOPIC, `0x${word(A)}`, `0x${word(B)}`], data: `0x${word('0x5')}` },
            {
              logIndex: 1,
              address: B,
              topics: [POOL_CREATED_TOPIC, `0x${word(A)}`, `0x${word(B)}`],
              data: `0x${word('0x1e')}${word(A)}${word('0x1')}`,
            },
            {
              logIndex: 2,
              address: B,
              topics: [POOL_SWAP_TOPIC, `0x${word(A)}`, `0x${word(B)}`],
              data: `0x${word('0x1')}${word('0x0')}${word('0x0')}${word('0x2')}`,
            },
            { logIndex: 3, address: B, topics: [POOL_SYNC_TOPIC], data: `0x${word('0x9')}${word('0x8')}` },
          ],
        },
      ],
      tokens: [{ address: B, symbol: 'TEST', name: 'TEST token', decimals: 18 }],
      internal: { read: true, calls: [{ txHash: TX, path: '0', kind: 'call', from: A, to: B, valueWei: 1n }] },
      events: [
        { kind: 'book_level', logIndex: 4, market: 'TEST-USD', side: 'bid', price: '1.5', quantity: '2' },
        { kind: 'fill', logIndex: 5, market: 'TEST-USD', price: '1.5', quantity: '1', takerSide: 'buy', maker: A, taker: B },
        { kind: 'position', logIndex: 6, market: 'TEST-USD', account: A, size: '1', entryPrice: '1.5' },
      ],
    };
    const since = new Date('2026-11-01T00:00:00.000Z');
    const calls: Record<string, () => Promise<unknown>> = {
      head: () => store.head(),
      blockAt: () => store.blockAt(7),
      earliestHeight: () => store.earliestHeight(),
      explorerBlocks: () => store.explorerBlocks({ limit: 2 }),
      explorerAtHeight: () => store.explorerAtHeight(7),
      explorerBlock: () => store.explorerBlock({ height: 7 }),
      explorerTxList: () => store.explorerTxList({ limit: 2 }),
      explorerTx: () => store.explorerTx(TX),
      explorerAddressTxs: () => store.explorerAddressTxs({ address: A, limit: 2 }),
      explorerTokensBySymbol: () => store.explorerTokensBySymbol({ symbol: 'TEST', limit: 2 }),
      explorerPools: () => store.explorerPools({ factory: B, limit: 2 }),
      explorerPool: () => store.explorerPool({ factory: B, pool: A }),
      explorerPoolSwaps: () => store.explorerPoolSwaps({ pool: A, limit: 2 }),
      explorerPoolVolume: () => store.explorerPoolVolume({ pool: A, since }),
      explorerPoolCandles: () => store.explorerPoolCandles({ pool: A, since, seconds: 60, scale: '1m' }),
      explorerAddressInternal: () => store.explorerAddressInternal({ address: A, limit: 2 }),
      explorerTraceGaps: () => store.explorerTraceGaps(),
      explorerAddressTokens: () => store.explorerAddressTokens({ address: A, limit: 2 }),
      explorerBlockBefore: () => store.explorerBlockBefore(since),
      explorerTokensUnread: () => store.explorerTokensUnread(2),
      writeExplorerTokenFacts: () => store.writeExplorerTokenFacts(block.tokens ?? [], 7),
      noteExplorerTxPending: () => store.noteExplorerTxPending(TX, since),
      explorerTxPendingSince: () => store.explorerTxPendingSince(TX),
      applyBlock: () => store.applyBlock(block),
      unwindTo: () => store.unwindTo(7),
      prune: () => store.prune(7),
      book: () => store.book('TEST-USD', 2),
      bookFinalized: () => store.bookFinalized('TEST-USD', 2, 1),
      recentFills: () => store.recentFills('TEST-USD', 2),
      fillsForAccount: () => store.fillsForAccount(A, 2),
      position: () => store.position('TEST-USD', A),
      positionsOf: () => store.positionsOf(A, 2),
      markets: () => store.markets(2),
      // A private builder of the pool reads' SELECT; called through Reflect because TypeScript hides it.
      poolSelect: async () => Reflect.apply(Reflect.get(store, 'poolSelect'), store, []),
    };
    const methods = Object.getOwnPropertyNames(PostgresProjectionStore.prototype).filter((name) => name !== 'constructor');
    expect(
      methods.filter((name) => !(name in calls)),
      'a store method with no row in this table',
    ).toEqual([]);

    const WRITES = ['writeExplorerTokenFacts', 'noteExplorerTxPending', 'applyBlock', 'unwindTo', 'prune'];
    for (const name of methods) {
      // A write must go through; a read over no rows may refuse, and still must write nothing.
      if (WRITES.includes(name)) await calls[name]!();
      else await calls[name]!().catch(() => undefined);
    }

    const written = new Set<string>();
    for (const text of sent) {
      expect(text, 'moves the search_path').not.toMatch(/search_path|set_config/i);
      for (const match of text.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_][\w.]*)/gi)) {
        if (match[1]!.toLowerCase() === 'set') continue; // ON CONFLICT … DO UPDATE SET
        written.add(match[1]!.toLowerCase());
      }
    }
    expect(
      [...written].filter((table) => !own.has(table)),
      "a write outside the indexer's own tables",
    ).toEqual([]);
    // Every own table is written by some path above, so the check is not vacuous.
    expect([...written].sort()).toEqual([...own].sort());
  });
});
