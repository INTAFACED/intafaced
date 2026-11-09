import fs from 'node:fs';
import { stackFile } from './stack.mjs';

/**
 * The TEST market maker as the journeys see it: the files it keeps in the stack's state folder, read as data. Journeys
 * reach the maker only through these and `tool('local-test-market.mjs', ...)`; they import none of its code
 * (docs/runbooks/harness-rewrite-plan.md, piece 1).
 *
 * - `pid`: its process record (`start` writes it; only `stop` removes it), with the options it was started with.
 * - `accounts`: its own TEST accounts, the maker and its taker.
 * - `cycle`: its newest whole cycle (local-test-market.mjs `writeCycleRecord`): per market, held, or how many quotes
 *   rest and the TEST price shift they were quoted at.
 */
export const MARKET_FILES = {
  pid: stackFile('run/market.json'),
  accounts: stackFile('market-accounts.json'),
  cycle: stackFile('run/market-cycle.json'),
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** The maker's newest whole cycle, or null when it has written none. */
export const readCycle = () => readJson(MARKET_FILES.cycle);

/** The pid in the maker's process record, or null when it has none. */
export function makerPid() {
  const rec = readJson(MARKET_FILES.pid);
  return Number.isInteger(rec?.pid) ? rec.pid : null;
}

/** The options in the maker's process record, or [] when they can't be read. */
export function makerRecordArgs() {
  const rec = readJson(MARKET_FILES.pid);
  return Array.isArray(rec?.args) ? rec.args.map(String) : [];
}

/** The emails of the maker's own TEST accounts; the maker's loop owns their orders, never a journey. */
export function makerEmails() {
  const accounts = readJson(MARKET_FILES.accounts) ?? {};
  return new Set(
    Object.values(accounts)
      .map((a) => a?.email)
      .filter(Boolean),
  );
}

/**
 * What still keeps the book from being settled, in words; empty when settled. Settled means the running maker
 * (`pid`) has a whole cycle that started at or after `since` (ms), and in it every market rests quotes, none is held,
 * and none is quoted at a TEST price shift. A market that follows another's book has no shift of its own.
 */
export function unsettled(cycle, { since, pid }) {
  if (!cycle || cycle.pid !== pid) return ['no whole cycle of the running maker yet'];
  if (!(cycle.startedAt >= since)) return [`no cycle started since ${new Date(since).toISOString()}`];
  const out = [];
  for (const [symbol, m] of Object.entries(cycle.markets ?? {})) {
    if (m.held) out.push(`${symbol} held`);
    else if (!(m.resting > 0)) out.push(`${symbol} not quoting`);
    else if (m.shiftBps !== null && m.shiftBps !== '0') out.push(`${symbol} still shifted ${m.shiftBps} bps`);
  }
  if (Object.keys(cycle.markets ?? {}).length === 0) out.push('no market in its newest cycle');
  return out;
}

/** How long a wait for the maker gives it: a restart funds it, then one whole cycle. */
export const MAKER_SETTLE_MS = 90_000;

/**
 * Waits until the book is settled since `since` (`unsettled`), or `ms` passes. Returns what was still unsettled then
 * (empty when settled). It never blocks the worker: it polls a file.
 */
export async function makerSettled({ since, ms = MAKER_SETTLE_MS, pause = 500, read = readCycle, pid = makerPid } = {}) {
  const until = Date.now() + ms;
  for (;;) {
    const left = unsettled(read(), { since, pid: pid() });
    if (left.length === 0 || Date.now() >= until) return left;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

/**
 * A `move` percent ("+2%", "-0.30%", "0%") in basis points, or null when it isn't one; the same rule as the maker's
 * own `parseShift` (local-test-market.mjs), which tooling/scripts/local-test-market.test.mjs holds it to.
 */
export function parseShift(text) {
  const m = /^([+-]?)(\d{1,3})(?:\.(\d{1,2}))?%$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const bps = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  const signed = m[1] === '-' ? -bps : bps;
  return signed < -5000n || signed > 10000n ? null : signed;
}

/** Whether the running maker's newest cycle, started at or after `since` (a Date or ms), rests quotes for `symbol` at `bps`. */
export function shiftQuotedIn(cycle, { symbol, bps, since, pid }) {
  // `since` may be a Date or ms.
  const m = cycle?.pid === pid && cycle.startedAt >= Number(since) ? cycle.markets?.[symbol] : null;
  return Boolean(m && !m.held && m.resting > 0 && m.shiftBps === String(BigInt(bps)));
}

/**
 * Returns once the maker rests quotes for `symbol` at `bps` in a cycle started at or after `since` (a Date or ms). Throws
 * after `ms`, saying `what` (the move, as the caller asked for it); a `bps` that is not a shift throws at once.
 */
export async function shiftQuoted(symbol, bps, since, { ms = 120_000, pause = 250, read = readCycle, pid = makerPid, what } = {}) {
  if (typeof bps !== 'bigint') throw new TypeError(`${symbol}: ${what ?? bps} is not a TEST price shift`);
  const until = Date.now() + ms;
  while (!shiftQuotedIn(read(), { symbol, bps, since, pid: pid() })) {
    if (Date.now() > until)
      throw new Error(`the TEST market maker never quoted ${symbol} ${what ?? `${bps} bps`} within ${ms / 1000} s of the move`);
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}
