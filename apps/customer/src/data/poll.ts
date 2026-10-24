/**
 * The one polling scheduler (UI-SPEC §4.2).
 *
 * - Dedupes: components asking for the same key share one request, one timer
 *   and one cached answer; the fastest interval among them wins.
 * - Pauses while the tab is hidden and catches up when it is shown again.
 * - Holds a budget of requests per minute for the whole tab (default 120; the
 *   edge allows 300) and exposes a counter so tests, and the E2E run, can assert it.
 * - Backs off after failures (2x, 4x, 8x the interval) and keeps showing the last
 *   good answer for a while rather than flashing an error on one dropped request.
 * - With no answer yet, an error is retried soon (2 s, 4 s, 8 s ... never later than the
 *   backed-off interval), so one dropped first read of a slow source (the desk's market
 *   list polls every 5 minutes) does not leave its screen on "Couldn't load" for 10.
 *
 * Framework-free: React only meets it through `Source` in `hooks.ts`.
 */
import type { Loadable } from './types';
import type { Source } from './source';

/** What a fetcher returns. The customer `ApiResult<T>` already fits. */
export type Outcome<T> = { ok: true; data: T } | { ok: false; reason: string; code?: string; status?: number };
export type Fetcher<T> = (signal: AbortSignal) => Promise<Outcome<T>>;

export interface VisibilitySource {
  isVisible(): boolean;
  /** Calls back when visibility flips; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface PollStats {
  /** Requests started in the last 60 s (what the budget counts). */
  requestsLastMinute: number;
  /** The largest 60 s count ever reached. Never exceeds `limit` for scheduled polls. */
  peakPerMinute: number;
  totalRequests: number;
  /** Times a request had to wait for budget. */
  deferred: number;
  limit: number;
  activeKeys: number;
}

export interface PollerOptions {
  /** Requests per rolling minute for this tab. Default 120. */
  budgetPerMinute?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  visibility?: VisibilitySource;
  /** How long the last good answer may stay on screen after failures, in intervals. Default 3. */
  staleIntervals?: number;
  /** ...but never less than this many ms. Default 30 000. */
  minStaleMs?: number;
}

export interface SourceOptions {
  intervalMs: number;
}

export interface Poller {
  /** Same key + interval returns the same object, so it is safe in `useMemo`. */
  source<T>(key: string, fetcher: Fetcher<T>, options: SourceOptions): Source<T>;
  /**
   * Fetch now (budget permitting) for a key that has subscribers. A read already in flight started before whatever asked for
   * the refresh (a save), so it may answer with the old state: it is dropped and a new read starts.
   */
  refresh(key: string): void;
  /** Count a request made outside the scheduler (orders, one-off reads). */
  recordExternalRequest(count?: number): void;
  stats(): PollStats;
  dispose(): void;
}

const WINDOW_MS = 60_000;
const IDLE_EVICT_MS = 5 * 60_000;
const MAX_BACKOFF = 8;
/** First retry of an error before any good answer; doubles per failure. */
const FIRST_READ_RETRY_MS = 2_000;

/** Rolling-window request counter. */
export class RequestBudget {
  private stamps: number[] = [];
  peak = 0;
  total = 0;
  deferred = 0;
  constructor(readonly limit: number) {}

  private prune(now: number) {
    const cutoff = now - WINDOW_MS;
    let i = 0;
    while (i < this.stamps.length && (this.stamps[i] ?? 0) <= cutoff) i += 1;
    if (i > 0) this.stamps.splice(0, i);
  }

  count(now: number): number {
    this.prune(now);
    return this.stamps.length;
  }

  /** 0 and the request is counted, or the ms until a slot frees. */
  tryAcquire(now: number): number {
    this.prune(now);
    if (this.stamps.length >= this.limit) {
      this.deferred += 1;
      return Math.max(1, (this.stamps[0] ?? now) + WINDOW_MS - now + 1);
    }
    this.record(now, 1);
    return 0;
  }

  /** Count requests that were not scheduled here; may exceed the limit (we cannot refuse them). */
  record(now: number, count: number) {
    this.prune(now);
    for (let i = 0; i < count; i += 1) this.stamps.push(now);
    this.total += count;
    this.peak = Math.max(this.peak, this.stamps.length);
  }
}

interface Failure {
  kind: 'refused' | 'error';
  code: string;
}

