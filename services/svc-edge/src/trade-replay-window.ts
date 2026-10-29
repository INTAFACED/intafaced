/**
 * Owner replay window for a private trade place.
 *
 * The length is the reference verifier's window (`REQUEST_SIGN_WINDOW_SECONDS`
 * in api-key-request-sign.ts), used only by this module's acceptance test; the
 * live signed-request window is the owner's, published by identity.
 * A timestamp outside that window is not executed. Inside the window, the
 * same client order id returns the original order.
 */
import { REQUEST_SIGN_WINDOW_SECONDS } from './api-key-request-sign.js';

export const TRADE_OWNER_REPLAY_WINDOW_SECONDS = REQUEST_SIGN_WINDOW_SECONDS;

export interface PrivatePlaceOrder {
  readonly orderId: string;
  readonly clientOrderId: string;
}

export class PrivateTradeWindow {
  private readonly orders = new Map<string, PrivatePlaceOrder>();

  constructor(
    private readonly now: Date,
    private readonly openNew: (clientOrderId: string) => { orderId: string },
  ) {}

  count(): number {
    return this.orders.size;
  }

  submit(input: {
    readonly timestampSeconds: number;
    readonly clientOrderId: string;
  }): { ok: false; code: 'timestamp_outside_window' } | { ok: true; duplicate: boolean; order: PrivatePlaceOrder } {
    const nowSeconds = Math.floor(this.now.getTime() / 1000);
    const outside =
      !Number.isSafeInteger(input.timestampSeconds) || Math.abs(nowSeconds - input.timestampSeconds) > TRADE_OWNER_REPLAY_WINDOW_SECONDS;
    if (outside) return { ok: false, code: 'timestamp_outside_window' };

    const existing = this.orders.get(input.clientOrderId);
    if (existing) return { ok: true, duplicate: true, order: existing };

    const created = this.openNew(input.clientOrderId);
    const order: PrivatePlaceOrder = { orderId: created.orderId, clientOrderId: input.clientOrderId };
    this.orders.set(input.clientOrderId, order);
    return { ok: true, duplicate: false, order };
  }
}
