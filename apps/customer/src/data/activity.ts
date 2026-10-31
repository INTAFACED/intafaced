/**
 * Money history for the Activity screen (UI-SPEC 5.4): `bank.activity.list`, newest first, paged by cursor.
 *
 * Framework-free core (`createActivityFeed`) plus the hook that reads it. The feed fetches the first page when
 * somebody starts reading it and one more page each time `loadMore()` is called; it never polls. Rows are posted
 * ledger entries, so every one is complete. Kinds the server adds later read as `other` instead of failing the page.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { ApiClient } from '../shared/api';
import { useSession } from '../features/session/session';
import { classifyFailure } from './poll';
import type { Source } from './source';
import type { Decimal, Loadable } from './types';

export const ACTIVITY_KINDS = [
  'deposit',
  'welcome_funds',
  'transfer_in',
  'transfer_out',
  'trade',
  'fee',
  'payment',
  'withdrawal',
  'space_move',
  // Savings in and out of Earn, staking, and rewards paid (svc-bank `bank.activity.list`).
  'earn',
  'staking',
  'reward',
  // Order holds (and amends) and releases. An older server files them under `other`.
  'order_hold',
  'order_release',
  'other',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

const KNOWN = new Set<string>(ACTIVITY_KINDS);

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  /** `in` adds to what you hold, `out` takes away. The amount itself is unsigned. */
  direction: 'in' | 'out';
  asset: string;
  amount: Decimal;
  /** ISO time the entry posted. */
  postedAt: string;
  txId: string;
  /** Who the money came from or went to, when it was another person. */
  counterparty: { handle: string } | null;
  /** The named account it moved in or out of, when there is one. */
  spaceName: string | null;
  /**
   * The signed-in person's own trade order this line belongs to: its holds, releases and fills. Absent on every other
   * line, and on every line from a server that does not send it yet (those lines then simply never group).
   */
  orderId?: string;
  /** The note the sender wrote on a payment between two people. Both of them see it. Absent on every other line. */
  paymentNote?: string;
  /** The signed-in person's own note on this line, when they wrote one. Never shown to anyone else. */
  privateNote?: string;
  /** True on the line that brought in an asset the customer bought. Absent on every other line. */
  purchase?: true;
  /** The signed-in person's own wording for this line on the statements and reports they download. Never shown to anyone else. */
  reportDescription?: string;
}

const itemSchema = z
  .object({
    id: z.string(),
    kind: z.string().transform((kind): ActivityKind => (KNOWN.has(kind) ? (kind as ActivityKind) : 'other')),
    direction: z.enum(['in', 'out']),
    asset: z.string(),
    amount: z.string(),
    postedAt: z.string(),
    txId: z.string(),
    counterparty: z
      .object({ handle: z.string() })
      .nullish()
      .transform((value) => value ?? null),
    spaceName: z
      .string()
      .nullish()
      .transform((value) => value ?? null),
    orderId: z
      .string()
      .nullish()
      .transform((value) => (value ? value : undefined)),
    purchase: z
      .literal(true)
      .nullish()
      .transform((value) => (value === true ? (true as const) : undefined)),
    // The bank names the payment's own note `note`; it is a different thing from the customer's private note.
    note: z
      .string()
      .nullish()
      .transform((value) => (value ? value : undefined)),
    privateNote: z
      .string()
      .nullish()
      .transform((value) => (value ? value : undefined)),
    reportDescription: z
      .string()
      .nullish()
      .transform((value) => (value ? value : undefined)),
  })
  .transform(({ note, ...item }) => (note ? { ...item, paymentNote: note } : item));

const pageShape = z.object({ items: z.array(itemSchema), nextCursor: z.string().nullable() });
export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}
/** Typed by what comes OUT of the parse (the kind is already normalised), which `api.query` reads as the data type. */
export const activityPageSchema = pageShape as unknown as z.ZodType<ActivityPage>;

/**
 * A payment this device sent, as the device kept it when the bank confirmed it. Only the two fields that name the
 * other person are read here.
 */
export interface DeviceSend {
  ledgerTxId: string;
  handle: string | null;
}

/**
 * Names the other person on a payment this device sent, when the bank's activity line does not. The handle comes from the
 * confirmation this device kept at the time (matched on the ledger transaction), never from a guess. A name the bank
 * already gave always wins, and a line with no matching device record stays unnamed.
 */
export function withDeviceHandle<T extends Pick<ActivityItem, 'kind' | 'txId' | 'counterparty'>>(item: T, sent: readonly DeviceSend[]): T {
  if (item.kind !== 'transfer_out' || item.counterparty) return item;
  const match = sent.find((entry) => entry.handle && entry.ledgerTxId === item.txId);
  return match?.handle ? { ...item, counterparty: { handle: match.handle } } : item;
}
export function withDeviceHandles<T extends Pick<ActivityItem, 'kind' | 'txId' | 'counterparty'>>(
  items: readonly T[],
  sent: readonly DeviceSend[],
): T[] {
  return sent.length === 0 ? [...items] : items.map((item) => withDeviceHandle(item, sent));
}

