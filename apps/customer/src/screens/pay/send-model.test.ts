import { describe, expect, it } from 'vitest';
import { checkAmount, parseAccountId, rememberRecipient, sentBefore, sourcesFrom, type SpaceRow } from './send-model';

const ID = '1F985D42-852D-4B50-A4D9-BDFA0384027C';
const space = (over: Partial<SpaceRow>): SpaceRow => ({
  id: 's1',
  assetId: 'USDT',
  kind: 'primary',
  name: 'Main',
  lockedUntil: null,
  balance: '10',
  ...over,
});

describe('parseAccountId', () => {
  it('accepts an account ID with stray spaces and lowers it', () => expect(parseAccountId(` ${ID} `)).toBe(ID.toLowerCase()));
  it('refuses anything else', () => {
    for (const bad of ['', 'abc', '@luffy', ID.slice(1), `${ID}0`, '1f985d42852d4b50a4d9bdfa0384027c'])
      expect(parseAccountId(bad)).toBeNull();
  });
});

describe('sourcesFrom', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  it('lists only held assets with something to send', () => {
    const rows = sourcesFrom(
      [
        space({ id: 'a', assetId: 'BTC', balance: '0' }),
        space({ id: 'b', assetId: 'ETH', balance: '0.5' }),
        space({ id: 'c', assetId: 'USDT' }),
      ],
      now,
    );
    expect(rows.map((row) => row.asset)).toEqual(['USDT', 'ETH']);
  });
  it('drops a time-locked space until the lock ends, and a balance that is not a number', () => {
    const rows = sourcesFrom(
      [
        space({ id: 'a', lockedUntil: '2026-10-15T00:00:00Z' }),
        space({ id: 'b', assetId: 'ETH', lockedUntil: '2026-10-13T00:00:00Z' }),
        space({ id: 'c', assetId: 'SOL', balance: 'x' }),
      ],
      now,
    );
    expect(rows.map((row) => row.id)).toEqual(['b']);
  });
  it('puts the main space first and names a named one', () => {
    const rows = sourcesFrom([space({ id: 'n', kind: 'named', name: 'Holiday' }), space({ id: 'p', assetId: 'USDT' })], now);
    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ['p', null],
      ['n', 'Holiday'],
    ]);
  });
});

describe('checkAmount', () => {
  const source = { balance: '12.5' };
  it('empty, zero, ok, exceeds', () => {
    expect(checkAmount('', source).kind).toBe('empty');
    expect(checkAmount('.', source).kind).toBe('empty');
    expect(checkAmount('0', source).kind).toBe('zero');
    expect(checkAmount('0.000', source).kind).toBe('zero');
    expect(checkAmount('12.5', source).kind).toBe('ok');
    expect(checkAmount('12.500000000000000001', source).kind).toBe('exceeds');
    expect(checkAmount('1', null).kind).toBe('empty');
  });
  it('compares exactly where a float would be wrong', () => {
    expect(checkAmount('0.30000000000000001', { balance: '0.3' }).kind).toBe('exceeds');
    expect(checkAmount('0.1', { balance: '0.1' }).kind).toBe('ok');
  });
});

describe('recipient memory', () => {
  const fake = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
  };
  it('remembers who this device has paid, per signed-in user', () => {
    const storage = fake();
    expect(sentBefore('me', ID, storage)).toBe(false);
    rememberRecipient('me', ID, storage);
    expect(sentBefore('me', ID, storage)).toBe(true);
    expect(sentBefore('me', ID.toLowerCase(), storage)).toBe(true);
    expect(sentBefore('someone-else', ID, storage)).toBe(false);
  });
  it('treats unreadable memory as "never sent", so the warning shows', () => {
    const storage = fake({ 'intafaced.pay.recipients.v1:me': '{bad' });
    expect(sentBefore('me', ID, storage)).toBe(false);
    rememberRecipient('me', ID, storage);
    expect(sentBefore('me', ID, storage)).toBe(true);
  });
  it('a device with no storage always shows the warning and never throws', () => {
    expect(sentBefore('me', ID, null)).toBe(false);
    expect(() => rememberRecipient('me', ID, null)).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(sentBefore('me', ID, broken)).toBe(false);
    expect(() => rememberRecipient('me', ID, broken)).not.toThrow();
  });
  it('keeps the 50 most recent', () => {
    const storage = fake();
    for (let i = 0; i < 60; i++) rememberRecipient('me', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, storage);
    expect(JSON.parse(storage.data.get('intafaced.pay.recipients.v1:me')!)).toHaveLength(50);
  });
});
