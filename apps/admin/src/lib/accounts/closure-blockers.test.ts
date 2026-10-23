import { describe, expect, it } from 'vitest';
import { describeBlockers } from './closure-blockers';

describe('describeBlockers', () => {
  it('says nothing when nothing is open', () => {
    expect(describeBlockers(undefined)).toBeNull();
    expect(describeBlockers([])).toBeNull();
  });
  it('names known blockers in words and unknown ones by code', () => {
    expect(
      describeBlockers([
        { code: 'active_card', count: 1 },
        { code: 'open_dispute', count: 3 },
        { code: 'toString', count: 1 },
      ]),
    ).toBe('1 × card not closed, 3 × open P2P dispute, 1 × toString');
  });
});
