import { isRecord } from '@intafaced/contracts/guards';
import type { FetchLike } from './core.js';

/**
 * RECORDED ANSWERS (`hl-recorded`): the Hyperliquid test network's answers kept in a file and played back, so the venue
 * runs with no network at all (CI, a stack with no outside access). Every figure in a recording is TEST.
 *
 * A recording is the list of calls the adapter made: the path (`/info` or `/exchange`), the exact request body, and the
 * HTTP status and body the venue answered. `source` says where each answer came from: `testnet` (captured from the
 * live test network by `recordingFetch`) or `documented-shape` (written by hand to the venue's documented answer, for a
 * call that needs a funded test account to capture). Nothing in a recording is ever read as a real figure.
 *
 * Playback (`replayRecording`) matches a request by its key: its path and its body, with what changes between two runs
 * of the same steps normalised out:
 *   · the trader the recording names (`trader`) is `<trader>`, and the current run's trader is written back into every
 *     answer, so a run signing with another wallet replays the same steps;
 *   · the signature is dropped; nonces, action times and read windows (`nonce`, `time`, `startTime`, `endTime`,
 *     `expiresAfter`) are `<volatile>`;
 *   · a client order id (16 bytes of hex) is the recorded one it was paired with at an earlier write, else `<cloid>`; a
 *     replayed write pairs the recorded ids with the current ones, and every later answer carries the current ids;
 *   · a trading session's key (an `approveAgent`'s `agentAddress`, new each run) is paired the same way, else `<agent>`,
 *     and its expiry (the `valid_until <ms>` the venue takes in `agentName`) is `<volatile>`: a replayed approval pairs
 *     both, and every later answer carries the current key and, in each `validUntil`, the current expiry.
 * Writes order time: each read belongs to its epoch, the number of writes recorded before it. A read answers the last
 * recorded answer to its key at the latest epoch not after the current one, so reads may come in any order and number
 * (the service's and a journey's own), and a poll sees the state its epoch settled on. Writes answer in recorded order.
 * A request with no answer is never sent on and never given another request's answer: the fetch throws
 * `NotRecordedError` (the adapter reads it as the venue down, or a submit's answer lost) and the request is kept in the
 * replay's `misses`, so a run can fail on it by name.
 */

export type HlRecordedPath = '/info' | '/exchange';

export interface HlRecordedCall {
  readonly path: HlRecordedPath;
  readonly request: unknown;
  readonly status: number;
  readonly answer: unknown;
  readonly source: 'testnet' | 'documented-shape';
}

export interface HlRecording {
  readonly label: 'TEST';
  readonly note: string;
  /**
   * The trader the recording was made for, when its requests and answers name it as `<trader>` (a live run records it so:
   * the address only, never a key). Absent, the recording names its addresses as they were.
   */
  readonly trader?: '<trader>';
  readonly calls: readonly HlRecordedCall[];
}

/** Thrown by a replaying fetch for a request the recording has no answer for. */
export class NotRecordedError extends Error {
  constructor(path: string, request: unknown) {
    super(`hl-recorded: no recorded answer for ${path} ${JSON.stringify(request).slice(0, 200)}`);
    this.name = 'NotRecordedError';
  }
}

/** The same JSON with every object's keys in order, so two bodies that differ only in key order compare equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** A recording read from its file, checked: labelled TEST, and every call a path, a request, a status and an answer. */
export function parseRecording(raw: unknown): HlRecording {
  if (!isRecord(raw) || raw.label !== 'TEST') throw new Error('hl-recorded: a recording must be labelled TEST');
  if (!Array.isArray(raw.calls)) throw new Error('hl-recorded: a recording lists its calls');
  const calls = raw.calls.map((c: unknown, i): HlRecordedCall => {
    if (!isRecord(c)) throw new Error(`hl-recorded: call ${i} is not an object`);
    const { path, request, status, answer, source } = c;
    if (path !== '/info' && path !== '/exchange') throw new Error(`hl-recorded: call ${i} names no venue path`);
    if (typeof status !== 'number' || !Number.isInteger(status)) throw new Error(`hl-recorded: call ${i} has no HTTP status`);
    if (source !== 'testnet' && source !== 'documented-shape') throw new Error(`hl-recorded: call ${i} names no source`);
    return { path, request, status, answer, source };
  });
  const note = typeof raw.note === 'string' ? raw.note : '';
  return raw.trader === TRADER ? { label: 'TEST', note, trader: TRADER, calls } : { label: 'TEST', note, calls };
}

