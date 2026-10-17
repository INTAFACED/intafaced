import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Abi, Address } from 'viem';
import { formatAmount } from '@intafaced/ledger-client/money';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { EvmChainSource } from './source.js';
import { Indexer, ReorgTooDeepError } from '../../indexer.js';
import { MemoryProjectionStore } from '../../projection/memory-store.js';
import { PostgresProjectionStore } from '../../projection/postgres-store.js';
import type { BookLevel, ProjectionStore } from '../../projection/store.js';
import { createIndexerRouter } from '../../router.js';
import {
  DEV_CHAIN_ID,
  deployDevVenue,
  devChainClients,
  devChainReachable,
  devChainRequired,
  bumpNextTimestamp,
  marketWord,
  mine,
  reorgRpcUrl,
  revertTo,
  scaled,
  snapshot,
  type DevChainClients,
} from '../../../scripts/dev-venue.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A REAL CHAIN, REALLY FORKED, AND THE ROWS THAT MUST NOT SURVIVE IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the file the rest of svc-indexer exists to make possible.
 *
 * The reorg design — versioned rows, provenance on every write, repair by DELETE
 * — has been asserted since the service was written, but only ever against
 * `MemoryChainSource`: a fake whose hashes this repository computes, whose forks
 * this repository stages, and which therefore cannot disagree with the code in
 * any way the code did not anticipate. That proves the projection matches the
 * design. It does not prove that a chain behaves the way the design assumed.
 *
 * Here the fork is genuine. `evm_snapshot` / `evm_revert` make anvil DISCARD
 * blocks it has already published — blocks this indexer has already read,
 * projected and served — and the blocks mined afterwards occupy the same heights
 * with different hashes, because their transactions and timestamps differ.
 * Nothing is staged on our side: the node really does start answering
 * `eth_getBlockByNumber` with a different hash at a height we have written rows
 * for. That is exactly the shape that silently corrupts a naive projection, and
 * it is the shape nothing in this repo had ever actually produced.
 *
 * ── Why this runs against its own chain ────────────────────────────────────
 *
 * `evm_revert` rewinds the whole NODE. svc-protocol's live suites deploy
 * contracts to the shared `evm` service and read them back; if these two ran
 * concurrently — and `pnpm verify` runs package tasks in parallel — this file
 * would rewind svc-protocol's factory out of existence mid-test, and svc-protocol
 * would go red for a reason nobody could find in its own diff. So this suite
 * addresses `evm-reorg` (port 8546) and touches nothing else.
 *
 * ── Both stores, same scenario ─────────────────────────────────────────────
 *
 * The same reason the conformance suite runs twice. `unwindTo` is a DELETE and
 * `prune` is a DELETE with a correlated subquery — SQL that looks right and is
 * off by one row. The memory store is short enough to check by eye, so running
 * both against the same real chain is the check.
 *
 * Skips without a chain (named leftover, same class as pay `evm-chain.live`);
 * hard-fails on CI where `REQUIRE_EVM_CHAIN=1`. Chain-down is not PG-down.
 * When the chain is up, the Postgres half is H8a-hard: `TEST_DATABASE_URL` or
 * Testcontainers `postgres:16-alpine`. Docker/PG down throws; it does not skip-green.
 */

const rpcUrl = reorgRpcUrl();
const reachable = await devChainReachable(rpcUrl);

if (!reachable && devChainRequired()) {
  throw new Error(
    `REQUIRE_EVM_CHAIN=1 but no EVM RPC answered at ${rpcUrl}. This suite needs its OWN chain because it reorgs — ` +
      `start it with: docker compose up -d evm-reorg`,
  );
}

const MARKET = 'ETH-USD';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-indexer live reorg Postgres half is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

