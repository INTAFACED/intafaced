import { describe, expect, it } from 'vitest';
import { emptySignalRules } from './signal-rules';
import { fingerprint, newLink, parseLink, readLink, saveKey, writeLink } from './studio-save';

const rules = {
  name: 'alpha',
  cash: '1000',
  blocks: [{ side: 'buy' as const, symbol: 'BTC/USDT', qty: '0.1' }],
  modules: null,
  risk: { maxDrawdown: '10', maxNotional: '500', kill: '5' },
};

describe('studio save keys', () => {
  it('keys the first save by the draft and later saves by the version they start from', () => {
    const link = newLink('draft-1');
    expect(saveKey(link)).toBe('studio.save:draft-1');
    expect(saveKey({ ...link, strategyId: 'studio_1', version: 1, saved: 'x' })).toBe('studio.update:studio_1:from-v1');
    expect(saveKey({ ...link, strategyId: 'studio_1', version: 2, saved: 'x' })).toBe('studio.update:studio_1:from-v2');
  });

  it('gives the same fingerprint for the same rules, whitespace aside, and a new one for a change', () => {
    expect(fingerprint(rules)).toBe(fingerprint({ ...rules, name: ' alpha ' }));
    expect(fingerprint(rules)).not.toBe(fingerprint({ ...rules, cash: '1001' }));
    const signal = { ...rules, modules: { ...emptySignalRules(), symbol: 'BTC/USDT' } };
    // A strategy of signal rules is its rules: the hidden block rows do not change it, and a rule change does.
    expect(fingerprint(signal)).toBe(fingerprint({ ...signal, blocks: [] }));
    expect(fingerprint(signal)).not.toBe(fingerprint({ ...signal, modules: { ...signal.modules, barSize: '4h' } }));
  });

  it('reads back what it wrote, and a damaged value starts a fresh draft link', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const link = { clientStrategyId: 'draft-2', strategyId: 'studio_2', version: 3, saved: fingerprint(rules) };
    writeLink('owner', link, storage);
    expect(readLink('owner', storage)).toEqual(link);
    expect(readLink('someone-else', storage).clientStrategyId).not.toBe('draft-2');
    expect(parseLink('{not json')).toBeNull();
    expect(parseLink(JSON.stringify({ clientStrategyId: 'd', strategyId: 'studio_3' }))).toEqual(newLink('d'));
  });
});
