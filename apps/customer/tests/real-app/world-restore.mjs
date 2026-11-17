import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EDGE, ORIGIN, DEVICE_KEY, ROOT, json, stackUrl, tool, worldState } from './stack.mjs';
import { declaredWorld, marketLive } from './world-line.mjs';
import { STATUS_MS, healStack } from './services.mjs';
import { MAKER_SETTLE_MS, makerEmails, makerRecordArgs, makerSettled } from './market.mjs';

/**
 * Putting the shared world back between journey files (world-line.mjs, held by tooling/scripts/journey-world.mjs). Each file declares, in its
 * `// World:` line, what it changes; before the next file's first step this takes down what the last file left:
 *
 * - book: every open order, running algo and running grid bot of the TEST accounts the file signed up or acted as;
 * - market: every TEST price `move`, and the market maker started again if it was running when the file began.
 *
 * The TEST venue is not put back: each file gets one of its own (`ownVenueFor`, below), whatever its line says.
 *
 * Failure it prevents: J-copy-bots-otc-30 #1 left a TEST bid resting on BTC/USDT, J-ops-console-08 #7 restarted the
 * market maker over it, and J-portfolio-04 #1 timed out on main (run 1247), though its code passed alone (run 1262).
 * The posting freeze already has its own guard (journey-freeze-guard.mjs). Gates, restarts and the stack's global
 * tools are declared and scanned (journey-world.mjs) but not put back here: part B runs those files alone.
 *
 * Nothing here fails a step: what could not be put back is printed with "WORLD RESTORE", naming the file that left it.
 */

/** The parts a journey file declares, or every part when the line cannot be read (restore more, never less). */
function worldOf(file) {
  try {
    return declaredWorld(fs.readFileSync(file, 'utf8')) ?? new Set(['book', 'market']);
  } catch {
    return new Set(['book', 'market']);
  }
}

/** Whether the TEST market maker is running (`local-test-market.mjs status` exits 0 only then). */
function marketRunning() {
  try {
    tool('local-test-market.mjs', 'status');
    return true;
  } catch {
    return false;
  }
}

/** The options the running market maker was started with (its pid record), or null when it is not running. */
function marketArgs() {
  return marketRunning() ? makerRecordArgs() : null;
}

/** One account's own session on Edge, or null when it cannot sign in (an account with an authenticator, a frozen one). */
async function sessionOf(who) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
    signal: AbortSignal.timeout(10_000),
  }).then(json);
  const token = res.body?.result?.data?.accessToken;
  if (!token) return null;
  return (method, route, body) =>
    fetch(`${EDGE}${route}`, {
      method,
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    }).then(json);
}

const rows = (body, ...keys) => {
  if (Array.isArray(body)) return body;
  for (const k of keys) if (Array.isArray(body?.[k])) return body[k];
  return [];
};
const ACTIVE_ALGO = new Set(['active', 'paused']); // svc-trade's AlgoStatus that can still send a slice
const STOPPABLE_GRID = new Set(['initializing', 'running', 'paused_range']); // svc-trade grid-service.ts STOPPABLE

/** Everything one account still has working on the shared books, taken down. Returns what was left, in words. */
async function clearAccountBooks(who) {
  const call = await sessionOf(who);
  if (!call) return [`${who.email}: could not sign in to take its orders down`];
  const left = [];
  const ok = (res) => res.status < 300 || res.status === 404 || res.status === 409;
  // Spot (and whatever else the one cancel-all takes), then each futures order on its own.
  const all = await call('DELETE', '/api/v1/orders');
  if (!ok(all)) left.push(`${who.email}: cancel-all answered ${all.status}`);
  /** A list read, or null after saying it could not be read (so nothing it would have listed is taken for gone). */
  const list = async (route, what, ...keys) => {
    const res = await call('GET', route);
    if (res.status === 200) return rows(res.body, ...keys);
    left.push(`${who.email}: could not list its ${what} (${res.status})`);
    return [];
  };
  for (const o of await list('/api/v1/futures/orders?scope=open&limit=100', 'open futures orders', 'orders', 'items')) {
    const id = o.orderId ?? o.id;
    const res = await call('DELETE', `/api/v1/futures/orders/${encodeURIComponent(id)}`);
    if (!ok(res)) left.push(`${who.email}: futures order ${id} answered ${res.status}`);
  }
  for (const a of await list('/api/v1/algo?limit=500', 'algos', 'rows', 'items')) {
    if (!ACTIVE_ALGO.has(String(a.status ?? a.state ?? '').toLowerCase())) continue;
    const res = await call('POST', `/api/v1/algo/${encodeURIComponent(a.id)}/cancel`);
    if (!ok(res)) left.push(`${who.email}: algo ${a.id} answered ${res.status}`);
  }
  for (const g of await list('/api/v1/bots/grid', 'grid bots', 'bots', 'items')) {
    if (!STOPPABLE_GRID.has(String(g.state ?? g.status ?? ''))) continue;
    const res = await call('POST', `/api/v1/bots/grid/${encodeURIComponent(g.id)}/stop`, { settlement: 'keep' });
    if (!ok(res)) left.push(`${who.email}: grid bot ${g.id} answered ${res.status}`);
  }
  return left;
}

