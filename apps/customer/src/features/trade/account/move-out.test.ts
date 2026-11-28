import { describe, expect, it } from 'vitest';
import { moveOutRefusal } from './move-out';

describe('moveOutRefusal (J-derivatives-25 #10)', () => {
  it('takes exactly the venue’s withdrawable figure and refuses the smallest amount above it', () => {
    expect(moveOutRefusal('451.75', '451.75')).toBeNull();
    expect(moveOutRefusal('451.750001', '451.75')).toBe('above');
    expect(moveOutRefusal('0.01', '0')).toBe('above');
  });
  it('refuses with no figure from the venue, and an amount that is not above zero', () => {
    expect(moveOutRefusal('1', null)).toBe('unreported');
    expect(moveOutRefusal(null, '10')).toBe('amount');
    expect(moveOutRefusal('0', '10')).toBe('amount');
  });
});