// Source pin is not behind the chain skip or the PG beforeAll — a missing EVM
// must not hide a PG skip-green regression.
describe('svc-indexer live reorg PG-hard (source)', () => {
  it('H8a PG half is not skip-green (no postgresAvailable / no Postgres describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(\s*['`]svc-indexer · live reorg · Postgres/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
    expect([...src.matchAll(/describe\.skip\s*\(/g)]).toHaveLength(1);
  });
});

if (!reachable) {
  describe.skip(`svc-indexer · live reorg (no chain at ${rpcUrl} — docker compose up -d evm-reorg)`, () => {
    it('skipped', () => undefined);
  });
} else {
  // Account index 7. Different from `source.live.test.ts` (6) and from anything
  // svc-protocol uses: vitest runs files in parallel workers, and two workers on
  // one deployer race the same nonce.
  const clients: DevChainClients = devChainClients(rpcUrl, DEV_CHAIN_ID, 7);
  const account = clients.walletClient.account!;
  const trader = clients.deployer.toLowerCase();

  let venue: Address;
  let abi: Abi;
  let source: EvmChainSource;

  beforeAll(async () => {
    // Deployed ONCE, before any snapshot is taken, so no revert in this file can
    // remove it. A test that reverted its own venue away would then be asserting
    // against `indexer.venue_not_deployed`, which is a different test.
    const deployed = await deployDevVenue(clients);
    venue = deployed.address;
    abi = deployed.abi;
    source = new EvmChainSource({ chainId: DEV_CHAIN_ID, rpcUrl, venue });
  }, 60_000);

  interface Branch {
    readonly price: string;
    readonly quantity: string;
    readonly fillQuantity: string;
    readonly size: string;
    readonly side?: number;
    readonly takerSide?: number;
  }

  /** One transaction carrying a level, a fill and a position. Returns its height. */
  async function publishAll(branch: Branch): Promise<number> {
    const hash = await clients.walletClient.writeContract({
      address: venue,
      abi,
      functionName: 'publishAll',
      args: [
        {
          market: marketWord(MARKET),
          side: branch.side ?? 0,
          levelPrice: scaled(branch.price),
          levelQuantity: scaled(branch.quantity),
          maker: clients.deployer,
          taker: clients.deployer,
          fillPrice: scaled(branch.price),
          fillQuantity: scaled(branch.fillQuantity),
          takerSide: branch.takerSide ?? 0,
          account: clients.deployer,
          size: scaled(branch.size),
          entryPrice: scaled(branch.price),
        },
      ],
      account,
      chain: clients.walletClient.chain,
    });
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
    return Number(receipt.blockNumber);
  }

  function ladder(rows: readonly BookLevel[]): string[][] {
    return rows.map((l) => [formatAmount(l.price), formatAmount(l.quantity)]);
  }

  async function chainHeight(): Promise<number> {
    return Number(await clients.publicClient.getBlockNumber({ cacheTime: 0 }));
  }

  /**
   * A fresh indexer, starting on a freshly mined EMPTY block.
   *
   * Both halves matter. `startHeight` is set at all because the `evm-reorg` node
   * accumulates blocks across the whole file, and indexing from 0 every time
   * would re-read history that provably holds nothing for the test in hand.
   *
   * And the block is mined empty first because the chain's current tip is
   * whatever the PREVIOUS test left on it — a test that started there would index
   * another test's fill and count it as its own. That is not a hypothetical: it
   * is what the first run of the idempotency test below actually did, and it
   * reported three fills where two were written.
   */
  async function indexerOver(store: ProjectionStore, finalityDepth = 64): Promise<Indexer> {
    await mine(clients.publicClient, 1);
    return new Indexer({
      source,
      store,
      finalityDepth,
      batchSize: 500,
      startHeight: await chainHeight(),
      ingestEnabled: () => true,
    });
  }

  interface Harness {
    readonly label: string;
    store(): ProjectionStore;
    reset(): Promise<void>;
  }

  function runLiveReorgSuite(harness: Harness) {
    describe(`svc-indexer · live reorg · ${harness.label}`, () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE TEST THIS SERVICE WAS BUILT FOR
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Rows written from a block that the chain later discards must not survive
       * it. Not corrected later, not averaged in, not left behind as a level
       * nobody quoted — gone, as if the block had never been read.
       *
       * The failure being defended against has no symptom. A projection that
       * overwrote the current value cannot restore it, so after a fork it serves
       * a price that was never on the canonical chain: no error, no gap, no
       * alert. The user just sees a number.
       */
      it('deletes every row an orphaned block wrote, and re-projects the winner', async () => {
        await harness.reset();
        const store = harness.store();
        const indexer = await indexerOver(store);

        // Catch up to the fork point, so the projection has a head to be wrong about.
        await mine(clients.publicClient, 1);
        await indexer.sync();
        const forkPoint = (await store.head())!;

        const snap = await snapshot(clients.publicClient);

        // ── Branch A: what the indexer sees, projects, and would serve ───────
        const branchABlock = await publishAll({ price: '3000.5', quantity: '2.25', fillQuantity: '0.5', size: '0.5' });
        await mine(clients.publicClient, 2);
        await indexer.sync();

        const headA = (await store.head())!;
        expect(headA.height).toBeGreaterThan(forkPoint.height);
        expect(ladder((await store.book(MARKET, 10)).bids)).toEqual([['3000.5', '2.25']]);

        const fillsA = await store.recentFills(MARKET, 10);
        expect(fillsA).toHaveLength(1);
        expect(formatAmount(fillsA[0]!.quantity)).toBe('0.5');
        const orphanedBlockHash = fillsA[0]!.blockHash;
        expect(formatAmount((await store.position(MARKET, trader))!.size)).toBe('0.5');

        // The read model states which block it is confirmed to — the question a
        // reorg makes real. A bare price ladder could not answer it.
        const bookA = await store.book(MARKET, 10);
        expect(bookA.asOfHeight).toBe(headA.height);
        expect(bookA.asOfHash).toBe(headA.hash);

        // ── The fork. The node discards blocks it already published. ─────────
        expect(await revertTo(clients.publicClient, snap)).toBe(true);
        // Push the replacement branch's timestamps forward. Branch B's blocks
        // differ by their transactions anyway, but an EMPTY replacement branch at
        // the same height, same parent and same second would be byte-identical —
        // i.e. the same block — and a test that built one would assert nothing.
        await bumpNextTimestamp(clients.publicClient, 120);

        // ── Branch B: a different price, a different size, the same heights ──
        const branchBBlock = await publishAll({ price: '4000', quantity: '1', fillQuantity: '0.25', size: '-0.25', takerSide: 1 });
        await mine(clients.publicClient, 2);
        expect(branchBBlock).toBe(branchABlock); // same height, and about to be a different block

        await indexer.sync();

        // ── What must be true now ───────────────────────────────────────────
        const bookB = await store.book(MARKET, 10);
        // 3000.5 is GONE. Not merged, not left at zero, not sitting under the new
        // level as a second rung nobody ever quoted.
        expect(ladder(bookB.bids)).toEqual([['4000', '1']]);

        const fillsB = await store.recentFills(MARKET, 10);
        // ONE fill, not two. An append-only tape that kept the orphan would show
        // a trade that never happened, forever.
        expect(fillsB).toHaveLength(1);
        expect(formatAmount(fillsB[0]!.quantity)).toBe('0.25');
        expect(fillsB[0]!.takerSide).toBe('sell');
        expect(fillsB[0]!.blockHash).not.toBe(orphanedBlockHash);

        // The position is the winner's, and it is signed — short is a real state.
        expect(formatAmount((await store.position(MARKET, trader))!.size)).toBe('-0.25');

        // And the account's own tape agrees with the market's.
        const accountTape = await store.fillsForAccount(trader, 10);
        expect(accountTape).toHaveLength(1);
        expect(accountTape[0]!.blockHash).not.toBe(orphanedBlockHash);

        // Provenance: the block at that height is now a DIFFERENT block, and the
        // projection says so rather than keeping the old hash next to new rows.
        const rewritten = await store.blockAt(branchABlock);
        expect(rewritten!.hash).not.toBe(orphanedBlockHash);
        expect(rewritten!.status).toBe('canonical');

        // The head is current with the chain again.
        const finalHead = (await store.head())!;
        expect(finalHead.hash).toBe((await source.head())!.hash);
      }, 120_000);

      /**
       * A reorg the indexer must notice WITHOUT being handed a longer chain.
       *
       * The common shape, and the one every "is there a next block?" loop misses:
       * the tip is replaced, not extended. Nothing about the height changes, so an
       * indexer that only ever looks forward keeps extending a branch that no
       * longer exists — and the source keeps answering, because from its point of
       * view the questions are perfectly ordinary.
       */
      it('notices a fork that replaces the tip without extending it', async () => {
        await harness.reset();
        const store = harness.store();
        const indexer = await indexerOver(store);

        await mine(clients.publicClient, 1);
        await indexer.sync();

        const snap = await snapshot(clients.publicClient);
        await publishAll({ price: '111', quantity: '1', fillQuantity: '1', size: '1' });
        await indexer.sync();
        const headA = (await store.head())!;

        await revertTo(clients.publicClient, snap);
        await bumpNextTimestamp(clients.publicClient, 120);
        await publishAll({ price: '222', quantity: '2', fillQuantity: '2', size: '2' });

        // Same height, different block.
        expect(await chainHeight()).toBe(headA.height);

        const result = await indexer.sync();
        expect(result.reorgs).toBeGreaterThan(0);
        expect(result.blocksOrphaned).toBeGreaterThan(0);

        const headB = (await store.head())!;
        expect(headB.height).toBe(headA.height);
        expect(headB.hash).not.toBe(headA.hash);
        expect(ladder((await store.book(MARKET, 10)).bids)).toEqual([['222', '2']]);
      }, 120_000);

      /**
       * IDEMPOTENCY, against real chain data.
       *
       * "If the indexer dies mid-block, does restart produce the same state?"
       * `applyBlock` is one transaction, so a half-applied block is not a state
       * that exists — but the state that DOES exist after a crash is "this block
       * was written and the process died before anything recorded that it had
       * been", and the restart re-reads it. Doing that must be a no-op.
       *
       * Two shapes, because they fail differently:
       *   · a fresh `Indexer` over the same store — the actual restart path
       *   · re-applying each block through `applyBlock` directly — the write path
       *     itself, with no loop to skip it
       */
      it('re-indexes the same real blocks to a byte-identical read model', async () => {
        await harness.reset();
        const store = harness.store();
        const indexer = await indexerOver(store);

        await mine(clients.publicClient, 1);
        await indexer.sync();
        const from = (await store.head())!.height;

        await publishAll({ price: '1234.5', quantity: '3', fillQuantity: '1.5', size: '1.5' });
        await publishAll({ price: '1234.5', quantity: '0', fillQuantity: '0.25', size: '1.75', side: 1 });
        await indexer.sync();

        const snapshotOf = async () => ({
          head: (await store.head())!.hash,
          bids: ladder((await store.book(MARKET, 20)).bids),
          asks: ladder((await store.book(MARKET, 20)).asks),
          fills: (await store.recentFills(MARKET, 50)).map((f) => `${f.blockHash}:${f.logIndex}:${formatAmount(f.quantity)}`),
          position: formatAmount((await store.position(MARKET, trader))!.size),
        });

        const before = await snapshotOf();
        expect(before.fills).toHaveLength(2);

        // (1) The restart path: a brand-new Indexer over the same store, told to
        // start from the beginning of what it already has.
        const restarted = new Indexer({
          source,
          store,
          finalityDepth: 64,
          batchSize: 500,
          startHeight: from,
          ingestEnabled: () => true,
        });
        const result = await restarted.sync();
        expect(result.blocksApplied).toBe(0); // already at the tip; nothing to do
        expect(result.reorgs).toBe(0);
        expect(await snapshotOf()).toEqual(before);

        // (2) The write path itself. Absolute state, so the upsert is an
        // assignment and applying it twice reaches the same value. A relative
        // delta applied twice would corrupt the level, and no primary key catches
        // that.
        const head = (await store.head())!.height;
        for (let height = from; height <= head; height += 1) {
          const block = await source.blockAt(height);
          const outcome = await store.applyBlock(block!);
          expect(outcome.duplicate).toBe(true);
        }
        expect(await snapshotOf()).toEqual(before);
      }, 120_000);

      /**
       * The failure this design deliberately does NOT solve, proven against a
       * real chain rather than a staged one.
       *
       * Below the retained horizon the superseded versions are gone, so an unwind
       * would delete a level's last surviving row and leave a book with holes in
       * it. `findForkPoint` refuses instead: it halts, and `/ready` starts
       * failing. A reorg that deep is a chain-level event and the honest answers
       * are "stop serving" and "re-index" — not "guess, and hope the guess is
       * invisible".
       */
      it('halts rather than guessing when the fork is deeper than retained history', async () => {
        await harness.reset();
        const store = harness.store();
        // finalityDepth 1: anything more than one block back is unrepairable.
        const indexer = await indexerOver(store, 1);

        await mine(clients.publicClient, 1);
        await indexer.sync();

        const snap = await snapshot(clients.publicClient);
        await publishAll({ price: '900', quantity: '1', fillQuantity: '1', size: '1' });
        await mine(clients.publicClient, 4);
        await indexer.sync();

        await revertTo(clients.publicClient, snap);
        await bumpNextTimestamp(clients.publicClient, 120);
        await publishAll({ price: '800', quantity: '1', fillQuantity: '1', size: '1' });
        await mine(clients.publicClient, 4);

        await expect(indexer.sync()).rejects.toBeInstanceOf(ReorgTooDeepError);
        expect(indexer.halted).not.toBeNull();
        expect(indexer.halted!.reason).toContain('Reorg deeper than retained history');

        // A halted indexer stops advancing rather than serving on regardless.
        const idle = await indexer.sync();
        expect(idle.idle).toBe('halted');
        expect(idle.blocksApplied).toBe(0);
      }, 120_000);

      /**
       * STALENESS, stated rather than implied.
       *
       * "Height 8412" means nothing on its own. A read model that cannot say how
       * far behind the chain it is gets trusted at exactly the moment it should
       * not be — and `behindBy` must never default to zero, because zero reads as
       * "current".
       */
      it('states how stale it is, through the API a caller actually sees', async () => {
        await harness.reset();
        const store = harness.store();
        // The book is served as of the FINALIZED height (head − finalityDepth), not the head. With the
        // default depth of 64 on a dev chain only a few dozen blocks tall nothing is finalized yet and
        // asOfHeight is null, so use a small depth that this test's own blocks can clear.
        const finalityDepth = 2;
        const indexer = await indexerOver(store, finalityDepth);
        const router = createIndexerRouter({
          store,
          indexer,
          chainId: DEV_CHAIN_ID,
          finalityDepth,
          ingestEnabled: () => true,
          chainSource: 'evm',
          chainProbe: () => source.probe(),
        });
        const caller = router.createCaller({ requestId: 'live', region: 'DE', principal: null } as never);

        await publishAll({ price: '77', quantity: '1', fillQuantity: '1', size: '1' });
        // Bury the publish block by `finalityDepth` so it is finalized (and held) when the book is read.
        await mine(clients.publicClient, finalityDepth);
        await indexer.sync();

        const current = await caller.status();
        expect(current.chainSource).toBe('evm');
        expect(current.chain).toMatchObject({ kind: 'evm', reachable: true, venueDeployed: true, observedChainId: DEV_CHAIN_ID });
        expect(current.behindBy).toBe(0);
        expect(current.lastError).toBeNull();
        expect(current.halted).toBeNull();

        // Fall behind on purpose. Nothing else about the response changes — which
        // is precisely why the cursor alone cannot be the staleness signal.
        await mine(clients.publicClient, 5);
        const behind = await caller.status();
        expect(behind.indexedHeight).toBe(current.indexedHeight);
        expect(behind.behindBy).toBe(5);
        expect(behind.chain!.chainHeight).toBe(behind.indexedHeight! + 5);

        // The book still says which block it is confirmed to, so a client holding
        // both can tell how old the ladder in front of it is. Since #4563 that block
        // is the finalized one: finalityDepth behind the indexed head, not the head.
        const book = await caller.book({ market: MARKET, depth: 5 });
        expect(behind.finalizedHeight).toBe(behind.indexedHeight! - finalityDepth);
        expect(book.asOfHeight).toBe(behind.finalizedHeight);
      }, 120_000);

      /**
       * A pass that ends in neither progress nor a halt. The endpoint dies, the
       * cursor freezes at a perfectly plausible number, and without `lastError`
       * nothing on the status response would differ from a healthy idle indexer.
       */
      it('records WHY a pass could not advance, instead of freezing quietly', async () => {
        await harness.reset();
        const store = harness.store();
        await mine(clients.publicClient, 1);

        const live = await indexerOver(store);
        await live.sync();
        expect(live.lastError).toBeNull();

        // Port 1: reserved, nothing has ever listened there.
        const dead = new Indexer({
          source: new EvmChainSource({ chainId: DEV_CHAIN_ID, rpcUrl: 'http://127.0.0.1:1', venue, requestTimeoutMs: 2_000 }),
          store,
          finalityDepth: 64,
          batchSize: 10,
          startHeight: 0,
          ingestEnabled: () => true,
        });
        await expect(dead.sync()).rejects.toMatchObject({ code: 'indexer.chain_unreachable' });
        expect(dead.lastError).toMatchObject({ code: 'indexer.chain_unreachable' });
        expect(dead.lastError!.message).toContain('127.0.0.1:1');

        // …and it clears when a pass succeeds again, so it describes the present
        // rather than an incident that has since resolved itself.
        await live.sync();
        expect(live.lastError).toBeNull();
      }, 120_000);
    });
  }

  runLiveReorgSuite({
    label: 'MemoryProjectionStore',
    store: () => memoryStore,
    reset: async () => {
      memoryStore = new MemoryProjectionStore(DEV_CHAIN_ID);
    },
  });
  let memoryStore = new MemoryProjectionStore(DEV_CHAIN_ID);

  // ── The same scenario, against real Postgres (H8a-hard when chain is up) ──
  //
  // `unwindTo` is a DELETE and `prune` is a DELETE with a correlated subquery.
  // The memory store's versions are short enough to check by eye; the SQL is the
  // kind that looks right and is off by one row. Chain-down still skips the
  // whole live file (named leftover). PG-down with the chain up must throw.
  describe('svc-indexer · live reorg · PostgresProjectionStore PG-hard', () => {
    let adminStop: () => Promise<void> = async () => undefined;
    let db!: TestDb;

    beforeAll(async () => {
      const migrationFiles = readdirSync(drizzleDir)
        .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
        .sort();
      if (migrationFiles.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

      const admin = await openH8aAdmin();
      adminStop = admin.stop;
      db = await createTestDb({
        service: 'indexer',
        url: admin.url,
        migrations: migrationFiles.map((f) => {
          const body = readFileSync(join(drizzleDir, f), 'utf8');
          return (schema: string) => rewriteSchemaSql(body, 'indexer', schema);
        }),
      });
    }, 120_000);

    afterAll(async () => {
      await db?.drop();
      await adminStop();
    });

    runLiveReorgSuite({
      label: 'PostgresProjectionStore',
      store: () => new PostgresProjectionStore(db.sql, DEV_CHAIN_ID),
      reset: async () => {
        await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      },
    });
  });
}
