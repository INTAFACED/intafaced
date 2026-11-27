/**
 * THE BETA'S OUTSIDE LIMITS (#11063): each limit the beta depends on outside this box, with what is left, read live, so
 * that none is found again only by failing. `beta-host.mjs status` prints them and each round writes them into
 * status.json (`limits`), which the walk's record carries with the rest of status.json.
 *
 *   - the wallet provider's signing quota: `unread`. The page signs at the provider directly with the person's own
 *     passkey (apps/customer features/protocol/embedded-wallet provider-client.ts), so no request or refusal passes this
 *     box; the provider checks the stamp before the quota (an unstamped request answers CREDENTIAL_NOT_FOUND, 27 Nov), and
 *     the one stamp the box could make is the owner's API key, which a signature would spend. It never reads `ok`.
 *   - the testnet funder's free TEST USDC and how many testers' grants (beta-testnet.mjs TESTNET_GRANT) it still covers,
 *     read on the testnet's public read door; the funder is the one testnet-funded.json names.
 *   - the venue's request weight in the last full minute against Hyperliquid's 1,200 a minute per IP, from the
 *     `hl.venue_weight_minute` lines the venue adapter writes to the stack's test-venue.log (local-test-venue.mjs); the
 *     warning reads the peak of the last ten minutes, so a burst between rounds still shows.
 *   - the login provider's seats: the Access viewers the front has seen (invited.json, every token ever recorded: a seat
 *     stays taken until the owner removes it), against BETA_ACCESS_SEATS when the owner sets it; without it, `unread`.
 *
 * A limit read as `warn` is one that runs out soon at today's pace; `unread` is a limit this box could not read now,
 * never taken as `ok`.
 */
import fs from 'node:fs';
import { TESTNET_GRANT, units } from './beta-testnet.mjs';

/** The funder warns once it covers fewer testers' grants than this. */
export const FUNDER_WARN_TESTERS = 5;
/** Hyperliquid's request weight a minute for one IP (docs: rate limits), the line's `limit`. */
export const VENUE_WEIGHT_LIMIT = 1200;
/** The venue weight warns at this share of the limit. */
export const VENUE_WARN_SHARE = 0.8;
/** The login seats warn at this share of BETA_ACCESS_SEATS. */
export const SEATS_WARN_SHARE = 0.8;
const MINUTE_MS = 60_000;
/** How far back the venue's warning looks for a peak. */
const VENUE_PEAK_MINUTES = 10;
/** How much of the end of test-venue.log is read: a line a minute, so hours of them. */
const LOG_TAIL_BYTES = 256 * 1024;

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

export function walletProviderLimit() {
  return {
    name: 'wallet-provider',
    state: 'unread',
    line: "wallet provider signing quota: unread: each page signs at the provider directly with the person's own passkey, so no signature or refusal passes this box, and the provider answers its quota only to a stamped request",
  };
}

/** `free` the funder's free TEST USDC (decimal string) or null when unread, with `error` saying why. */
export function funderLimit({ funder, free, error = null }) {
  const name = 'funder';
  if (!funder) return { name, state: 'unread', line: 'testnet funder: unread: the funder is not named in testnet-funded.json yet' };
  if (free == null) return { name, state: 'unread', line: `testnet funder ${funder}: unread: ${error ?? 'its balance could not be read'}` };
  const testers = units(free) / units(TESTNET_GRANT.amount);
  return {
    name,
    state: testers < BigInt(FUNDER_WARN_TESTERS) ? 'warn' : 'ok',
    line: `testnet funder ${funder}: ${free} free TEST USDC, covers ${testers} testers at ${TESTNET_GRANT.amount} each (warns under ${FUNDER_WARN_TESTERS})`,
  };
}

/** The `hl.venue_weight_minute` lines in a log text, oldest first, as { at (ms), weight }. */
export function venueMinutes(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.includes('hl.venue_weight_minute')) continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    const at = Date.parse(row?.minute);
    if (row?.msg !== 'hl.venue_weight_minute' || !Number.isFinite(at) || !Number.isInteger(row.weight)) continue;
    out.push({ at, weight: row.weight });
  }
  return out;
}

