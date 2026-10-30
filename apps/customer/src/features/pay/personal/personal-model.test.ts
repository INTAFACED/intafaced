import { describe, expect, it } from 'vitest';
import {
  addRequest,
  applyPrefill,
  cleanAmount,
  cleanNote,
  contactLabel,
  contactsFrom,
  parseRequestLink,
  parseRequestSearch,
  payee,
  readRequests,
  readSent,
  receiptText,
  recordSent,
  removeRequest,
  requestPath,
  type MemoryStorage,
  type SentEntry,
} from './personal-model';

const ID = '1f985d42-852d-4b50-a4d9-bdfa0384027c';
const memory = (): MemoryStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const sent = (over: Partial<SentEntry> = {}): SentEntry => ({
  transferId: 't-0001-aaaa',
  ledgerTxId: 'tx-1',
  toUserId: ID,
  handle: 'maya_test',
  amount: '12.5',
  asset: 'USDT',
  note: null,
  at: '2026-10-17T01:00:00.000Z',
  ...over,
});

describe('cleanAmount and cleanNote', () => {
  it('keeps exact positive decimals and drops everything else', () => {
    expect(cleanAmount('12.50')).toBe('12.50');
    expect(cleanAmount(' 0.000000000000000001 ')).toBe('0.000000000000000001');
    for (const bad of ['0', '0.0', '-1', '1e3', '1,5', '.5', '1.', 'abc', '', null, undefined, '0.0000000000000000001'])
      expect(cleanAmount(bad as string)).toBeNull();
  });
  it('flattens control characters, trims and caps a note', () => {
    expect(cleanNote('  rent\n\tfor  October ')).toBe('rent for October');
    expect(cleanNote('x'.repeat(300))).toHaveLength(140);
    expect(cleanNote('   ')).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
  });
});

describe('payee', () => {
  it('takes a handle with or without @, or an Account ID', () => {
    expect(payee('@maya_test')).toEqual({ to: 'maya_test', kind: 'handle' });
    expect(payee(ID.toUpperCase())).toEqual({ to: ID, kind: 'accountId' });
    for (const bad of ['', 'ab', 'has space', 'a'.repeat(33), '1f985d42-852d', null]) expect(payee(bad as string)).toBeNull();
  });
});

describe('payment links', () => {
  it('round-trips amount, asset and note', () => {
    const path = requestPath({ to: 'maya_test', amount: '5.25', asset: 'usdt', note: 'Lunch & drinks' });
    expect(path).toBe('/pay/send?to=maya_test&amount=5.25&asset=USDT&note=Lunch+%26+drinks');
    expect(parseRequestSearch(path.slice(path.indexOf('?')))).toEqual({
      to: 'maya_test',
      kind: 'handle',
      amount: '5.25',
      asset: 'USDT',
      note: 'Lunch & drinks',
      qr: null,
    });
  });
  it('drops bad optional fields instead of guessing, and refuses a link with no payee', () => {
    expect(parseRequestSearch('?to=maya_test&amount=-3&asset=%3Cb%3E&note=%00')).toEqual({
      to: 'maya_test',
      kind: 'handle',
      amount: null,
      asset: null,
      note: null,
      qr: null,
    });
    expect(parseRequestSearch('?amount=5')).toBeNull();
    expect(parseRequestSearch('?to=not+valid')).toBeNull();
  });
  it('drops an amount that comes without an asset', () => {
    expect(parseRequestSearch('?to=maya_test&amount=5')).toMatchObject({ amount: null, asset: null });
    expect(requestPath({ to: 'maya_test', amount: '5' })).toBe('/pay/send?to=maya_test');
  });
  it('carries a signed pay code last, and drops one with characters a code never has', () => {
    const qr = 'v1.0b5f4c7e-3c2a-4f61-9d3e-7a1b2c3d4e5f.AbCdEfGhIjKlMnOp.Abc_-123';
    const path = requestPath({ to: 'maya_test', note: 'Lunch', qr });
    expect(path).toBe(`/pay/send?to=maya_test&note=Lunch&qr=${qr}`);
    expect(parseRequestSearch(path.slice(path.indexOf('?')))).toMatchObject({ to: 'maya_test', qr });
    expect(parseRequestSearch(`?to=maya_test&qr=${qr}x`)?.qr).toBe(`${qr}x`);
    expect(parseRequestSearch('?to=maya_test&qr=%3Cscript%3E')?.qr).toBeNull();
    expect(parseRequestSearch(`?to=maya_test&qr=${'a'.repeat(201)}`)?.qr).toBeNull();
    expect(requestPath({ to: 'maya_test', qr: 'bad code' })).toBe('/pay/send?to=maya_test');
  });
  it('only reads this app’s own /pay/send links', () => {
    const origin = 'https://app.example.test';
    expect(parseRequestLink(`${origin}/pay/send?to=maya_test&amount=2&asset=USDT`, origin)?.amount).toBe('2');
    expect(parseRequestLink('/pay/send/?to=maya_test', origin)?.to).toBe('maya_test');
    expect(parseRequestLink('https://evil.example/pay/send?to=maya_test', origin)).toBeNull();
    expect(parseRequestLink(`${origin}/pay/receive?to=maya_test`, origin)).toBeNull();
    expect(parseRequestLink('', origin)).toBeNull();
  });
});

