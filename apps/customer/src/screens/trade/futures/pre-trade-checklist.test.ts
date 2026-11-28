import { describe, expect, it } from 'vitest';
import { NO_CHECKLIST, firstUnticked, holdsOrder, readChecklist, saveChecklist } from './pre-trade-checklist';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const OWNER = '0xAbC0000000000000000000000000000000000001';

describe('the pre-trade checklist', () => {
  it('keeps three items per wallet and reads them back', () => {
    const s = memory();
    expect(readChecklist(s, OWNER)).toEqual(NO_CHECKLIST);
    const saved = saveChecklist(s, OWNER, { on: true, items: [' Trend agrees ', 'Stop is set', '', 'Size from risk'] });
    expect(saved).toEqual({ ok: true, checklist: { on: true, items: ['Trend agrees', 'Stop is set', 'Size from risk'] } });
    expect(readChecklist(s, OWNER.toLowerCase())).toEqual({ on: true, items: ['Trend agrees', 'Stop is set', 'Size from risk'] });
    expect(readChecklist(s, '0x0000000000000000000000000000000000000002')).toEqual(NO_CHECKLIST);
  });
  it('refuses to turn on with no item, and reads a broken or hand-edited value as no checklist', () => {
    const s = memory();
    expect(saveChecklist(s, OWNER, { on: true, items: ['', '  '] })).toEqual({ ok: false, reason: 'no_items' });
    s.setItem(`if.venue.checklist.${OWNER.toLowerCase()}`, '{bad');
    expect(readChecklist(s, OWNER)).toEqual(NO_CHECKLIST);
    s.setItem(`if.venue.checklist.${OWNER.toLowerCase()}`, JSON.stringify({ on: true, items: [] }));
    expect(readChecklist(s, OWNER)).toEqual({ on: false, items: [] });
    expect(saveChecklist(null, OWNER, { on: true, items: ['a'] })).toEqual({ ok: false, reason: 'not_kept' });
  });
  it('holds only an opening order, while it is on', () => {
    const on = { on: true, items: ['a', 'b', 'c'] };
    expect(holdsOrder(on, { reduceOnly: false })).toBe(true);
    expect(holdsOrder(on, { reduceOnly: true })).toBe(false);
    expect(holdsOrder({ ...on, on: false }, { reduceOnly: false })).toBe(false);
  });
  it('names the first item not ticked', () => {
    const on = { on: true, items: ['a', 'b', 'c'] };
    expect(firstUnticked(on, new Set([0, 1]))).toBe('c');
    expect(firstUnticked(on, new Set([0, 2]))).toBe('b');
    expect(firstUnticked(on, new Set([0, 1, 2]))).toBeNull();
  });
});
