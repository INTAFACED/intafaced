import type { NotifyService } from './notify-service.js';

/**
 * One inbox notice per owner when a market halt epoch begins.
 *
 * The order book is read, not written. A failed or timed-out notice does not
 * unhalt the journal. Offline owners still get the stored inbox row: the row
 * is the notice, and a live session is not required to keep it.
 */

export const MARKET_HALT_KIND = 'trade.market_halted';
export const MARKET_HALT_SUBJECT = 'intafaced.notify.trade.market.halted';
export const MARKET_HALT_TITLE_KEY = 'notify.trade.market_halted.title';
export const MARKET_HALT_BODY_KEY = 'notify.trade.market_halted.body';

export interface RestingOrder {
  readonly orderId: string;
  readonly ownerId: string;
  readonly marketId: string;
  readonly status: string;
}

export interface HaltJournal {
  readonly marketId: string;
  readonly epoch: string;
  readonly halted: boolean;
  unhalt(): void;
}

export interface MarketHaltNoticeInput {
  readonly journal: HaltJournal;
  readonly orders: readonly RestingOrder[];
  /** Present when the caller knows who has a live session. Storage does not depend on it. */
  readonly onlineUserIds?: ReadonlySet<string>;
}

export interface MarketHaltNoticeResult {
  readonly written: number;
  readonly halted: boolean;
  readonly deliveryFailed: boolean;
}

export async function notifyOwnersOfMarketHalt(notify: NotifyService, input: MarketHaltNoticeInput): Promise<MarketHaltNoticeResult> {
  const { journal } = input;
  // Presence does not gate the inbox row. Offline owners are stored too.
  void input.onlineUserIds;
  if (!journal.halted || journal.epoch.trim() === '' || journal.marketId.trim() === '') {
    return { written: 0, halted: journal.halted, deliveryFailed: false };
  }

  const byOwner = new Map<string, string[]>();
  for (const row of input.orders) {
    if (row.marketId !== journal.marketId || row.status !== 'open') continue;
    const ids = byOwner.get(row.ownerId);
    if (ids) ids.push(row.orderId);
    else byOwner.set(row.ownerId, [row.orderId]);
  }

  let written = 0;
  let deliveryFailed = false;
  for (const [ownerId, orderIds] of byOwner) {
    try {
      const created = await notify.create({
        userId: ownerId,
        kind: MARKET_HALT_KIND,
        titleKey: MARKET_HALT_TITLE_KEY,
        bodyKey: MARKET_HALT_BODY_KEY,
        params: {
          marketId: journal.marketId,
          epoch: journal.epoch,
          submits: 'refused',
          cancels: 'available',
          orderIds,
        },
        href: `/trade/${journal.marketId}`,
        severity: 'action',
        sourceSubject: MARKET_HALT_SUBJECT,
        sourceIdempotencyKey: journal.epoch,
        outOfApp: false,
      });
      if (created.inserted) written += 1;
    } catch {
      deliveryFailed = true;
    }
  }

  return { written, halted: journal.halted, deliveryFailed };
}
