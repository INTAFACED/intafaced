import { describe, expect, it } from 'vitest';
import { changeHashesEqual, founderChangeHash } from './founder-change-hash.js';

const MID = '22222222-2222-4222-8222-222222222222';
const target = { scope: 'merchant', merchantId: MID, change: { kind: 'set_tier', tierId: 'gold', archetypeId: null } };

describe('founderChangeHash', () => {
  it('has the sha256:<64 hex> shape and does not depend on object key order', () => {
    const a = founderChangeHash(target, '3');
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
    const reordered = { change: { archetypeId: null, tierId: 'gold', kind: 'set_tier' }, merchantId: MID, scope: 'merchant' };
    expect(founderChangeHash(reordered, '3')).toBe(a);
  });

  it('is a fixed value: the hash svc-pay has already stored must not drift', () => {
    expect(founderChangeHash(target, '3')).toBe('sha256:7a68f46d61eaf5cde3ca7830e9e6de917f9c5abd6f43306df4dcff582933760e');
  });

  it('changes with the merchant, the kind, the archetype, any array element and the version', () => {
    const base = founderChangeHash(target, '3');
    const variants = [
      founderChangeHash({ ...target, merchantId: '33333333-3333-4333-8333-333333333333' }, '3'),
      founderChangeHash({ ...target, change: { kind: 'set_tier', tierId: 'gold', archetypeId: 'psp' } }, '3'),
      founderChangeHash({ ...target, change: { kind: 'set_reserve', reserve: { rollingReserveBps: null, holdDays: null } } }, '3'),
      founderChangeHash(target, '4'),
      founderChangeHash({ ...target, change: { kind: 'set_pricing', pricing: [{ a: 1 }] } }, '3'),
      founderChangeHash({ ...target, change: { kind: 'set_pricing', pricing: [{ a: 1 }, { a: 2 }] } }, '3'),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('compares in constant time and treats different lengths as unequal', () => {
    const h = founderChangeHash(target, '3');
    expect(changeHashesEqual(h, h)).toBe(true);
    expect(changeHashesEqual(h, founderChangeHash(target, '4'))).toBe(false);
    expect(changeHashesEqual(h, h.slice(0, -1))).toBe(false);
    expect(changeHashesEqual('', '')).toBe(true);
  });
});