function pathOf(url: string): HlRecordedPath {
  const path = new URL(url).pathname;
  if (path !== '/info' && path !== '/exchange') throw new Error(`hl-recorded: the adapter called ${path}, which is not /info or /exchange`);
  return path;
}

function answer(call: HlRecordedCall): Awaited<ReturnType<FetchLike>> {
  const text = JSON.stringify(call.answer) ?? 'null';
  return { ok: call.status >= 200 && call.status < 300, status: call.status, text: async () => text };
}

export const TRADER = '<trader>';
const VOLATILE = '<volatile>';
const UNPAIRED_CLOID = '<cloid>';
const UNPAIRED_AGENT = '<agent>';
/** The expiry Hyperliquid takes only in an agent's name (venue.ts EXPIRY_IN_NAME). */
const AGENT_EXPIRY_RE = / valid_until (\d+)$/;
const VOLATILE_KEYS = new Set(['nonce', 'time', 'startTime', 'endTime', 'expiresAfter']);
const CLOID_RE = /^0x[0-9a-f]{32}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

/**
 * One request a replay had no answer for: its path, the epoch it came in and its key. `otherAccount` is true only when
 * the request is about an account (`user`) that is neither the run's trader nor any address the recording names, and
 * that the replay was already asked about before the run's trader or any write came in: an account the stack held
 * before this run did anything, so none of its steps can have made it. It is refused like any miss. An address first
 * asked about once the run has started is never another account's, whatever it is.
 */
export interface ReplayMiss {
  readonly path: HlRecordedPath;
  readonly epoch: number;
  readonly key: string;
  readonly otherAccount: boolean;
}

/** A replaying fetch, with every request it had no answer for. */
export type ReplayFetch = FetchLike & { readonly misses: readonly ReplayMiss[] };

/** Every string in `value` through `swap`. */
function swapStrings(value: unknown, swap: (s: string) => string): unknown {
  if (typeof value === 'string') return swap(value);
  if (Array.isArray(value)) return value.map((v) => swapStrings(v, swap));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swapStrings(v, swap)]));
  return value;
}

/** `trader` written as `<trader>`, as a recording keeps it. */
export function hideTrader(value: unknown, trader: string): unknown {
  const t = trader.toLowerCase();
  return swapStrings(value, (s) => (s.toLowerCase() === t ? TRADER : s));
}

/** `<trader>` written back as `trader`. */
function showTrader(value: unknown, trader: string): unknown {
  return swapStrings(value, (s) => (s === TRADER ? trader : s));
}

/** The key a request is matched by (the module comment): `pairedAs` names a client order id already paired. */
export function requestKey(path: HlRecordedPath, request: unknown, pairedAs: (cloid: string) => string | undefined): string {
  const walk = (value: unknown, key: string | null, top: boolean): unknown => {
    if (key !== null && VOLATILE_KEYS.has(key)) return VOLATILE;
    if (key === 'agentAddress' && typeof value === 'string' && ADDRESS_RE.test(value))
      return pairedAs(value.toLowerCase()) ?? UNPAIRED_AGENT;
    if (key === 'agentName' && typeof value === 'string') return value.replace(AGENT_EXPIRY_RE, ` valid_until ${VOLATILE}`);
    if (typeof value === 'string') return CLOID_RE.test(value) ? (pairedAs(value.toLowerCase()) ?? UNPAIRED_CLOID) : value;
    if (Array.isArray(value)) return value.map((v) => walk(v, null, false));
    if (isRecord(value))
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !(top && k === 'signature'))
          .map(([k, v]) => [k, walk(v, k, false)]),
      );
    return value;
  };
  return `${path} ${canonicalJson(walk(request, null, true))}`;
}

/** The ids and session expiries a replay has paired, recorded to current. */
interface Paired {
  readonly ids: Map<string, string>;
  readonly expiries: Map<number, number>;
}

/**
 * Each client order id and session key in `recorded` paired with the one at the same place in `current` (into `ids`),
 * and each session expiry in an `agentName` with the current one (into `expiries`); `key` is the field both sit under.
 */