interface Entry {
  key: string;
  fetcher: Fetcher<unknown>;
  intervals: Map<number, number>; // subscriber id -> interval
  listeners: Set<() => void>;
  snapshot: Loadable<unknown>;
  lastGood: { data: unknown; at: number } | null;
  failure: Failure | null;
  fails: number;
  startedAt: number;
  inflight: AbortController | null;
  timer: unknown;
  idleSince: number | null;
  retry: () => void;
}

/** A failed call is a "refusal" only when the service answered with a 4xx we can explain. */
export function classifyFailure(outcome: { reason: string; code?: string; status?: number }): Failure {
  const status = outcome.status;
  if (status === 401) return { kind: 'refused', code: outcome.code ?? 'auth.required' };
  if (status === 429) return { kind: 'error', code: outcome.code ?? 'edge.rate_limited' };
  if (status !== undefined && status >= 400 && status < 500) return { kind: 'refused', code: outcome.code ?? 'unknown' };
  return { kind: 'error', code: outcome.code ?? outcome.reason };
}

function hashUnit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

export function documentVisibility(): VisibilitySource {
  return {
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    subscribe(listener) {
      if (typeof document === 'undefined') return () => undefined;
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

export function createPoller(options: PollerOptions = {}): Poller {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const visibility = options.visibility ?? documentVisibility();
  const staleIntervals = options.staleIntervals ?? 3;
  const minStaleMs = options.minStaleMs ?? 30_000;
  const budget = new RequestBudget(options.budgetPerMinute ?? 120);
  const entries = new Map<string, Entry>();
  const handles = new Map<string, Source<unknown>>();
  let subscriberSeq = 0;

  const interval = (entry: Entry): number => {
    let best = Infinity;
    for (const ms of entry.intervals.values()) if (ms < best) best = ms;
    return best;
  };

  function recompute(entry: Entry) {
    const t = now();
    const next: Loadable<unknown> = (() => {
      if (entry.failure?.kind === 'refused') return { status: 'refused', code: entry.failure.code } as const;
      if (entry.lastGood) {
        const limit = Math.max(minStaleMs, staleIntervals * (Number.isFinite(interval(entry)) ? interval(entry) : minStaleMs));
        if (!entry.failure || t - entry.lastGood.at <= limit)
          return { status: 'ready', data: entry.lastGood.data, asOf: entry.lastGood.at } as const;
      }
      if (entry.failure) return { status: 'error', retry: entry.retry } as const;
      return { status: 'loading' } as const;
    })();
    const prev = entry.snapshot;
    const same =
      prev.status === next.status &&
      (next.status === 'ready'
        ? prev.status === 'ready' && prev.data === next.data && prev.asOf === next.asOf
        : next.status === 'refused'
          ? prev.status === 'refused' && prev.code === next.code
          : next.status === 'error'
            ? prev.status === 'error' && prev.retry === next.retry
            : true);
    if (same) return;
    entry.snapshot = next;
    for (const listener of [...entry.listeners]) listener();
  }

  function stop(entry: Entry) {
    if (entry.timer !== null) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
  }

  function plan(entry: Entry) {
    stop(entry);
    if (entry.intervals.size === 0 || entry.inflight || !visibility.isVisible()) return;
    const base = interval(entry);
    const multiplier = Math.min(2 ** entry.fails, MAX_BACKOFF);
    const backedOff = base * multiplier + (entry.fails === 0 ? hashUnit(entry.key) * 0.2 * base : 0);
    const firstReadFailed = !entry.lastGood && entry.failure?.kind === 'error';
    const wait = firstReadFailed ? Math.min(backedOff, FIRST_READ_RETRY_MS * 2 ** (entry.fails - 1)) : backedOff;
    const delay = Math.max(0, entry.startedAt + wait - now());
    entry.timer = setTimer(() => {
      entry.timer = null;
      run(entry);
    }, delay);
  }

  function run(entry: Entry) {
    stop(entry);
    if (entry.intervals.size === 0 || entry.inflight || !visibility.isVisible()) return;
    const wait = budget.tryAcquire(now());
    if (wait > 0) {
      entry.timer = setTimer(() => {
        entry.timer = null;
        run(entry);
      }, wait);
      return;
    }
    const controller = new AbortController();
    entry.inflight = controller;
    entry.startedAt = now();
    const finish = (outcome: Outcome<unknown> | null) => {
      if (entry.inflight !== controller) return;
      entry.inflight = null;
      if (outcome?.ok) {
        entry.lastGood = { data: outcome.data, at: now() };
        entry.failure = null;
        entry.fails = 0;
      } else {
        entry.failure = outcome ? classifyFailure(outcome) : { kind: 'error', code: 'unreachable' };
        entry.fails += 1;
      }
      recompute(entry);
      plan(entry);
    };
    entry.fetcher(controller.signal).then(finish, () => finish(null));
  }

  function onVisibilityChange() {
    for (const entry of entries.values()) {
      if (!visibility.isVisible()) {
        stop(entry);
        continue;
      }
      if (entry.intervals.size === 0 || entry.inflight) continue;
      const age = now() - entry.startedAt;
      if (!entry.lastGood || age >= interval(entry)) run(entry);
      else plan(entry);
    }
  }
  const unsubscribeVisibility = visibility.subscribe(onVisibilityChange);

  function sweep() {
    const t = now();
    for (const [key, entry] of entries) {
      if (entry.intervals.size === 0 && entry.idleSince !== null && t - entry.idleSince > IDLE_EVICT_MS) {
        stop(entry);
        entries.delete(key);
        for (const handleKey of handles.keys()) if (handleKey.startsWith(`${key}|`)) handles.delete(handleKey);
      }
    }
  }

  function entryFor(key: string, fetcher: Fetcher<unknown>): Entry {
    let entry = entries.get(key);
    if (!entry) {
      const created: Entry = {
        key,
        fetcher,
        intervals: new Map(),
        listeners: new Set(),
        snapshot: { status: 'loading' },
        lastGood: null,
        failure: null,
        fails: 0,
        startedAt: -Infinity,
        inflight: null,
        timer: null,
        idleSince: null,
        retry: () => {
          created.fails = 0;
          if (!created.lastGood) {
            created.failure = null;
            recompute(created);
          }
          run(created);
        },
      };
      entries.set(key, created);
      entry = created;
    }
    entry.fetcher = fetcher; // the newest client wins (a refreshed session token)
    return entry;
  }

  return {
    source<T>(key: string, fetcher: Fetcher<T>, sourceOptions: SourceOptions): Source<T> {
      sweep();
      const entry = entryFor(key, fetcher as Fetcher<unknown>);
      const handleKey = `${key}|${sourceOptions.intervalMs}`;
      const cached = handles.get(handleKey);
      if (cached) return cached as Source<T>;
      const handle: Source<T> = {
        subscribe(listener) {
          const id = (subscriberSeq += 1);
          const first = entry.intervals.size === 0;
          entry.intervals.set(id, sourceOptions.intervalMs);
          entry.listeners.add(listener);
          entry.idleSince = null;
          if (first) {
            const age = now() - entry.startedAt;
            if (!entry.lastGood || age >= interval(entry)) run(entry);
            else plan(entry);
          } else if (!entry.inflight) {
            plan(entry); // a faster subscriber may shorten the wait
          }
          return () => {
            entry.intervals.delete(id);
            entry.listeners.delete(listener);
            if (entry.intervals.size === 0) {
              stop(entry);
              entry.idleSince = now();
            } else if (!entry.inflight) plan(entry);
          };
        },
        getSnapshot: () => entry.snapshot as Loadable<T>,
      };
      handles.set(handleKey, handle as Source<unknown>);
      return handle;
    },
    refresh(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.inflight?.abort();
      entry.inflight = null;
      run(entry);
    },
    recordExternalRequest(count = 1) {
      budget.record(now(), count);
    },
    stats() {
      return {
        requestsLastMinute: budget.count(now()),
        peakPerMinute: budget.peak,
        totalRequests: budget.total,
        deferred: budget.deferred,
        limit: budget.limit,
        activeKeys: [...entries.values()].filter((e) => e.intervals.size > 0).length,
      };
    },
    dispose() {
      unsubscribeVisibility();
      for (const entry of entries.values()) {
        stop(entry);
        entry.inflight?.abort();
        entry.inflight = null;
        entry.intervals.clear();
        entry.listeners.clear();
      }
      entries.clear();
      handles.clear();
    },
  };
}

let shared: Poller | null = null;

/** The tab's single scheduler. */
export function defaultPoller(): Poller {
  shared ??= createPoller();
  return shared;
}

/** Replace the shared scheduler (tests, E2E counters). Disposes the old one. */
export function setDefaultPoller(next: Poller | null): void {
  shared?.dispose();
  shared = next;
}
