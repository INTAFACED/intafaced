import { describe, expect, it } from 'vitest';
import { addCondition, addGroup, conditionText, emptyRule, groupAt, placeName, removeAt, setCondition, setOp } from './rule-tree';

describe('campaign rule tree editing', () => {
  it('nests each new group inside the group being built, never empty', () => {
    const a = addGroup(emptyRule(), [], 'and');
    expect(a.place).toEqual([0]);
    const b = addGroup(a.tree, a.place, 'or');
    expect(b.place).toEqual([0, 1]);
    expect(b.tree).toEqual({
      kind: 'group',
      op: 'and',
      parts: [
        {
          kind: 'group',
          op: 'and',
          parts: [
            { kind: 'condition', field: 'accountType', is: 'individual' },
            { kind: 'group', op: 'or', parts: [{ kind: 'condition', field: 'accountType', is: 'individual' }] },
          ],
        },
      ],
    });
    expect(groupAt(b.tree, b.place).op).toBe('or');
    expect(placeName(b.place)).toBe('1.2');
  });

  it('adds, replaces and removes parts by place without touching the rest', () => {
    const a = addGroup(emptyRule(), [], 'or');
    const withTwo = addCondition(a.tree, a.place);
    const region = { kind: 'condition', field: 'region', test: 'not_in', regions: ['KP'] } as const;
    const set = setCondition(withTwo, [0, 1], { ...region, regions: ['KP'] });
    expect(groupAt(set, [0]).parts[1]).toEqual(region);
    expect(setOp(set, [0], 'and').parts[0]).toMatchObject({ op: 'and' });
    expect(groupAt(removeAt(set, [0, 0]), [0]).parts).toEqual([region]);
    expect(removeAt(set, [])).toBe(set);
    // A place that no longer names a group reads the outer group.
    expect(groupAt(set, [5])).toBe(set);
  });

  it('says each condition in words', () => {
    expect(conditionText({ kind: 'condition', field: 'region', test: 'not_in', regions: ['KP', 'IR'] })).toBe(
      'Region is not one of KP, IR',
    );
    expect(conditionText({ kind: 'condition', field: 'kycTier', atLeast: 'none' })).toBe('Verification is at least not verified');
    expect(conditionText({ kind: 'condition', field: 'status', is: 'active' })).toBe('Account status is active');
  });
});
