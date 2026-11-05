import { describe, expect, it } from 'vitest';
import {
  IpMinuteWindow,
  SHARE_SURFACES,
  parseShareTagHitsPerIpMinute,
  parseShareTagKey,
  signShareTag,
  verifyShareTag,
} from './share-tag.js';

const KEY = 'TEST-share-tag-key-0123456789abcdef';
const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('signed share tags (RC-campaigns-06)', () => {
  it('a tag reads back its token and surface under the same key', () => {
    for (const surface of SHARE_SURFACES) {
      const tag = signShareTag(KEY, TOKEN, surface);
      expect(tag.startsWith(`${TOKEN}.${surface}.`)).toBe(true);
      expect(verifyShareTag(KEY, tag)).toEqual({ token: TOKEN, surface });
    }
  });

  it('an edited surface, an edited token, another key and a bad shape are each refused', () => {
    const tag = signShareTag(KEY, TOKEN, 'promotion');
    const [, , sig] = tag.split('.');
    expect(verifyShareTag(KEY, `${TOKEN}.card.${sig}`)).toBeNull();
    expect(verifyShareTag(KEY, `${OTHER_TOKEN}.promotion.${sig}`)).toBeNull();
    expect(verifyShareTag(`${KEY}-other`, tag)).toBeNull();
    expect(verifyShareTag(KEY, `${TOKEN}.promotion`)).toBeNull();
    expect(verifyShareTag(KEY, `${TOKEN}.elsewhere.${sig}`)).toBeNull();
    expect(verifyShareTag(KEY, `${tag}.extra`)).toBeNull();
    // One changed signature character: same length, different bytes.
    const flipped = sig!.slice(0, -2) + (sig!.at(-2) === 'A' ? 'B' : 'A') + sig!.at(-1);
    expect(verifyShareTag(KEY, `${TOKEN}.promotion.${flipped}`)).toBeNull();
  });

  it('a blank key stays blank and a short one stops the service', () => {
    expect(parseShareTagKey(undefined)).toBeUndefined();
    expect(parseShareTagKey('  ')).toBeUndefined();
    expect(() => parseShareTagKey('short')).toThrow(/at least 32/);
    expect(parseShareTagKey(KEY)).toBe(KEY);
  });

  it('a blank visit limit stays blank; a malformed one stops the service', () => {
    expect(parseShareTagHitsPerIpMinute(undefined)).toBeUndefined();
    expect(parseShareTagHitsPerIpMinute('')).toBeUndefined();
    expect(() => parseShareTagHitsPerIpMinute('0')).toThrow();
    expect(() => parseShareTagHitsPerIpMinute('1.5')).toThrow();
    expect(() => parseShareTagHitsPerIpMinute('100001')).toThrow();
    expect(parseShareTagHitsPerIpMinute('600')).toBe(600);
  });

  it('the per-IP window lets the limit through, refuses the next, and opens again the next minute', () => {
    let now = 0;
    const window = new IpMinuteWindow(2, () => now);
    expect(window.take('1.1.1.1')).toBe(true);
    expect(window.take('1.1.1.1')).toBe(true);
    expect(window.take('1.1.1.1')).toBe(false);
    expect(window.take('2.2.2.2')).toBe(true);
    now = 60_000;
    expect(window.take('1.1.1.1')).toBe(true);
  });
});
