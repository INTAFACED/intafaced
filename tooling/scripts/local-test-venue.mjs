/**
 * LOCAL TEST venue: one TEST venue simulator (packages/venue-sim, proof level `simulator`) behind loopback HTTP, for
 * svc-trade's user-venue door (TRADE_USER_VENUE_URL). Every figure it reports is TEST. It is its own process, so "venue
 * down" is a real outside failure, its TEST makers trade as outside participants, and no simulator code runs inside
 * svc-trade (project-state #1789, the plan's item 1).
 *
 * Markets BTC-USDC (cash spot) and BTC-PERP (isolated margin only). The EIP-712 domain names the stack's TEST app chain
 * (`TEST_VENUE_CHAIN_ID`, default 84532, apps/customer/src/features/protocol/wallet/eip1193.ts APP_CHAIN_ID), so the
 * customer's wallet signs on the network it is already on. Routes: packages/venue-sim/src/http-server.ts. A `seed` is
 * run at start, so a taker always meets a two-sided ladder.
 *
 * Deposits and withdrawals (J-wallet-09 #3 and #5): with `TEST_VENUE_RPC_URL` (the stack's LOCAL TEST anvil) and
 * `TEST_VENUE_DEPOSIT_TOKEN` (its TEST USD token) set, the venue takes deposits of that token at its TEST deposit address
 * and credits the sender's account as USDC, and pays withdrawals back on that chain (packages/venue-sim
 * src/chain-deposits.ts). Either blank, `GET /venue` names no deposit route and nothing watches a chain.
 *
 * It refuses to start unless APP_ENV is exactly `dev` or `test` (`refuseTestVenueOutsideTest`). Never part of a real
 * environment.
 *
 *   node tooling/scripts/local-test-venue.mjs   (TEST_VENUE_HOST, TEST_VENUE_PORT, TEST_VENUE_CHAIN_ID, APP_ENV,
 *                                                TEST_VENUE_RPC_URL, TEST_VENUE_DEPOSIT_TOKEN, TEST_VENUE_ID)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TEST_CHAIN_ID } from './local-test-chain.mjs';
import { STACK_PORTS } from './local-test-facts.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The built simulator. The stack builds it with svc-trade (a dev dependency there); a bare run says how to build it. */
export const VENUE_SIM_DIST = path.join(REPO, 'packages', 'venue-sim', 'dist', 'index.js');
/** The built Hyperliquid test network adapter, built with svc-trade too (a dev dependency there). */
const VENUE_HL_DIST = path.join(REPO, 'packages', 'venue-hyperliquid', 'dist', 'index.js');

/** The stack's TEST app chain (local-test-chain.mjs; the same id as eip1193.ts APP_CHAIN_ID). */
export const TEST_APP_CHAIN_ID = TEST_CHAIN_ID;

/** Parse the chain id the venue's domain names; blank is the stack's app chain. */
export function testVenueChainId(raw) {
  const text = (raw ?? '').trim();
  if (text === '') return TEST_APP_CHAIN_ID;
  if (!/^[1-9][0-9]{0,15}$/.test(text)) throw new Error(`TEST_VENUE_CHAIN_ID must be a positive whole number, got ${JSON.stringify(raw)}`);
  return Number(text);
}

/**
 * The TEST venue's id from `TEST_VENUE_ID`: blank is the simulator's own default (`test-venue-sim`), anything else must be
 * `test-venue-sim-` and 4 to 16 lower-case letters or digits. The journeys give each file a venue of its own under a fresh
 * id (apps/customer/tests/real-app/world-restore.mjs `ownVenueFor`), so what svc-trade and the ledger keep by venue id
 * (listings, builder-fee versions, the builder-fee receivable) is that file's own as well. Returns null for the default.
 */
export function testVenueId(raw) {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  if (!/^test-venue-sim-[a-z0-9]{4,16}$/.test(text))
    throw new Error(`TEST_VENUE_ID must be test-venue-sim- and 4 to 16 lower-case letters or digits, got ${JSON.stringify(raw)}`);
  return text;
}

/**
 * `LOCAL_STACK_USER_VENUE`: unset, blank or `off` is off, `on` is on, anything else throws. The one reading of the switch,
 * shared by the stack (which starts the TEST venue) and trade's env (which points the door at it), so the two never disagree.
 */
export function userVenueSwitchOn(raw) {
  return userVenueCount(raw) > 0;
}

/**
 * How many TEST venues the switch asks for: 0 (unset, blank, `off`), 1 (`on`), or 2 (`two`: the first venue and a second
 * TEST venue beside it, for the routing journey J-derivatives-28). Anything else throws.
 */
export function userVenueCount(raw) {
  const text = (raw ?? '').trim();
  if (text === '' || text === 'off') return 0;
  if (text === 'on' || text === 'hl-recorded' || text === 'hl-testnet') return 1;
  if (text === 'two') return 2;
  throw new Error(`LOCAL_STACK_USER_VENUE must be unset, off, on, two, hl-recorded or hl-testnet (got ${JSON.stringify(raw)})`);
}

