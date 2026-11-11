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
 *                                                TEST_VENUE_RPC_URL, TEST_VENUE_DEPOSIT_TOKEN)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TEST_CHAIN_ID } from './local-test-chain.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The built simulator. The stack builds it with svc-trade (a dev dependency there); a bare run says how to build it. */
export const VENUE_SIM_DIST = path.join(REPO, 'packages', 'venue-sim', 'dist', 'index.js');

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
  if (text === 'on') return 1;
  if (text === 'two') return 2;
  throw new Error(`LOCAL_STACK_USER_VENUE must be unset, off, on or two (got ${JSON.stringify(raw)})`);
}

/**
 * The second TEST venue (J-derivatives-28): its own id and name, and a deeper TEST ladder (5 BTC a level against the first
 * venue's 1), so one order the first venue's shown depth can't fill at its shown price has a venue that can.
 */
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
  };
}

/** Start the TEST venue and seed it, and, with a TEST chain, its deposit watcher. Resolves with the server and its URL. */
export async function serveTestVenue({ host, port, appEnv, chainId, rpcUrl = '', depositToken = '', second = false }) {
  if (!fs.existsSync(VENUE_SIM_DIST)) {
    throw new Error(`${path.relative(REPO, VENUE_SIM_DIST)} is not built: pnpm --filter @intafaced/venue-sim... build`);
  }
  const sim = await import(pathToFileURL(VENUE_SIM_DIST).href);
  const deposit = second ? null : testVenueDepositRoute({ rpcUrl, token: depositToken });
  const which = second ? { id: SECOND_TEST_VENUE.id, displayName: SECOND_TEST_VENUE.displayName } : {};
  const started = await sim.startTestVenueServer({ host, port, appEnv, chainId, deposit, ...which });
  const seeded = await sim.seedTestVenue(started.sim, second ? { levelSize: SECOND_TEST_VENUE.levelSize } : {});
  const log = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
  if (deposit) await sim.startChainDeposits({ sim: started.sim, route: deposit, rpcUrl, log });
  log({ msg: 'test-venue.listening', label: 'TEST', url: started.url, chainId: started.sim.chainId, seeded: seeded.orders, deposit });
  return started;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveTestVenue({
    host: process.env.TEST_VENUE_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_VENUE_PORT ?? '14560'),
    // The RAW value: unset, blank and anything but dev or test refuse.
    appEnv: process.env.APP_ENV,
    chainId: testVenueChainId(process.env.TEST_VENUE_CHAIN_ID),
    rpcUrl: process.env.TEST_VENUE_RPC_URL,
    depositToken: process.env.TEST_VENUE_DEPOSIT_TOKEN,
  }).catch((err) => {
    process.stderr.write(`test-venue: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
