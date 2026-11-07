import fs from 'node:fs';
import { EDGE, ORIGIN, DEVICE_KEY, assertStackUp, json, tool, worldState } from './stack.mjs';
import { declaredWorld } from '../../../../tooling/scripts/journey-world.mjs';
import { stackPaths } from '../../../../tooling/scripts/local-test-market.mjs';

/**
 * Putting the shared world back between journey files (tooling/scripts/journey-world.mjs). Each file declares, in its
 * `// World:` line, what it changes; before the next file's first step this takes down what the last file left:
 *
 * - book: every open order, running algo and running grid bot of the TEST accounts the file signed up or acted as;
 * - market: every TEST price `move`, and the market maker started again if it was running when the file began.
 *
 * Failure it prevents: J-copy-bots-otc-30 #1 left a TEST bid resting on BTC/USDT, J-ops-console-08 #7 restarted the
 * market maker over it, and J-portfolio-04 #1 timed out on main (run 1247), though its code passed alone (run 1262).
 * The posting freeze already has its own guard (journey-freeze-guard.mjs). Gates, restarts and the stack's global
 * tools are declared and scanned (journey-world.mjs) but not put back here: part B runs those files alone.
 *
 * Nothing here fails a step: what could not be put back is printed with "WORLD RESTORE", naming the file that left it.
 */

/** The parts a journey file declares, or every part when the line cannot be read (restore more, never less). */
export function worldOf(file) {
  try {
    return declaredWorld(fs.readFileSync(file, 'utf8')) ?? new Set(['book', 'market']);
  } catch {
    return new Set(['book', 'market']);
  }
}

/** Whether the TEST market maker is running (`local-test-market.mjs status` exits 0 only then). */
export function marketRunning() {
  try {
    tool('local-test-market.mjs', 'status');
    return true;
  } catch {
    return false;
  }
}

/** The options the running market maker was started with (its pid record), or null when it is not running. */
export function marketArgs() {
  if (!marketRunning()) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(stackPaths().pidFile, 'utf8'));
    return Array.isArray(rec?.args) ? rec.args.map(String) : [];
  } catch {
    return [];
  }
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

/** The stack's own TEST accounts (the market maker and its taker): the maker loop owns their orders, never a journey. */
function stackAccounts() {
  try {
    const accounts = JSON.parse(fs.readFileSync(stackPaths().accounts, 'utf8'));
    return new Set(
      Object.values(accounts)
        .map((a) => a?.email)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

const rows = (body, ...keys) => {
  if (Array.isArray(body)) return body;
  for (const k of keys) if (Array.isArray(body?.[k])) return body[k];
  return [];
};
const ACTIVE_ALGO = new Set(['active', 'paused']); // svc-trade's AlgoStatus that can still send a slice
const STOPPABLE_GRID = new Set(['initializing', 'running', 'paused_range']); // svc-trade grid-service.ts STOPPABLE

/** Everything one account still has working on the shared books, taken down. Returns what was left, in words. */
export async function clearAccountBooks(who) {
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

/**
 * Put back what the journey file `file` declared it changes. `makerArgs` are the options the market maker was running
 * with when that file began (null if it was not running), and `accounts` the TEST accounts it signed up or acted as.
 * Returns what it printed.
 */
export async function restoreWorld(file, { makerArgs = null, accounts = [] }) {
  const parts = worldOf(file);
  const said = [];
  if (parts.has('book')) {
    const own = stackAccounts();
    const cleared = await Promise.all(
      accounts.filter((who) => !own.has(who.email)).map((who) => clearAccountBooks(who).catch((err) => [`${who.email}: ${err.message}`])),
    );
    for (const lines of cleared) said.push(...lines);
  }
  if (parts.has('market')) {
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
  }
  for (const line of said) console.log(`WORLD RESTORE after ${file.split('/').at(-1)}: ${line}`);
  return said;
}

/**
 * Entering journey file `file` in this worker: when the last file this worker ran was another one, put back what that
 * one changed first, then start the new file's record. The same file again (a worker started again after a failed
 * step) changes nothing.
 */
export async function enterFile(file) {
  // A restart that left the stack down fails every later file here, by name (stack.mjs tool, #7463).
  assertStackUp();
  const last = worldState.read();
  if (last.file === file) return;
  if (last.file) await restoreWorld(last.file, last);
  worldState.write({ file, makerArgs: worldOf(file).has('market') ? marketArgs() : null, accounts: [] });
}
