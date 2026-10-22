import { describe, expect, it } from 'vitest';
import { buildLateComplaint, complaintRoute, LATE_COMPLAINT_MAX_DESCRIPTION, LateComplaintError } from './late-complaint.js';
import { assertTransition } from './state.js';

const trade = { id: 't1', status: 'released' as const, buyerId: 'b', sellerId: 's' };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LateComplaintError) return e.code;
    throw e;
  }
  return undefined;
}

describe('P-disputes-security-01 late complaint limits (DR3 minors 4 and 5)', () => {
  it('a description at the maximum is accepted; one character over refuses p2p.description_too_long', () => {
    const max = 'x'.repeat(LATE_COMPLAINT_MAX_DESCRIPTION);
    expect(buildLateComplaint({ trade, reporterId: 'b', description: max }).description).toBe(max);
    expect(code(() => buildLateComplaint({ trade, reporterId: 'b', description: max + 'x' }))).toBe('p2p.description_too_long');
  });

  it('the limit counts characters after trim, not UTF-16 units or padding', () => {
    const emoji = '\u{1F600}'.repeat(LATE_COMPLAINT_MAX_DESCRIPTION);
    expect(buildLateComplaint({ trade, reporterId: 's', description: `  ${emoji}  ` }).description).toBe(emoji);
  });

  it('after a resolved dispute (disputed -> released or cancelled) a party can file a late complaint', () => {
    for (const to of ['released', 'cancelled'] as const) {
      expect(() => assertTransition('disputed', to)).not.toThrow();
      expect(complaintRoute(to)).toBe('late_complaint');
      expect(buildLateComplaint({ trade: { ...trade, status: to }, reporterId: 'b', description: 'ruling was wrong' }).category).toBe(
        'p2p',
      );
    }
    expect(complaintRoute('disputed')).toBe('none');
  });
});
