/**
 * Auto-mirror place into spot — follower `placeOrder` wire.
 *
 * `planMirror` claims a durable plan. Place uses that plan's qty/side/notional
 * as a limit envelope through the ordinary spot path (holds + ledger). Never
 * invents a fill or a mid.
 *
 * Default OFF (`TRADE_COPY_PLACE_MIRROR`). Flag off or blank §8 copy env
 * refuse by name — never a silent success. `clientOrderId` on placeOrder is
 * 1–64 chars; hash when the readable form does not fit.
 */
import { createHash } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import { div, type Amount } from '@intafaced/ledger-client';

export const COPY_AUTO_MIRROR_PLACE_SOCKET = 'socket.copy-auto-mirror-place' as const;

export const COPY_AUTO_MIRROR_PLACE_RESIDUAL =
  'trade.copy auto-mirror place into spot is refuse-closed until TRADE_COPY_PLACE_MIRROR is on and the follower place port is wired — never invent fills';

export const COPY_PLACE_DISABLED_RESIDUAL = 'TRADE_COPY_PLACE_MIRROR is off — refuse-closed (never silent skip of copy.placeMirror)';

export const COPY_PAPER_LIVE_RESIDUAL = 'Paper leader fills cannot place a live follower order — refuse-closed (never mix paper into live)';

/** Same bound as TradeService.placeOrderInner — a retry key longer than this never holds. */
export const COPY_MIRROR_CLIENT_ORDER_ID_MAX = 64;

export type PlaceFollowerOrderInput = {
  /** Internal verified CopyService provenance, never a public admission receipt. */
  readonly followId?: string;
  readonly symbol?: string;
  readonly marketId?: string;
  readonly side: 'buy' | 'sell';
  readonly qty: Amount;
  /** Limit from plan notional/qty — never a book mid. */
  readonly price: Amount;
  readonly clientOrderId: string;
};

export type PlaceFollowerOrderPort = (principal: Principal, input: PlaceFollowerOrderInput) => Promise<{ orderId: string }>;

export type InspectCopyMarket = (symbol: string) => Promise<{ paper: boolean } | null>;

/** Denylist: only 1/true/on/yes enable. Empty / unset / anything else = off. */
export function parseCopyPlaceMirrorFlag(raw: string | boolean | undefined | null): boolean {
  if (typeof raw === 'boolean') return raw;
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export function autoMirrorPlaceStatus(enabled: boolean) {
  return {
    published: enabled,
    socket: COPY_AUTO_MIRROR_PLACE_SOCKET,
    residual: enabled ? null : COPY_PLACE_DISABLED_RESIDUAL,
  };
}

export function copyMirrorClientOrderId(followId: string, fillId: string): string {
  const readable = `copy-mirror:${followId}:${fillId}`;
  if (readable.length <= COPY_MIRROR_CLIENT_ORDER_ID_MAX) return readable;
  return createHash('sha256').update(readable).digest('hex').slice(0, COPY_MIRROR_CLIENT_ORDER_ID_MAX);
}

/** Limit price implied by the planned envelope. Does not consult a book. */
export function copyLimitPriceFromPlan(qty: Amount, notional: Amount): Amount {
  return div(notional, qty, 'half-up');
}