describe('sent payments and contacts', () => {
  it('remembers payments newest first and one row per transfer', () => {
    const store = memory();
    recordSent('u1', sent({ transferId: 'a-0000-0001', at: '2026-10-17T01:00:00.000Z' }), store);
    recordSent('u1', sent({ transferId: 'b-0000-0002', at: '2026-10-17T02:00:00.000Z', note: 'rent' }), store);
    recordSent('u1', sent({ transferId: 'a-0000-0001', ledgerTxId: 'tx-again' }), store);
    const rows = readSent('u1', store);
    expect(rows.map((r) => r.transferId)).toEqual(['a-0000-0001', 'b-0000-0002']);
    expect(rows[0]!.ledgerTxId).toBe('tx-again');
    expect(rows[1]!.note).toBe('rent');
    expect(readSent('someone-else', store)).toEqual([]);
  });
  it('survives unreadable storage and rows that do not fit', () => {
    const store = memory();
    store.data.set('intafaced.pay.sent.v1:u1', JSON.stringify([sent(), { transferId: 'x' }, 'text', null, sent({ amount: 'abc' })]));
    expect(readSent('u1', store)).toHaveLength(1);
    store.data.set('intafaced.pay.sent.v1:u1', '{not json');
    expect(readSent('u1', store)).toEqual([]);
    expect(readSent('u1', null)).toEqual([]);
    expect(recordSent('u1', sent(), null)).toBe(false);
    const throwing: MemoryStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSent('u1', throwing)).toEqual([]);
    expect(recordSent('u1', sent(), throwing)).toBe(false);
  });
  it('keeps at most 100 rows', () => {
    const store = memory();
    for (let i = 0; i < 105; i++) recordSent('u1', sent({ transferId: `t-${String(i).padStart(6, '0')}` }), store);
    expect(readSent('u1', store)).toHaveLength(100);
  });
  it('lists each person once, most recent first, with a usable label', () => {
    const other = '2b0f4c1e-2f6d-4a38-9a51-0f8d2a6c7e11';
    const contacts = contactsFrom([
      sent({ transferId: 'a-0000-0001', at: '2026-10-15T00:00:00.000Z', handle: null }),
      sent({ transferId: 'b-0000-0002', at: '2026-10-16T00:00:00.000Z', toUserId: other, handle: null }),
      sent({ transferId: 'c-0000-0003', at: '2026-10-17T00:00:00.000Z' }),
    ]);
    expect(contacts.map((c) => c.userId)).toEqual([ID, other]);
    expect(contacts[0]).toMatchObject({ handle: 'maya_test', times: 2 });
    expect(contactLabel(contacts[0]!)).toBe('@maya_test');
    expect(contactLabel(contacts[1]!)).toBe('2b0f4c1e…');
    expect(contactsFrom([], 6)).toEqual([]);
  });
  it('writes a plain receipt', () => {
    const labels = { title: 'Payment sent', to: 'To', amount: 'Amount', when: 'When', reference: 'Reference', note: 'Note' };
    expect(receiptText(sent({ note: 'rent' }), labels)).toBe(
      'Payment sent\nTo: @maya_test\nAmount: 12.5 USDT\nWhen: 2026-10-17T01:00:00.000Z\nReference: tx-1\nNote: rent',
    );
  });
});

describe('links made on this device', () => {
  const entry = (id: string, to = 'maya_test') => ({
    id,
    path: requestPath({ to, amount: '3', asset: 'USDT' }),
    to,
    amount: '3',
    asset: 'USDT',
    note: null,
    at: '2026-10-17T01:00:00.000Z',
  });
  it('adds, lists and removes', () => {
    const store = memory();
    expect(addRequest('u1', entry('r1'), store)).toBe(true);
    addRequest('u1', entry('r2'), store);
    expect(readRequests('u1', store).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(removeRequest('u1', 'r2', store)).toBe(true);
    expect(readRequests('u1', store).map((r) => r.id)).toEqual(['r1']);
  });
  it('ignores a stored link that is not a /pay/send link', () => {
    const store = memory();
    store.data.set('intafaced.pay.requests.v1:u1', JSON.stringify([{ ...entry('r1'), path: 'https://evil.example/?to=maya_test' }]));
    expect(readRequests('u1', store)).toEqual([]);
  });
});

describe('applyPrefill', () => {
  const sources = [
    { id: 's-usdt', asset: 'USDT', balance: '10' },
    { id: 's-eth', asset: 'ETH', balance: '0.5' },
  ];
  const base = { to: 'maya_test', kind: 'handle' as const, amount: null, asset: null, note: null, qr: null };
  it('chooses the matching asset and keeps an amount that fits', () => {
    expect(applyPrefill({ ...base, amount: '0.25', asset: 'ETH' }, sources)).toEqual({ sourceId: 's-eth', amount: '0.25', problem: null });
  });
  it('never moves a typed amount to another asset', () => {
    expect(applyPrefill({ ...base, amount: '5', asset: 'BTC' }, sources)).toEqual({ sourceId: null, amount: '', problem: 'assetNotHeld' });
  });
  it('drops an amount larger than the balance', () => {
    expect(applyPrefill({ ...base, amount: '11', asset: 'USDT' }, sources)).toEqual({
      sourceId: 's-usdt',
      amount: '',
      problem: 'amountTooLarge',
    });
  });
  it('with no asset, never fills an amount', () => {
    expect(applyPrefill({ ...base, amount: '9.99' }, sources)).toEqual({ sourceId: null, amount: '', problem: null });
    expect(applyPrefill(base, [])).toEqual({ sourceId: null, amount: '', problem: null });
  });
});
