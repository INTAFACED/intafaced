import { describe, expect, it } from 'vitest';
import { portalCopy } from './copy';
import { w3cCopy } from './w3c-copy';
import { extensionCopy } from './extension-copy';
import { layoutCopy } from './home-layout/copy';
import { moneyCopy } from './money/copy';
import { paymentsCopy } from './payments/copy';
import { settingsCopy } from './settings/copy';

/** Each wording lives in one place. A key in both a shared file and a package file would answer differently by page. */
describe('portal copy ownership', () => {
  const keysOf = (copy: { coverage: (l: 'ar') => { missing: string[] } }) => copy.coverage('ar').missing;
  const shared = new Set([portalCopy, w3cCopy, extensionCopy, layoutCopy].flatMap((c) => keysOf(c as never)));
  it.each([
    ['money', moneyCopy],
    ['payments', paymentsCopy],
    ['settings', settingsCopy],
  ] as const)('keeps %s words out of the shared files', (_name, copy) => {
    expect(keysOf(copy).filter((key) => shared.has(key))).toEqual([]);
  });
  it('gives the three packages different words', () => {
    const a = new Set(keysOf(moneyCopy));
    const b = new Set(keysOf(paymentsCopy));
    const c = new Set(keysOf(settingsCopy));
    expect([...a].filter((k) => b.has(k) || c.has(k))).toEqual([]);
    expect([...b].filter((k) => c.has(k))).toEqual([]);
  });
});
