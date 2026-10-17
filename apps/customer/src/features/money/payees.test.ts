import { describe, expect, it } from 'vitest';
import {
  filterPayees,
  identityChanged,
  forgetPayee,
  parsePayees,
  readPayees,
  recentHandles,
  rememberPayee,
  type PayeeStorage,
} from './payees';

const owner = 'a779d840-9715-4517-af5d-d9f7195e466a';
const maria = { userId: '11111111-1111-4111-8111-111111111111', handle: 'maria_k' };
const noor = { userId: '22222222-2222-4222-8222-222222222222', handle: 'Noor_9' };
const memory = (): PayeeStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
};

describe('saved recipients on this device', () => {
  it('remembers newest first and never twice', () => {
    const storage = memory();
    rememberPayee(owner, maria, storage);
    rememberPayee(owner, noor, storage);
    expect(rememberPayee(owner, { ...maria, userId: maria.userId.toUpperCase() }, storage).map((row) => row.handle)).toEqual([
      'maria_k',
      'Noor_9',
    ]);
    expect(readPayees(owner, storage)).toHaveLength(2);
  });
  it('keeps each customer’s list apart', () => {
    const storage = memory();
    rememberPayee(owner, maria, storage);
    expect(readPayees('someone-else', storage)).toEqual([]);
  });
  it('never saves yourself or something that is not a person', () => {
    const storage = memory();
    expect(rememberPayee(owner, { userId: owner, handle: 'me_myself' }, storage)).toEqual([]);
    expect(rememberPayee(owner, { userId: 'not-an-id', handle: 'maria_k' }, storage)).toEqual([]);
    expect(rememberPayee(owner, { userId: maria.userId, handle: 'no spaces' }, storage)).toEqual([]);
  });
  it('forgets one person', () => {
    const storage = memory();
    rememberPayee(owner, maria, storage);
    rememberPayee(owner, noor, storage);
    expect(forgetPayee(owner, maria.userId, storage).map((row) => row.handle)).toEqual(['Noor_9']);
  });
  it('ignores damaged storage and a device that cannot remember', () => {
    expect(parsePayees('{oops')).toEqual([]);
    expect(parsePayees(JSON.stringify([{ userId: 5 }, null, maria]))).toEqual([maria]);
    expect(rememberPayee(owner, maria, null)).toEqual([maria]);
    expect(readPayees(owner, null)).toEqual([]);
  });
  it('filters by a typed fragment with or without the at sign', () => {
    expect(filterPayees([maria, noor], '@nOO').map((row) => row.handle)).toEqual(['Noor_9']);
    expect(filterPayees([maria, noor], '').length).toBe(2);
  });
});

describe('recent recipients from activity', () => {
  const row = (handle: string | null, at: string, kind = 'transfer_out') => ({
    kind,
    direction: kind === 'transfer_out' ? 'out' : 'in',
    counterparty: handle ? { handle } : null,
    postedAt: at,
  });
  it('lists people paid, newest first, each once', () => {
    const items = [
      row('maria_k', '2026-10-01T00:00:00Z'),
      row('noor_9', '2026-10-03T00:00:00Z'),
      row('Maria_K', '2026-10-05T00:00:00Z'),
      row('lee_x', '2026-10-06T00:00:00Z', 'transfer_in'),
      row(null, '2026-10-07T00:00:00Z'),
    ];
    expect(recentHandles(items)).toEqual(['Maria_K', 'noor_9']);
  });
  it('stops at the limit', () => {
    const items = ['aaa', 'bbb', 'ccc'].map((handle, i) => row(handle, `2026-10-0${i + 1}T00:00:00Z`));
    expect(recentHandles(items, 2)).toEqual(['ccc', 'bbb']);
  });
});

describe('a saved handle that moved to someone else', () => {
  it('is flagged when the person behind it is different', () => {
    expect(identityChanged(maria, maria.userId.toUpperCase())).toBe(false);
    expect(identityChanged(maria, noor.userId)).toBe(true);
    expect(identityChanged(undefined, noor.userId)).toBe(false);
  });
});
