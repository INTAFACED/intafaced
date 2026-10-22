import { describe, expect, it } from 'vitest';
import { buildLateComplaint, complaintRoute, LateComplaintError } from './late-complaint.js';
import { TRADE_STATUSES, type TradeStatus } from './state.js';

const trade = (status: TradeStatus) => ({ id: 't1', status, buyerId: 'b', sellerId: 's' });

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LateComplaintError) return e.code;
    throw e;
  }
  return undefined;
}

describe('P-disputes-security-01 late complaint path', () => {
  it('routes every status: open trades dispute, finished trades complain, others neither', () => {
    const got = Object.fromEntries(TRADE_STATUSES.map((s) => [s, complaintRoute(s)]));
    expect(got).toEqual({
      created: 'none',
      escrowed: 'dispute',
      fiat_sent: 'dispute',
      disputed: 'none',
      released: 'late_complaint',
      cancelled: 'late_complaint',
    });
  });

  it('a released trade builds a p2p support ticket with the trade id and a stable key', () => {
    expect(buildLateComplaint({ trade: trade('released'), reporterId: 'b', description: '  wrong amount  ' })).toEqual({
      category: 'p2p',
      tradeId: 't1',
      reporterId: 'b',
      description: 'wrong amount',
      idempotencyKey: 'p2p:late-complaint:t1:b',
    });
  });

  it('refuses non-parties, open trades, disputed/created trades and blank descriptions', () => {
    expect(code(() => buildLateComplaint({ trade: trade('released'), reporterId: 'x', description: 'd' }))).toBe(
      'p2p.late_complaint_not_allowed',
    );
    expect(code(() => buildLateComplaint({ trade: trade('released'), reporterId: '', description: 'd' }))).toBe(
      'p2p.late_complaint_not_allowed',
    );
    for (const s of ['escrowed', 'fiat_sent', 'disputed', 'created'] as const) {
      expect(code(() => buildLateComplaint({ trade: trade(s), reporterId: 's', description: 'd' }))).toBe('p2p.late_complaint_not_allowed');
    }
    expect(code(() => buildLateComplaint({ trade: trade('cancelled'), reporterId: 's', description: '   ' }))).toBe(
      'p2p.description_required',
    );
  });
});
