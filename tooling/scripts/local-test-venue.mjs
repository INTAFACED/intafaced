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
 * It refuses to start unless APP_ENV is exactly `dev` or `test` (`refuseTestVenueOutsideTest`). Never part of a real
 * environment.
 *
 *   node tooling/scripts/local-test-venue.mjs   (TEST_VENUE_HOST, TEST_VENUE_PORT, TEST_VENUE_CHAIN_ID, APP_ENV)
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

/** Start the TEST venue and seed it. Resolves with the server and its URL. */
export async function serveTestVenue({ host, port, appEnv, chainId }) {
  if (!fs.existsSync(VENUE_SIM_DIST)) {
    throw new Error(`${path.relative(REPO, VENUE_SIM_DIST)} is not built: pnpm --filter @intafaced/venue-sim... build`);
  }
  const sim = await import(pathToFileURL(VENUE_SIM_DIST).href);
  const started = await sim.startTestVenueServer({ host, port, appEnv, chainId });
  const seeded = await sim.seedTestVenue(started.sim);
  process.stdout.write(
    `${JSON.stringify({ msg: 'test-venue.listening', label: 'TEST', url: started.url, chainId: started.sim.chainId, seeded: seeded.orders })}\n`,
  );
  return started;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveTestVenue({
    host: process.env.TEST_VENUE_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_VENUE_PORT ?? '14533'),
    // The RAW value: unset, blank and anything but dev or test refuse.
    appEnv: process.env.APP_ENV,
    chainId: testVenueChainId(process.env.TEST_VENUE_CHAIN_ID),
  }).catch((err) => {
    process.stderr.write(`test-venue: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
