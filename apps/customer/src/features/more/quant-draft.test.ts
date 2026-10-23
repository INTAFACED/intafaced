import { describe, expect, it } from 'vitest';
import { emptyDraft, parseDraft, readDraft, writeDraft, type DraftStorage, type StudioDraft } from './quant-draft';

const memory = (initial: Record<string, string> = {}): DraftStorage & { rows: Record<string, string> } => {
  const rows = { ...initial };
  return {
    rows,
    getItem: (key) => rows[key] ?? null,
    setItem: (key, value) => void (rows[key] = value),
    removeItem: (key) => void delete rows[key],
  };
};
const draft: StudioDraft = {
  name: 'Buy the dip',
  cash: '1000',
  blocks: [
    { side: 'buy', symbol: 'BTC-USDT', qty: '0.5' },
    { side: 'sell', symbol: 'ETH-USDT', qty: '2' },
  ],
  modules: null,
  drawdown: '0.1',
  notional: '500',
  kill: '0.2',
};

describe('studio draft on this device', () => {
  it('keeps what was typed and gives it back', () => {
    const storage = memory();
    expect(writeDraft('user-1', draft, storage)).toBe(true);
    expect(readDraft('user-1', storage)).toEqual(draft);
  });
  it('keeps one draft per account, so a shared browser never mixes them', () => {
    const storage = memory();
    writeDraft('user-1', draft, storage);
    expect(readDraft('user-2', storage)).toBeNull();
    expect(readDraft(null, storage)).toBeNull();
  });
  it('clears the stored draft when the form is blank again', () => {
    const storage = memory();
    writeDraft('user-1', draft, storage);
    writeDraft('user-1', emptyDraft(), storage);
    expect(Object.keys(storage.rows)).toEqual([]);
  });
  it('ignores damaged or foreign values instead of filling the form with them', () => {
    expect(parseDraft('not json')).toBeNull();
    expect(parseDraft('[]')).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, blocks: [] }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, blocks: [{ side: 'hold', symbol: 'X', qty: '1' }] }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, cash: 5 }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, name: 'x'.repeat(500) }))).toBeNull();
    expect(parseDraft(null)).toBeNull();
  });
  it('still works when the browser will not remember anything', () => {
    const refusing: DraftStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(writeDraft('user-1', draft, refusing)).toBe(false);
    expect(readDraft('user-1', refusing)).toBeNull();
    expect(writeDraft('user-1', draft, null)).toBe(false);
    expect(readDraft('user-1', null)).toBeNull();
  });

  it('keeps signal rules, reads an older draft without them as blocks, and drops damaged rules', () => {
    const modules = {
      symbol: 'BTC/USDT',
      barSize: '1h' as const,
      signal: { kind: 'ma_cross' as const, average: 'sma' as const, fast: '3', slow: '' },
      sizing: { kind: 'quantity' as const, value: '' },
      exit: { stopLossPercent: '', takeProfitPercent: '' },
    };
    const store = memory();
    writeDraft('user-1', { ...draft, modules }, store);
    expect(readDraft('user-1', store)?.modules).toEqual(modules);
    const { modules: _dropped, ...older } = draft;
    expect(parseDraft(JSON.stringify(older))?.modules).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, modules: { symbol: 'x' } }))?.modules).toBeNull();
  });
});
