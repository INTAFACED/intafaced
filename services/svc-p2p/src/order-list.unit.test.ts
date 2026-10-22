import { describe, expect, it } from 'vitest';
import { TRADE_STATUSES } from './state.js';
import { decodeTradeCursor, displayStatus, encodeTradeCursor, tabOf } from './order-list.js';

describe('order list display status (P-trade-orders-13)', () => {
  it('maps every live state to a readable label', () => {
    expect(displayStatus({ status: 'created', resolutionReason: null })).toBe('waiting_for_escrow');
    expect(displayStatus({ status: 'escrowed', resolutionReason: null })).toBe('waiting_for_buyer_to_pay');
    expect(displayStatus({ status: 'fiat_sent', resolutionReason: null })).toBe('waiting_for_seller_to_release');
    expect(displayStatus({ status: 'disputed', resolutionReason: null })).toBe('appealing');
  });

  it('tells a timeout cancel and a ruling cancel apart from the recorded reason', () => {
    expect(displayStatus({ status: 'cancelled', resolutionReason: 'timeout.payment' })).toBe('cancelled_by_timeout');
    expect(displayStatus({ status: 'cancelled', resolutionReason: 'moderator:abc' })).toBe('cancelled_by_dispute_ruling');
    expect(displayStatus({ status: 'cancelled', resolutionReason: 'buyer' })).toBe('cancelled');
    expect(displayStatus({ status: 'released', resolutionReason: 'moderator:abc' })).toBe('completed_by_dispute_ruling');
    expect(displayStatus({ status: 'released', resolutionReason: null })).toBe('completed');
  });

  it('every state has exactly one tab', () => {
    for (const s of TRADE_STATUSES) expect(typeof tabOf(s)).toBe('string');
    expect(tabOf('disputed')).toBe('in_dispute');
  });

  it('cursor round-trips', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(decodeTradeCursor(encodeTradeCursor('1700000000000000', id))).toEqual({ createdAtMicros: '1700000000000000', id });
  });
});