function pairCloids(recorded: unknown, current: unknown, at: Paired & { readonly key?: string }): void {
  const key = at.key ?? null;
  if (typeof recorded === 'string' && typeof current === 'string') {
    if (CLOID_RE.test(recorded) && CLOID_RE.test(current)) at.ids.set(recorded.toLowerCase(), current.toLowerCase());
    if (key === 'agentAddress' && ADDRESS_RE.test(recorded) && ADDRESS_RE.test(current))
      at.ids.set(recorded.toLowerCase(), current.toLowerCase());
    const was = key === 'agentName' ? AGENT_EXPIRY_RE.exec(recorded) : null;
    const now = key === 'agentName' ? AGENT_EXPIRY_RE.exec(current) : null;
    if (was && now) at.expiries.set(Number(was[1]), Number(now[1]));
  } else if (Array.isArray(recorded) && Array.isArray(current)) {
    recorded.forEach((r, i) => pairCloids(r, current[i], { ids: at.ids, expiries: at.expiries }));
  } else if (isRecord(recorded) && isRecord(current)) {
    for (const [k, r] of Object.entries(recorded)) pairCloids(r, current[k], { ids: at.ids, expiries: at.expiries, key: k });
  }
}

function addressesIn(value: unknown, into: Set<string>): void {
  if (typeof value === 'string' && ADDRESS_RE.test(value)) into.add(value.toLowerCase());
  else if (Array.isArray(value)) value.forEach((v) => addressesIn(v, into));
  else if (isRecord(value)) Object.values(value).forEach((v) => addressesIn(v, into));
}

/** Each client order id and session key (`agentAddress`) a write names: the ids a later request keeps as recorded. */
function cloidsIn(value: unknown, into: Set<string>, key: string | null = null): void {
  if (typeof value === 'string' && (CLOID_RE.test(value) || (key === 'agentAddress' && ADDRESS_RE.test(value))))
    into.add(value.toLowerCase());
  else if (Array.isArray(value)) value.forEach((v) => cloidsIn(v, into));
  else if (isRecord(value)) Object.entries(value).forEach(([k, v]) => cloidsIn(v, into, k));
}

/** An answer with each paired id written as the current one, and each paired session expiry in `validUntil` likewise. */
function currentIds(value: unknown, paired: Paired, key: string | null = null): unknown {
  if (typeof value === 'string')
    return CLOID_RE.test(value) || ADDRESS_RE.test(value) ? (paired.ids.get(value.toLowerCase()) ?? value) : value;
  if (typeof value === 'number') return key === 'validUntil' ? (paired.expiries.get(value) ?? value) : value;
  if (Array.isArray(value)) return value.map((v) => currentIds(v, paired));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, currentIds(v, paired, k)]));
  return value;
}

/**
 * A fetch that answers from a recording (the rules above) and never reaches a network. `trader` is the address the run
 * signs as; it must be given for a recording made for `<trader>`.
 */
