/**
 * THE DEMO WORLD: the Customer app as the hosted beta runs it, with the venue on (Hyperliquid's test network, every
 * figure TEST), for dev pictures and `pnpm shots`. Two layers:
 *   1. tooling/shots/recording/: every market read the beta's rooms made, signed out and signed in, recorded from the beta by
 *      tooling/shots/record-demo.mjs (TEST figures from the test network; nothing about the recording's tester kept);
 *   2. the seeded trader (seed.mjs): their venue balances, positions, orders and fills, priced from the recording;
 *   3. the look gate's TEST account (tooling/ci/look-gate's fixture answers): the signed-in person, their balances, bank, identity and
 *      notices, and their venue wallet;
 *   4. last, a module's own read the recording's tester made (verification levels, deposit assets, notices) where the
 *      TEST account has no fixture; never a sign-in, session or key call.
 * A read the recording has under the same path with another query (a desk polled at another depth) answers from it, so
 * a room asking a little differently still gets the venue's figures. A call neither layer answers is refused, so a room
 * with no data says so honestly.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fixtureAnswer } from '../../../../tooling/ci/look-gate/fixture-answer.mjs';
import { seededAccount } from './seed.mjs';

/**
 * The recording (tooling/shots/recording/, written by record-demo.mjs): the beta's own reads (beta.json), and each market's venue feed
 * (feed-<symbol>.json), which answers signed in or out alike and wins over a read the beta refused.
 */
function load() {
  const dir = new URL('../../../../tooling/shots/recording/', import.meta.url);
  const beta = JSON.parse(readFileSync(new URL('beta.json', dir), 'utf8'));
  const calls = { signedOut: { ...beta.calls.signedOut }, signedIn: { ...beta.calls.signedIn } };
  for (const name of readdirSync(dir)
    .filter((f) => f.startsWith('feed-') && f.endsWith('.json'))
    .sort()) {
    const feed = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    if (feed.label !== 'TEST') throw new Error(`demo world: ${name} is not labelled TEST`);
    Object.assign(calls.signedOut, feed.calls);
    Object.assign(calls.signedIn, feed.calls);
  }
  return { label: beta.label, at: beta.at, source: beta.source, calls, trpc: beta.calls.trpc ?? {} };
}

export const RECORDING = load();

/** The time every demo picture is drawn at: when the recording was made, so its "as of" lines read as fresh. */
export const DEMO_NOW = Date.parse(RECORDING.at);

/** A call's key, as record-demo.mjs writes it: the method, the path, and its query in name order. */
export function callKey(method, href) {
  const u = new URL(href, 'http://x');
  const q = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${method} ${u.pathname}${q.length ? `?${new URLSearchParams(q)}` : ''}`;
}

/** The recorded answer for one read, signed in or out: exact, else the same read at another depth or length. */
export function recordedAnswer(href, method, { signedIn }) {
  if (method !== 'GET') return null;
  // Signed in, a public read the recording made only signed out (the fee page) answers too.
  const calls = signedIn ? { ...RECORDING.calls.signedOut, ...RECORDING.calls.signedIn } : RECORDING.calls.signedOut;
  const key = callKey(method, href);
  if (Object.hasOwn(calls, key)) return calls[key];
  const u = new URL(href, 'http://x');
  // The same read asked at another depth or length, or naming the recorded venue: every other part of the query (the
  // market, the interval) must agree.
  const rest = (x) =>
    [...x.searchParams.entries()]
      .filter(([k, v]) => k !== 'depth' && k !== 'limit' && !(k === 'venueId' && v === VENUE_ID))
      .sort(([a], [b]) => a.localeCompare(b))
      .join('&');
  const near = Object.keys(calls).find((k) => {
    const r = new URL(k.slice(k.indexOf(' ') + 1), 'http://x');
    return r.pathname === u.pathname && rest(r) === rest(u);
  });
  return near ? calls[near] : null;
}

const VENUE_ID = RECORDING.calls.signedIn['GET /api/v1/venue/status']?.json?.venue?.id ?? 'test-venue';
const SEEDED = seededAccount(RECORDING.calls.signedIn, { now: DEMO_NOW, venueId: VENUE_ID });

/** What the demo world answers for one service call: `{ status, json }`, or null (the caller refuses it). */
export function demoAnswer(href, method, body, { signedIn, now = DEMO_NOW }) {
  const url = new URL(href, 'http://x');
  if (signedIn && method === 'GET' && Object.hasOwn(SEEDED, url.pathname)) {
    const seeded = SEEDED[url.pathname];
    return typeof seeded === 'function' ? seeded(url) : seeded;
  }
  // The person's verification is one story, told whole by one layer: the recording holds every `kyc.*` read its
  // tester made (level, ladder, cases, capabilities, proof of address), so the TEST account's lone `kyc.status` never
  // mixes a second person's level into it.
  if (signedIn && url.pathname.startsWith('/api/identity/trpc/kyc.')) {
    const told = recordedTrpc(href, method);
    if (told) return told;
  }
  return (
    recordedAnswer(href, method, { signedIn }) ??
    fixtureAnswer(href, method, body, { signedIn, now }) ??
    (signedIn ? recordedTrpc(href, method) : null)
  );
}

/** The last layer: a tRPC read the recording's tester made, exact or the same procedure with other input. */
function recordedTrpc(href, method) {
  if (method !== 'GET') return null;
  const key = callKey(method, href);
  if (Object.hasOwn(RECORDING.trpc, key)) return RECORDING.trpc[key];
  const path = new URL(href, 'http://x').pathname;
  const near = Object.keys(RECORDING.trpc).find((k) => new URL(k.slice(k.indexOf(' ') + 1), 'http://x').pathname === path);
  return near ? RECORDING.trpc[near] : null;
}
