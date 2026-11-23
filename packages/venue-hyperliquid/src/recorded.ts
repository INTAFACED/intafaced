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
 * Playback (`replayRecording`) answers a request with:
 *   1. the first not-yet-used call with the same path and the same request (key order aside); else
 *   2. the last call with the same path and the same request, again: a read asked twice gets the same answer; else
 *   3. the last call with the same path and the same kind (an `/info` body's `type`, an `/exchange` body's
 *      `action.type`), so a stack whose clock and nonces differ from the recording's still gets the venue's answer
 *      shape; else
 *   4. no answer: the fetch throws, which the adapter reads as the venue being down (a read) or a lost answer (a
 *      submit), never as a refusal or a fill.
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
  return { label: 'TEST', note: typeof raw.note === 'string' ? raw.note : '', calls };
}

function pathOf(url: string): HlRecordedPath {
  const path = new URL(url).pathname;
  if (path !== '/info' && path !== '/exchange') throw new Error(`hl-recorded: the adapter called ${path}, which is not /info or /exchange`);
  return path;
}

/** What kind of call a body is: an `/info` read's `type`, an `/exchange` action's `action.type`. */
export function kindOf(path: HlRecordedPath, request: unknown): string | null {
  if (!isRecord(request)) return null;
  if (path === '/info') return typeof request.type === 'string' ? request.type : null;
  const action = request.action;
  if (!isRecord(action)) return null;
  return typeof action.type === 'string' ? action.type : null;
}

function answer(call: HlRecordedCall): Awaited<ReturnType<FetchLike>> {
  const text = JSON.stringify(call.answer) ?? 'null';
  return { ok: call.status >= 200 && call.status < 300, status: call.status, text: async () => text };
}

/** A fetch that answers from a recording (the rules above) and never reaches a network. */
export function replayRecording(recording: HlRecording): FetchLike {
  if (String(recording.label) !== 'TEST') throw new Error('hl-recorded: a recording must be labelled TEST');
  const calls = recording.calls.map((call) => ({ call, key: `${call.path} ${canonicalJson(call.request)}`, used: false }));
  return async (input, init) => {
    const path = pathOf(input);
    const request: unknown = JSON.parse(init.body);
    const key = `${path} ${canonicalJson(request)}`;
    const fresh = calls.find((c) => !c.used && c.key === key);
    if (fresh) {
      fresh.used = true;
      return answer(fresh.call);
    }
    const again = calls.findLast((c) => c.key === key);
    if (again) return answer(again.call);
    const kind = kindOf(path, request);
    const like = kind === null ? undefined : calls.findLast((c) => c.call.path === path && kindOf(path, c.call.request) === kind);
    if (like) return answer(like.call);
    throw new NotRecordedError(path, request);
  };
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