/** `minutes` from venueMinutes, or null when the log could not be read. */
export function venueLimit({ minutes, now = Date.now() }) {
  const name = 'venue-weight';
  if (!minutes) return { name, state: 'unread', line: 'venue weight: unread: the stack has no test-venue.log' };
  const warnAt = Math.ceil(VENUE_WEIGHT_LIMIT * VENUE_WARN_SHARE);
  const recent = minutes.filter((m) => m.at >= now - (VENUE_PEAK_MINUTES + 1) * MINUTE_MS);
  // The adapter writes a minute once it has passed, and only a minute with reads: none lately is none spent.
  const last = minutes.at(-1);
  if (!recent.length)
    return {
      name,
      state: 'ok',
      line: `venue weight: 0 of ${VENUE_WEIGHT_LIMIT} a minute (no reads since ${last ? `${hhmm(last.at)} UTC` : 'the stack started'})`,
    };
  const peak = Math.max(...recent.map((m) => m.weight));
  const latest = recent.at(-1);
  return {
    name,
    state: peak >= warnAt ? 'warn' : 'ok',
    line: `venue weight: ${latest.weight} of ${VENUE_WEIGHT_LIMIT} in the minute from ${hhmm(latest.at)} UTC, ${VENUE_WEIGHT_LIMIT - latest.weight} left; peak ${peak} in the last ${VENUE_PEAK_MINUTES} minutes (warns at ${warnAt})`,
  };
}

/** `seen` the Access viewers recorded, `limit` the owner's seat count (BETA_ACCESS_SEATS) or null when unset. */
export function seatsLimit({ seen, limit }) {
  const name = 'login-seats';
  if (!limit)
    return {
      name,
      state: 'unread',
      line: `login seats: ${seen} viewers seen through Access; the seat limit is unset (BETA_ACCESS_SEATS), so nothing to warn against`,
    };
  return {
    name,
    state: seen >= Math.ceil(limit * SEATS_WARN_SHARE) ? 'warn' : 'ok',
    line: `login seats: ${seen} of ${limit} seats taken by viewers seen through Access, ${Math.max(limit - seen, 0)} left (warns at ${Math.ceil(limit * SEATS_WARN_SHARE)})`,
  };
}

const ORDER = ['warn', 'unread', 'ok'];
/** One line for status and the walk's record: each state with the limits in it, worst first. */
export function limitsLine(limits) {
  const parts = ORDER.map((s) => [s, limits.filter((l) => l.state === s).map((l) => l.name)])
    .filter(([, names]) => names.length)
    .map(([s, names]) => `${s} (${names.join(', ')})`);
  return `limits: ${parts.join('; ')}`;
}

/** One line a limit, its state first, for `beta-host.mjs status`. */
export const limitsReport = (limits) => limits.map((l) => `  ${l.state.padEnd(6)} ${l.line}`).join('\n');

function tail(file, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * All four, read now. `paths`: testnet (testnet-funded.json), invited (invited.json), venueLog (the stack's
 * test-venue.log). `deps.spotFree(address)` the funder's free TEST USDC (beta-testnet.mjs liveDeps), `deps.seatLimit`
 * BETA_ACCESS_SEATS as set.
 */
export async function readLimits(paths, { spotFree, seatLimit = process.env.BETA_ACCESS_SEATS, now = Date.now() } = {}) {
  const funder = readJson(paths.testnet)?.funder ?? null;
  let free = null;
  let error = null;
  if (funder) {
    try {
      free = await spotFree(funder);
    } catch (e) {
      error = String(e?.message ?? e).split('\n')[0];
    }
  }
  const log = tail(paths.venueLog);
  const seats = /^\d+$/.test(String(seatLimit ?? '').trim()) ? Number(seatLimit) : null;
  return [
    walletProviderLimit(),
    funderLimit({ funder, free, error }),
    venueLimit({ minutes: log == null ? null : venueMinutes(log), now }),
    seatsLimit({ seen: Object.keys(readJson(paths.invited)?.tokens ?? {}).length, limit: seats || null }),
  ];
}