/** The restore's own time, under journey.mjs's 150 s for the worldBetweenFiles fixture, and what taking orders down keeps. */
export const RESTORE_MS = 140_000;
export const BOOK_RESERVE_MS = 20_000;

/**
 * Put back what the journey file `file` declared it changes. `makerArgs` are the options the market maker was running
 * with when that file began (null if it was not running), and `accounts` the TEST accounts it signed up or acted as.
 * Returns what it printed.
 */
async function restoreWorld(file, { makerArgs = null, accounts = [] }) {
  const parts = worldOf(file);
  const said = [];
  if (parts.has('restart')) {
    // A service the file restarted answers again before anything else here signs in (services.mjs). The heal's start
    // gets what the restore's own time (journey.mjs, 150 s) leaves after the maker's wait and the book's.
    const healMs = RESTORE_MS - (parts.has('market') ? MAKER_SETTLE_MS : 0) - BOOK_RESERVE_MS - 2 * STATUS_MS;
    said.push(...(await healStack({ healMs })));
  }
  if (parts.has('book')) {
    const own = makerEmails();
    const cleared = await Promise.all(
      accounts.filter((who) => !own.has(who.email)).map((who) => clearAccountBooks(who).catch((err) => [`${who.email}: ${err.message}`])),
    );
    for (const lines of cleared) said.push(...lines);
  }
  if (parts.has('market')) {
    // Every cycle the next file reads must have started after this point, so it sees the shifts and holds cleared.
    const since = Date.now();
    try {
      tool('local-test-market.mjs', 'unshift');
    } catch (err) {
      said.push(
        `TEST PRICE shifts not cleared: ${String(err.stderr ?? err.message)
          .trim()
          .slice(0, 200)}`,
      );
    }
    // The maker as the file found it: running with the same options, or stopped.
    const now = marketArgs();
    const same = now !== null && makerArgs !== null && JSON.stringify(now) === JSON.stringify(makerArgs);
    if (!same && (now !== null || makerArgs !== null))
      try {
        if (now !== null) tool('local-test-market.mjs', 'stop');
        if (makerArgs !== null) tool('local-test-market.mjs', 'start', ...makerArgs);
      } catch (err) {
        said.push(
          `market maker not put back as it was: ${String(err.stderr ?? err.message)
            .trim()
            .slice(0, 200)}`,
        );
      }
    // The next file starts on a settled book: a whole cycle that began after the `unshift` above (and after any restart)
    // has quoted every market, unshifted and unheld (market.mjs `unsettled`). `unshift` and `start` both return before
    // that. Failures it prevents: J-copy-bots-otc-14 #7 restarted the maker, and J-derivatives-03 #1, next in the shard,
    // found no TEST perpetual quotes (main run 42373885351, #1 to #6 red); and, read from the code, a file after one that
    // moved or held a price could read that book still shifted or held until the maker's next cycle.
    const waiting = marketRunning() ? await makerSettled({ since }) : [];
    if (waiting.length) said.push(`market maker not settled after ${MAKER_SETTLE_MS / 1000}s: ${waiting.join(', ')}`);
  }
  for (const line of said) console.log(`WORLD RESTORE after ${file.split('/').at(-1)}: ${line}`);
  return said;
}