/**
 * Which venue the first TEST venue is (#10203): `sim`, the TEST venue simulator (`on`, `two`); `hl-recorded`, the
 * Hyperliquid test network adapter answering from its recording (packages/venue-hyperliquid recordings/, no network);
 * `hl-testnet`, the same adapter on the live Hyperliquid test network. Null when the switch is off. Anything else throws.
 */
export function userVenueKind(raw) {
  if (userVenueCount(raw) === 0) return null;
  const text = (raw ?? '').trim();
  return text === 'hl-recorded' || text === 'hl-testnet' ? text : 'sim';
}

/**
 * The second TEST venue (J-derivatives-28): its own id and name, and a deeper TEST ladder (5 BTC a level against the first
 * venue's 1), so one order the first venue's shown depth can't fill at its shown price has a venue that can.
 */
/** TEST: the most orders the first TEST venue takes in one signed action. */
export const FIRST_TEST_VENUE_ORDERS_PER_ACTION = 10;
export const SECOND_TEST_VENUE = { id: 'test-venue-sim-b', displayName: 'TEST venue simulator B', levelSize: '5' };

/**
 * The TEST venue's deposit address on the stack's TEST chain. It has no key: the venue pays withdrawals from it by
 * impersonating it on that anvil only (as the stack's TEST fee relayer is), so nothing can sign for it anywhere else.
 */
export const TEST_VENUE_DEPOSIT_ADDRESS = '0x00000000000000000000000000000000de905170';
/** The venue asset a deposit of the TEST chain's TEST USD (6 decimals) is credited as. TEST. */
export const TEST_VENUE_DEPOSIT_ASSET = 'USDC';
const TEST_USD_DECIMALS = 6;
/**
 * The TEST venue's published deposit terms (J-dex-protocol-05 #1 and #2), all TEST: a transfer under 5 TEST USDC is never
 * credited, one is credited after 3 confirmations on the TEST chain, and its warning names the one chain and token. The stack's anvil mines a block per transaction
 * only, so a journey that waits for confirmations mines the blocks itself (`evm_mine`, the TEST chain's own control).
 */
export const TEST_VENUE_DEPOSIT_TERMS = {
  minimum: '5',
  confirmations: 3,
  network: 'TEST chain',
  // The venue's own warning for a transfer on any other chain (J-wallet-24 #1), as a real bridge publishes one. TEST.
  warning:
    'TEST: send only TEST USDC on TEST chain to this address. A transfer on any other chain, or of any other token, is not credited.',
};
/**
 * The TEST chain's explorer is the app's own (/chain/tx/<hash>, which reads the stack's TEST chain), so the TEST venue links
 * each deposit there. A journey switches it off (`/test/switches {depositExplorerTxUrl: null}`) for a network with none.
 */
export const TEST_VENUE_DEPOSIT_EXPLORER = '/chain/tx/';

/** The least time ahead the first TEST venue takes a scheduled cancel (J-cex-spot-07): 5 s, as Hyperliquid's own rule. TEST. */
export const FIRST_TEST_VENUE_SCHEDULED_CANCEL_MIN_LEAD_MS = 5_000;

/**
 * The deposit route for this venue, or null when the TEST chain or its token is not given. Its chain is the stack's TEST
 * chain (anvil, TEST_APP_CHAIN_ID), whatever chain the venue's signing domain names (TEST_VENUE_CHAIN_ID).
 */
export function testVenueDepositRoute({ rpcUrl, token }) {
  const r = (rpcUrl ?? '').trim();
  const t = (token ?? '').trim().toLowerCase();
  if (r === '' || t === '') return null;
  if (!/^0x[0-9a-f]{40}$/.test(t)) throw new Error(`TEST_VENUE_DEPOSIT_TOKEN must be a 0x address, got ${JSON.stringify(token)}`);
  return {
    chainId: TEST_APP_CHAIN_ID,
    token: t,
    tokenDecimals: TEST_USD_DECIMALS,
    address: TEST_VENUE_DEPOSIT_ADDRESS,
    asset: TEST_VENUE_DEPOSIT_ASSET,
    ...TEST_VENUE_DEPOSIT_TERMS,
  };
}

/**
 * Start the TEST venue and seed it, and, with a TEST chain, its deposit watcher. Resolves with the server and its URL.
 * `id` (testVenueId) names the venue; the second venue is then `<id>-b`. Null keeps the simulator's defaults.
 */
