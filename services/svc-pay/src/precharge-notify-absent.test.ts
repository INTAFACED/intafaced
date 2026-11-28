import { describe, expect, it } from 'vitest';
import { PRECHARGE_NOTIFY_SOCKET, preChargeNotifyGap } from './subscriptions/mandate-product.js';

/**
 * SPEC §4: "Every charge is notified before it lands, not after."
 *
 * Unwired bus ? skipped_unwired on the execution. Merchant webhooks remain
 * post-payment. Never invent notified:true.
 */

describe('pre-charge notify — honest skip when unwired', () => {
  it('names skipped_unwired and forbids invent notified', () => {
    expect(preChargeNotifyGap().socket).toBe(PRECHARGE_NOTIFY_SOCKET);
    expect(preChargeNotifyGap().status).toBe('unwired');
    expect(preChargeNotifyGap().notifyStatus).toBe('skipped_unwired');
    expect(preChargeNotifyGap().inventForbidden).toBe(true);
    expect(preChargeNotifyGap().notified).toBe(false);
    expect(preChargeNotifyGap().code).toBe('pay.subscription_notify_unwired');
  });
});