/** Whether the journey file `file` reads the TEST market moving on its own (world-line.mjs `marketLive`); unreadable is still. */
function liveOf(file) {
  try {
    return marketLive(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The TEST market as the journey file `file` needs it: still, unless it has a `// Market: live` line. Returns once the
 * running maker has started a cycle that way (at once when it already runs that way or is not running). Nothing here
 * fails a step: a market not made so is printed with "WORLD RESTORE" and the file runs on it as it is.
 */
function marketFor(file) {
  const mode = liveOf(file) ? 'live' : 'still';
  try {
    tool('local-test-market.mjs', mode);
    return [];
  } catch (err) {
    const line = `TEST market not made ${mode} for ${file.split('/').at(-1)}: ${String(err.stderr || err.message)
      .trim()
      .slice(0, 200)}`;
    console.log(`WORLD RESTORE ${line}`);
    return [line];
  }
}

/** The setting the stack names its TEST venues by (local-test-stack.mjs startTestVenue; local-test-venue.mjs testVenueId). */
export const VENUE_ID_SETTING = 'LOCAL_STACK_TEST_VENUE_ID';
/** The stack's TEST venues (local-test-facts.mjs ports): the one every venue file uses, and J-derivatives-28's second. */
const VENUES = ['test-venue', 'test-venue-b'];
/** What stopping a venue may take: the stack's stop waits 10 s for it before it kills it. Within journey.mjs's 150 s. */
export const VENUE_STOP_MS = 10_000;

/** A venue id no other file has had: `test-venue-sim-` and 8 hex digits (local-test-venue.mjs testVenueId). */
export const freshVenueId = () => `test-venue-sim-${randomBytes(4).toString('hex')}`;

/** Whether something listens on one of the stack's ports: a bare connect, so no file's reach records it (journey-reach.mjs). */
function listening(name) {
  const { hostname, port } = new URL(stackUrl(name));
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    const done = (yes) => {
      socket.destroy();
      resolve(yes);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The stack's own stop of the named services, awaited, so the worker keeps answering Playwright while it runs. */
const stopServices = (names) =>
  new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [path.join(ROOT, 'tooling/scripts/local-test-stack.mjs'), 'stop', ...names],
      { cwd: ROOT, encoding: 'utf8', timeout: VENUE_STOP_MS },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)),
    ),
  );

/**
 * A TEST venue of the file's own. The venue is one process that keeps all its state in memory (its books, every order
 * left resting, its seeded ladders as earlier files took them, its venue-wide TEST switches, marks and caps, its accounts
 * and our builder account on it), so a file that met the venue another file used met that file's leftovers. Failures it
 * prevents: J-cex-spot-02 #7 met the bid J-bank-13 left resting on BTC-USDC (#8546), and J-campaigns-11 #3 met the
 * seeded 59,990 bid J-agents-18 had sold into (#8594 to #8596).
 *
 * So, entering a file: the venue is stopped if it is running, and the file gets a fresh venue id. The file's own first
 * door-on restart of trade then starts a freshly seeded venue under that id (local-test-stack.mjs startTestVenue), and a
 * restart later in the same file keeps it, since a running venue is left as it is. A fresh id, not only a fresh process:
 * what svc-trade and the ledger keep by venue id (its listings, builder-fee versions, the builder-fee receivable) would
 * otherwise carry earlier files' records into this file's venue (J-derivatives-17 #1 compares the venue's own all-time
 * builder-fee total with the ledger's). Returns the id and what could not be done, in words.
 */
export async function ownVenueFor({ up = listening, stop = stopServices, newId = freshVenueId, env = process.env } = {}) {
  const said = [];
  const running = [];
  for (const name of VENUES) if (await up(name)) running.push(name);
  if (running.length)
    try {
      await stop(running);
    } catch (err) {
      said.push(
        `TEST venue not stopped (${running.join(', ')}), so this file meets the last file's venue: ${String(err.stderr || err.message)
          .trim()
          .slice(0, 200)}`,
      );
    }
  const id = newId();
  env[VENUE_ID_SETTING] = id;
  return { id, said };
}

/**
 * Entering journey file `file` in this worker: when the last file this worker ran was another one, put back what that
 * one changed first, then give the new file its own TEST venue and start its record. The same file again (a worker
 * started again after a failed step) changes nothing, and keeps the file's venue id.
 */
export async function enterFile(file) {
  const last = worldState.read();
  if (last.file === file) {
    if (last.venueId) process.env[VENUE_ID_SETTING] = last.venueId;
    return;
  }
  // Before the last file's restore, so the restore's own wait for a settled book (or a maker it starts again) is
  // already still or live as this file needs.
  marketFor(file);
  if (last.file) await restoreWorld(last.file, last);
  const venue = await ownVenueFor();
  for (const line of venue.said) console.log(`WORLD RESTORE before ${file.split('/').at(-1)}: ${line}`);
  worldState.write({ file, makerArgs: worldOf(file).has('market') ? marketArgs() : null, accounts: [], venueId: venue.id });
}
