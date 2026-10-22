import { describe, expect, it } from 'vitest';
import { EVIDENCE_KINDS } from './disputes.js';
import {
  DISPUTE_REASON_CATEGORIES,
  disputeCountdown,
  disputeGuidance,
  disputeReasonCategory,
} from './merchant-disp-bill-rep-evidence-draft.js';

describe('M-disp-02 guidance and countdown (pure)', () => {
  it('product not received lists proof of delivery first (disputes-risk-009)', () => {
    const g = disputeGuidance('product_not_received');
    expect(g.recommended[0]).toBe('shipping_proof');
    expect(g.meaning).toMatch(/never received/);
  });

  it('every category has a meaning and only known evidence kinds', () => {
    for (const c of DISPUTE_REASON_CATEGORIES) {
      const g = disputeGuidance(c);
      expect(g.meaning.length).toBeGreaterThan(10);
      expect(g.recommended.length).toBeGreaterThan(0);
      for (const k of g.recommended) expect(EVIDENCE_KINDS).toContain(k);
    }
  });

  it('a raw scheme code is never translated: unknown or blank maps to general', () => {
    expect(disputeReasonCategory('4853')).toBe('general');
    expect(disputeReasonCategory(null)).toBe('general');
    expect(disputeReasonCategory('  ')).toBe('general');
    expect(disputeReasonCategory('Fraudulent')).toBe('fraudulent');
  });

  it('due in 3 days reads 3 days, then past due after the date (disputes-risk-008)', () => {
    const now = new Date('2026-10-22T00:00:00Z');
    expect(disputeCountdown(new Date('2026-10-25T00:00:00Z'), now)).toEqual({
      dueAt: '2026-10-25T00:00:00.000Z',
      pastDue: false,
      daysLeft: 3,
    });
    expect(disputeCountdown(new Date('2026-10-21T23:00:00Z'), now)).toMatchObject({ pastDue: true, daysLeft: 0 });
  });

  it('no due date from the rail stays null, never a default window', () => {
    expect(disputeCountdown(null, new Date())).toBeNull();
  });
});