export interface ActivityFeed {
  items: ActivityItem[];
  hasMore: boolean;
  loadingMore: boolean;
  /** The last "load more" failed; the rows already shown are still good. */
  moreFailed: boolean;
  loadMore: () => void;
}

export interface ActivityOptions {
  /** Only this asset's rows. */
  assetId?: string;
  /** Rows per page, 1 to 200. Default 50. */
  pageSize?: number;
  /** Oldest first. The bank refuses this on a very long history rather than cutting it. */
  sort?: 'asc';
  /** `main`, or the id of one named account. */
  accountId?: string;
  /** A UTC calendar year. */
  year?: number;
  /** Part of a withdrawal address (4 or more characters). */
  address?: string;
}

export const ACTIVITY_PAGE_SIZE = 50;

type State =
  | { phase: 'loading' }
  | { phase: 'refused'; code: string }
  | { phase: 'error' }
  | { phase: 'ready'; items: ActivityItem[]; cursor: string | null; loadingMore: boolean; moreFailed: boolean };

export function createActivityFeed(api: ApiClient, options: ActivityOptions = {}, now: () => number = Date.now): Source<ActivityFeed> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? ACTIVITY_PAGE_SIZE)));
  const listeners = new Set<() => void>();
  let state: State = { phase: 'loading' };
  let inflight: AbortController | null = null;
  let snapshot: Loadable<ActivityFeed> = { status: 'loading' };
  let asOf = 0;

  const publish = () => {
    snapshot = project();
    for (const listener of [...listeners]) listener();
  };

  function project(): Loadable<ActivityFeed> {
    switch (state.phase) {
      case 'loading':
        return { status: 'loading' };
      case 'refused':
        return { status: 'refused', code: state.code };
      case 'error':
        return { status: 'error', retry: reload };
      case 'ready': {
        if (state.items.length === 0 && state.cursor === null) return { status: 'empty' };
        return {
          status: 'ready',
          asOf,
          data: {
            items: state.items,
            hasMore: state.cursor !== null,
            loadingMore: state.loadingMore,
            moreFailed: state.moreFailed,
            loadMore,
          },
        };
      }
    }
  }

  async function fetchPage(cursor: string | null): Promise<void> {
    const controller = new AbortController();
    inflight = controller;
    const input = {
      limit,
      ...(cursor ? { cursor } : {}),
      ...(options.assetId ? { assetId: options.assetId } : {}),
      ...(options.sort ? { sort: options.sort } : {}),
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.year !== undefined ? { year: options.year } : {}),
      ...(options.address ? { address: options.address } : {}),
    };
    const result = await api.query('bank', 'activity.list', input, activityPageSchema, { signal: controller.signal });
    if (inflight !== controller || controller.signal.aborted) return;
    inflight = null;
    if (result.ok) {
      const seen = new Set(state.phase === 'ready' ? state.items.map((item) => item.id) : []);
      const fresh = result.data.items.filter((item) => !seen.has(item.id));
      asOf = now();
      state = {
        phase: 'ready',
        items: state.phase === 'ready' && cursor ? [...state.items, ...fresh] : fresh,
        cursor: result.data.nextCursor,
        loadingMore: false,
        moreFailed: false,
      };
      publish();
      return;
    }
    if (state.phase === 'ready' && cursor) {
      state = { ...state, loadingMore: false, moreFailed: true };
      publish();
      return;
    }
    const failure = classifyFailure(result);
    state = failure.kind === 'refused' ? { phase: 'refused', code: failure.code } : { phase: 'error' };
    publish();
  }

  function reload() {
    inflight?.abort();
    inflight = null;
    state = { phase: 'loading' };
    publish();
    void fetchPage(null);
  }

  function loadMore() {
    if (state.phase !== 'ready' || state.cursor === null || state.loadingMore) return;
    const cursor = state.cursor;
    state = { ...state, loadingMore: true, moreFailed: false };
    publish();
    void fetchPage(cursor);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (state.phase === 'loading' && inflight === null) void fetchPage(null);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && inflight) {
          inflight.abort();
          inflight = null;
          // Nothing arrived: forget a half-made load so the next reader starts again.
          if (state.phase === 'ready' && state.loadingMore) state = { ...state, loadingMore: false };
        }
      };
    },
    getSnapshot: () => snapshot,
  };
}

/** The signed-in person's money history, newest first, with "load more" paging. */
export function useActivity(options: ActivityOptions = {}): Loadable<ActivityFeed> {
  const { api, userId } = useSession();
  const { assetId, pageSize, sort, accountId, year, address } = options;
  const source = useMemo(
    () => createActivityFeed(api, { assetId, pageSize, sort, accountId, year, address }),
    [api, userId, assetId, pageSize, sort, accountId, year, address],
  );
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
