import { describe, expect, it } from 'vitest';
import { ambassadorVerb, rowText, vendorDecisions } from './actions-model';

describe('which decisions a row offers', () => {
  it('an application can be approved or rejected; an approved vendor can only be suspended; a suspended one approved again', () => {
    expect(vendorDecisions('applied')).toEqual(['approved', 'rejected']);
    expect(vendorDecisions('approved')).toEqual(['suspended']);
    expect(vendorDecisions('suspended')).toEqual(['approved']);
  });
  it('a rejected or unknown status offers nothing', () => {
    expect(vendorDecisions('rejected')).toEqual([]);
    expect(vendorDecisions('whatever')).toEqual([]);
  });
  it('an active ambassador can be frozen, a frozen one unfrozen, anything else nothing', () => {
    expect(ambassadorVerb('active')).toBe('freeze');
    expect(ambassadorVerb('frozen')).toBe('unfreeze');
    expect(ambassadorVerb('?')).toBeNull();
  });
  it('reads a text cell from a row, and nothing for a missing or non-text one', () => {
    const row = {
      id: 'r',
      cells: [
        { key: 'status', label: 'S', kind: 'text', detail: false, value: 'applied' },
        { key: 'n', label: 'N', kind: 'int', detail: false, value: 3 },
      ],
    } as const;
    expect(rowText(row, 'status')).toBe('applied');
    expect(rowText(row, 'n')).toBeNull();
    expect(rowText(row, 'missing')).toBeNull();
  });
});
