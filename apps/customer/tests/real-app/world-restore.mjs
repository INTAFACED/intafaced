import fs from 'node:fs';
import { EDGE, ORIGIN, DEVICE_KEY, json, tool, worldState } from './stack.mjs';
import { declaredWorld } from '../../../../tooling/scripts/journey-world.mjs';

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
 * tools are declared and kept apart by the planner, but not yet put back here.
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

/** Everything one account still has working on the shared books, taken down. Returns what was left, in words. */
export async function clearAccountBooks(who) {
  const call = await sessionOf(who);
  if (!call) return [`${who.email}: could not sign in to take its orders down`];
  const left = [];
  const ok = (res) => res.status < 300 || res.status === 404 || res.status === 409;
  // Spot (and whatever else the one cancel-all takes), then each futures order on its own.
  const all = await call('DELETE', '/api/v1/orders');
  if (!ok(all) && all.status !== 400) left.push(`${who.email}: cancel-all answered ${all.status}`);
  const futures = await call('GET', '/api/v1/futures/orders?scope=open&limit=100');
  for (const o of futures.status === 200 ? rows(futures.body, 'orders', 'items') : []) {
    const id = o.orderId ?? o.id;
    const res = await call('DELETE', `/api/v1/futures/orders/${encodeURIComponent(id)}`);
    if (!ok(res)) left.push(`${who.email}: futures order ${id} answered ${res.status}`);
  }
  const algos = await call('GET', '/api/v1/algo?limit=500');
  for (const a of algos.status === 200 ? rows(algos.body, 'rows', 'items') : []) {
    if (!ACTIVE_ALGO.has(String(a.status ?? a.state ?? '').toLowerCase())) continue;
    const res = await call('POST', `/api/v1/algo/${encodeURIComponent(a.id)}/cancel`);
    if (!ok(res)) left.push(`${who.email}: algo ${a.id} answered ${res.status}`);
  }
  const grids = await call('GET', '/api/v1/bots/grid');
  for (const g of grids.status === 200 ? rows(grids.body, 'bots', 'items') : []) {
    if (g.state !== 'running' && g.state !== 'starting') continue;
    const res = await call('POST', `/api/v1/bots/grid/${encodeURIComponent(g.id)}/stop`, { settlement: 'keep' });
    if (!ok(res)) left.push(`${who.email}: grid bot ${g.id} answered ${res.status}`);
  }
  return left;
}

/**
 * Put back what the journey file `file` declared it changes. `marketWasRunning` is whether the market maker was
 * running when that file began, and `accounts` the TEST accounts it signed up or acted as. Returns what it printed.
 */
export async function restoreWorld(file, { marketWasRunning, accounts }) {
  const parts = worldOf(file);
  const said = [];
  if (parts.has('book'))
    for (const who of accounts)
      for (const line of await clearAccountBooks(who).catch((err) => [`${who.email}: ${err.message}`])) said.push(line);
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
    if (marketWasRunning && !marketRunning())
      try {
        tool('local-test-market.mjs', 'start');
      } catch (err) {
        said.push(
          `market maker not started again: ${String(err.stderr ?? err.message)
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
  const last = worldState.read();
  if (last.file === file) return;
  if (last.file) await restoreWorld(last.file, last);
  worldState.write({ file, marketWasRunning: worldOf(file).has('market') ? marketRunning() : false, accounts: [] });
}
