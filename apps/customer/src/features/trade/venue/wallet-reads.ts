import { HyperliquidWalletReads } from '@intafaced/venue-hyperliquid/wallet-reads';
import {
  VenueRefusalError,
  encodeVenueWire,
  withOwnOrderLabel,
  type UserVenueAccount,
  type UserVenueOrder,
} from '@intafaced/venue-contracts';
import type { ZodType } from 'zod';
import type { ApiResult } from '../../../shared/api';

/**
 * A person's own fills, balances, positions, account mode, open orders and orders by client id on the venue, read from
 * their own browser.
 *
 * The test network limits each IP by the weight of its reads a minute. Through svc-trade's door, every desk's own-wallet
 * reads left from the box's one IP, and one trading tester spent more than all of it. Where the door names the venue's
 * public read endpoint (`walletReads` on its status: the live test network only), these reads go there straight from
 * this browser, by the wallet's address with no key, so they count against the person's own IP. The answers are parsed
 * by the venue adapter's own code and checked against the door's own reply schemas, so a screen sees the same shapes
 * either way. Anything else (a sub-account, another venue, a recording played back, a door that names none) reads
 * through the door as before.
 */

/** The door's `walletReads`: the venue's public read endpoint and the perp DEXs it is read on. */
export interface WalletReadsTarget {
  readonly venueId: string;
  readonly baseUrl: string;
  readonly perpDexs: readonly string[];
}

/** The reads made from the browser: the ones each open desk polls. */
export type WalletRead = 'fills' | 'balances' | 'positions' | 'accountMode' | 'openOrders' | 'orderByClientId';

export interface WalletReader {
  readonly venueId: string;
  /** `arg` is the start time of a fills read (`since`) and the client order id of an `orderByClientId` read. */
  read<T>(read: WalletRead, owner: string, schema: ZodType<T>, arg?: string): Promise<ApiResult<T>>;
  /** After the person's own signed action: what this page kept of their reads is read again. */
  forgetOwnReads(): void;
}

/**
 * The person's own order labels for `owner` (J-derivatives-04 #2), by lower-case venue client order id: the venue does
 * not know them, so they come from the door's record (`trade.venueOrderLabels.list`), which reads nothing at the venue.
 */
export type OwnOrderLabels = (owner: string) => Promise<ApiResult<ReadonlyMap<string, string>>>;

/**
 * Built once per target: the adapter keeps the venue's listing (coin names to symbols) for a minute. An order read adds
 * the person's own labels from `labels`, kept until an order shows that was not there when they were read, or the
 * person's own signed action: a label is set only when its order is signed, so a kept list covers every order it saw.
 */
export function walletReader(
  target: WalletReadsTarget,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  labels: OwnOrderLabels = async () => ({ ok: true, data: new Map() }),
): WalletReader {
  const reads = new HyperliquidWalletReads({
    fetch: (input, init) => fetchImpl(input, init),
    perpDexs: target.perpDexs,
    warn: (message) => console.warn(message),
  });
  const keptLabels = new Map<string, { labels: ReadonlyMap<string, string>; seen: Set<string> }>();
  const labelled = async (owner: string, orders: readonly UserVenueOrder[]): Promise<ApiResult<UserVenueOrder[]>> => {
    const ids = orders.flatMap((o) => (o.venueClientOrderId ? [o.venueClientOrderId.toLowerCase()] : []));
    let kept = keptLabels.get(owner);
    if (!kept || ids.some((id) => !kept!.seen.has(id))) {
      const read = await labels(owner);
      if (!read.ok) return read;
      kept = { labels: read.data, seen: new Set(ids) };
      keptLabels.set(owner, kept);
    }
    const map = kept.labels;
    return { ok: true, data: orders.map((o) => withOwnOrderLabel(o, map)) };
  };
  return {
    venueId: target.venueId,
    forgetOwnReads: () => {
      reads.forgetOwnReads();
      keptLabels.clear();
    },
    async read<T>(read: WalletRead, owner: string, schema: ZodType<T>, arg?: string): Promise<ApiResult<T>> {
      const account: UserVenueAccount = { venueId: target.venueId, owner: owner.trim().toLowerCase(), subAccount: null };
      let value: unknown;
      try {
        if (read === 'fills') {
          const from = new Date(arg ?? '');
          if (Number.isNaN(from.getTime())) return refused('error', 'trade.venue.invalid_since', 'since is required (an ISO time)', 400);
          value = await reads.fills(account, from);
        } else if (read === 'balances') value = await reads.balances(account);
        else if (read === 'accountMode') value = await reads.accountMode(account);
        else if (read === 'openOrders') {
          const open = await reads.openOrders(account);
          const shown = await labelled(account.owner, open.value);
          if (!shown.ok) return shown;
          value = { ...open, value: shown.data };
        } else if (read === 'orderByClientId') {
          const one = await reads.orderByClientId(account, arg ?? '');
          if (one.value === null) value = one;
          else {
            const shown = await labelled(account.owner, [one.value]);
            if (!shown.ok) return shown;
            value = { ...one, value: shown.data[0] };
          }
        } else value = await reads.positions(account);
      } catch (err) {
        if (err instanceof VenueRefusalError) {
          const down = err.refusal.code === 'venue_down';
          return refused(down ? 'unreachable' : 'error', `trade.venue.${err.refusal.code}`, err.refusal.detail, down ? 503 : 422);
        }
        return refused('error', 'trade.venue.wallet_read_failed', err instanceof Error ? err.message : String(err));
      }
      // The same wire form the door sends (every Amount a decimal string), checked by the door's own reply schema.
      const parsed = schema.safeParse(JSON.parse(JSON.stringify(encodeVenueWire(value))));
      if (!parsed.success) return refused('invalid_response', 'trade.venue.wallet_read_invalid', parsed.error.message);
      return { ok: true, data: parsed.data };
    },
  };
}

function refused(reason: 'unreachable' | 'error' | 'invalid_response', code: string, message: string, status?: number): ApiResult<never> {
  return { ok: false, reason, code, message, ...(status === undefined ? {} : { status }) };
}