export async function serveTestVenue({
  host,
  port,
  appEnv,
  betaPosture,
  chainId,
  rpcUrl = '',
  depositToken = '',
  second = false,
  id = null,
  kind = 'sim',
}) {
  if (!second && (kind === 'hl-recorded' || kind === 'hl-testnet')) return serveHyperliquidVenue({ host, port, appEnv, betaPosture, kind });
  if (!fs.existsSync(VENUE_SIM_DIST)) {
    throw new Error(`${path.relative(REPO, VENUE_SIM_DIST)} is not built: pnpm --filter @intafaced/venue-sim... build`);
  }
  const sim = await import(pathToFileURL(VENUE_SIM_DIST).href);
  const deposit = second ? null : testVenueDepositRoute({ rpcUrl, token: depositToken });
  // The first TEST venue takes several orders in one signed action, as the venue it stands for does (J-derivatives-03 #9);
  // the second takes one order per signature, so the app's other branch runs against a venue too. The second also offers
  // hedge mode and moves an open position between accounts, which the first, as the venue it stands for, does not
  // (J-derivatives-05 #3 #7).
  const which = second
    ? {
        id: id ? `${id}-b` : SECOND_TEST_VENUE.id,
        displayName: SECOND_TEST_VENUE.displayName,
        positionModes: ['one_way', 'hedge'],
        positionMoves: true,
      }
    : {
        ...(id ? { id } : {}),
        ordersPerAction: FIRST_TEST_VENUE_ORDERS_PER_ACTION,
        // The first TEST venue has a scheduled cancel, as the venue it stands for does (J-cex-spot-07): at least 5 s ahead.
        scheduledCancelMinLeadMs: FIRST_TEST_VENUE_SCHEDULED_CANCEL_MIN_LEAD_MS,
      };
  const started = await sim.startTestVenueServer({ host, port, appEnv, betaPosture, chainId, deposit, ...which });
  const seeded = await sim.seedTestVenue(started.sim, second ? { levelSize: SECOND_TEST_VENUE.levelSize } : {});
  const log = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
  if (deposit) started.sim.switches.depositExplorerTxUrl = TEST_VENUE_DEPOSIT_EXPLORER;
  if (deposit) await sim.startChainDeposits({ sim: started.sim, route: deposit, rpcUrl, log });
  log({ msg: 'test-venue.listening', label: 'TEST', url: started.url, chainId: started.sim.chainId, seeded: seeded.orders, deposit });
  return started;
}

/**
 * `TEST_VENUE_KIND`, as the stack hands it to the venue process (`userVenueKind` of the switch): blank or `sim` is the
 * simulator, `hl-recorded` and `hl-testnet` the Hyperliquid test network adapter. Anything else throws.
 */
export function testVenueKind(raw) {
  const text = (raw ?? '').trim();
  if (text === '' || text === 'sim') return 'sim';
  if (text === 'hl-recorded' || text === 'hl-testnet') return text;
  throw new Error(`TEST_VENUE_KIND must be sim, hl-recorded or hl-testnet (got ${JSON.stringify(raw)})`);
}

/**
 * The Hyperliquid test network as the stack's venue (#10203), behind the same HTTP venue protocol svc-trade reaches every
 * venue over. `hl-recorded` answers from the adapter's recording with no network: an order the recording does not hold
 * gets the recorded answer of its kind, and a read it has no kind for is the venue down. `hl-testnet` reaches the live
 * test network (api.hyperliquid-testnet.xyz); the customer's own wallet signs, so the venue holds no key.
 */
async function serveHyperliquidVenue({ host, port, appEnv, betaPosture, kind }) {
  if (!fs.existsSync(VENUE_HL_DIST)) {
    throw new Error(`${path.relative(REPO, VENUE_HL_DIST)} is not built: pnpm --filter @intafaced/venue-hyperliquid... build`);
  }
  const hl = await import(pathToFileURL(VENUE_HL_DIST).href);
  const fetch = kind === 'hl-recorded' ? hl.replayRecording(hl.loadOrderRecording()) : undefined;
  const started = await hl.startHyperliquidVenueServer({ host, port, appEnv, betaPosture, ...(fetch ? { fetch } : {}) });
  process.stdout.write(
    `${JSON.stringify({ msg: 'test-venue.listening', label: 'TEST', url: started.url, venue: started.venue.venue.id, kind })}\n`,
  );
  return started;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveTestVenue({
    host: process.env.TEST_VENUE_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_VENUE_PORT ?? STACK_PORTS['test-venue']),
    // The RAW value: unset, blank and anything but dev or test refuse.
    appEnv: process.env.APP_ENV,
    // The beta posture (APP_ENV staging, INTAFACED_BETA_POSTURE=test-networks) also lets the TEST venue run.
    betaPosture: process.env.INTAFACED_BETA_POSTURE,
    chainId: testVenueChainId(process.env.TEST_VENUE_CHAIN_ID),
    rpcUrl: process.env.TEST_VENUE_RPC_URL,
    depositToken: process.env.TEST_VENUE_DEPOSIT_TOKEN,
    id: testVenueId(process.env.TEST_VENUE_ID),
    kind: testVenueKind(process.env.TEST_VENUE_KIND),
  }).catch((err) => {
    process.stderr.write(`test-venue: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