export function replayRecording(recording: HlRecording, opts: { trader?: string } = {}): ReplayFetch {
  if (String(recording.label) !== 'TEST') throw new Error('hl-recorded: a recording must be labelled TEST');
  const trader = opts.trader?.toLowerCase() ?? null;
  if (recording.trader === TRADER && (trader === null || !ADDRESS_RE.test(trader)))
    throw new Error('hl-recorded: this recording is made for <trader>; replaying it needs the trader address the run signs as');
  const hide = (v: unknown) => (recording.trader === TRADER && trader ? hideTrader(v, trader) : v);
  const show = (v: unknown) => (recording.trader === TRADER && trader ? showTrader(v, trader) : v);
  const reads = new Map<string, { epoch: number; call: HlRecordedCall }[]>();
  const writes: { key: string; call: HlRecordedCall }[] = [];
  const seen = new Set<string>();
  const named = new Set<string>();
  for (const call of recording.calls) {
    addressesIn(call.request, named);
    const key = requestKey(call.path, call.request, (c) => (seen.has(c) ? c : undefined));
    if (call.path === '/exchange') {
      writes.push({ key, call });
      cloidsIn(call.request, seen);
    } else {
      const list = reads.get(key) ?? [];
      list.push({ epoch: writes.length, call });
      reads.set(key, list);
    }
  }
  const toCurrent = new Map<string, string>();
  const toRecorded = new Map<string, string>();
  const expiries = new Map<number, number>();
  const misses: ReplayMiss[] = [];
  /** Addresses asked about before the run's trader or any write came in: the stack's, not this run's. */
  const earlier = new Set<string>();
  let started = false;
  let epoch = 0;
  const replay = async (input: string, init: { body: string }) => {
    const path = pathOf(input);
    const parsed: unknown = JSON.parse(init.body);
    const request = hide(parsed);
    const key = requestKey(path, request, (c) => toRecorded.get(c));
    const user = isRecord(request) && typeof request.user === 'string' ? request.user.toLowerCase() : null;
    if (path === '/exchange' || user === TRADER) started = true;
    if (!started && user !== null && ADDRESS_RE.test(user)) earlier.add(user);
    let found: HlRecordedCall | null = null;
    if (path === '/exchange') {
      const next = writes[epoch];
      if (next && next.key === key) {
        const pairs = new Map<string, string>();
        pairCloids(next.call.request, request, { ids: pairs, expiries });
        for (const [recorded, current] of pairs) {
          toCurrent.set(recorded, current);
          toRecorded.set(current, recorded);
        }
        epoch += 1;
        found = next.call;
      }
    } else {
      for (const entry of reads.get(key) ?? []) if (entry.epoch <= epoch) found = entry.call;
    }
    if (!found) {
      const otherAccount = user !== null && earlier.has(user) && !named.has(user);
      misses.push({ path, epoch, key, otherAccount });
      throw new NotRecordedError(path, request);
    }
    const swapped = currentIds(found.answer, { ids: toCurrent, expiries });
    return answer({ ...found, answer: show(swapped) });
  };
  const replaying: ReplayFetch = Object.assign(replay, { misses });
  return replaying;
}

/** A fetch that passes each call to `inner` (the live test network) and appends what it answered to `into`. */
export function recordingFetch(inner: FetchLike, into: HlRecordedCall[]): FetchLike {
  return async (input, init) => {
    const res = await inner(input, init);
    const text = await res.text();
    into.push({
      path: pathOf(input),
      request: JSON.parse(init.body),
      status: res.status,
      answer: JSON.parse(text),
      source: 'testnet',
    });
    return { ok: res.ok, status: res.status, text: async () => text };
  };
}

/**
 * What a live run's calls are kept as (`hl-testnet` with a recording named): each request without its signature, and the
 * trader as `<trader>` everywhere, so a run signing with another wallet replays it. The address only: never a key.
 */
export function traderRecording(calls: readonly HlRecordedCall[], trader: string, note: string): HlRecording {
  if (!ADDRESS_RE.test(trader)) throw new Error(`hl-recorded: the trader must be an address, got ${JSON.stringify(trader)}`);
  const unsigned = (request: unknown) =>
    isRecord(request) ? Object.fromEntries(Object.entries(request).filter(([k]) => k !== 'signature')) : request;
  return {
    label: 'TEST',
    note,
    trader: TRADER,
    calls: calls.map((c) => ({
      ...c,
      request: hideTrader(unsigned(c.request), trader),
      answer: hideTrader(withoutTokenIds(c.request, c.answer), trader),
    })),
  };
}

/**
 * A spot listing's answer without each token's `tokenId`, as scripts/record-order.ts keeps it: the adapter never reads it,
 * and a 32-hex id reads to a secret scanner as a key (Gitleaks finds one per token). `spotMeta` answers
 * `{ tokens }`, `spotMetaAndAssetCtxs` answers `[{ tokens }, ctxs]`; every other answer is kept as it is.
 */
function withoutTokenIds(request: unknown, answer: unknown): unknown {
  const type = isRecord(request) ? request.type : undefined;
  const strip = (meta: unknown) =>
    isRecord(meta) && Array.isArray(meta.tokens)
      ? {
          ...meta,
          tokens: meta.tokens.map((t) => (isRecord(t) ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'tokenId')) : t)),
        }
      : meta;
  if (type === 'spotMeta') return strip(answer);
  if (type === 'spotMetaAndAssetCtxs' && Array.isArray(answer)) return [strip(answer[0]), ...answer.slice(1)];
  return answer;
}
