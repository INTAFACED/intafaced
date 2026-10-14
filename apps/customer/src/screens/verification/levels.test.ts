import { describe, expect, it } from 'vitest';
import { askable, levelState, nextLevel } from './levels';

describe('levelState', () => {
  it('marks the held level current and the ones below it included', () => {
    expect(levelState('full', 'full', [])).toBe('current');
    expect(levelState('full', 'basic', [])).toBe('included');
  });
  it('shows a waiting request as pending and a turned-down one as declined', () => {
    expect(levelState('none', 'basic', [{ tier: 'basic', status: 'pending' }])).toBe('pending');
    expect(levelState('basic', 'full', [{ tier: 'full', status: 'rejected' }])).toBe('declined');
  });
  it('uses the newest record for that level (the list is newest first)', () => {
    const rows = [
      { tier: 'full' as const, status: 'pending' as const },
      { tier: 'full' as const, status: 'rejected' as const },
    ];
    expect(levelState('basic', 'full', rows)).toBe('pending');
  });
  it('ignores expired records and other levels', () => {
    expect(levelState('none', 'basic', [{ tier: 'basic', status: 'expired' }])).toBe('available');
    expect(levelState('none', 'full', [{ tier: 'basic', status: 'pending' }])).toBe('available');
  });
});

describe('nextLevel and askable', () => {
  it('walks the ladder', () => {
    expect(nextLevel('none')).toBe('basic');
    expect(nextLevel('basic')).toBe('full');
    expect(nextLevel('institutional')).toBeNull();
  });
  it('never offers a downgrade or a level already waiting', () => {
    expect(askable('full', [])).toEqual(['institutional']);
    expect(askable('none', [{ tier: 'basic', status: 'pending' }])).toEqual(['full', 'institutional']);
    expect(askable('institutional', [])).toEqual([]);
  });
});
