import { describe, expect, it } from 'vitest';
import { maskIp } from './request-meta.js';

describe('maskIp', () => {
  it('hides the last part of IPv4, also when it arrives IPv4-mapped', () => {
    expect(maskIp('203.0.113.7')).toBe('203.0.113.x');
    expect(maskIp('::ffff:203.0.113.7')).toBe('203.0.113.x');
  });

  it('shows the first three of eight IPv6 groups and never the last group', () => {
    expect(maskIp('2001:db8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3::x');
    expect(maskIp('2001:db8::1')).toBe('2001:db8:0::x');
    expect(maskIp('::1')).toBe('0:0:0::x');
  });

  it('shows nothing for a blank value or a value that is not an address', () => {
    for (const bad of [null, undefined, '', 'unknown', '999.1.1.1', '1.2.3', 'ffff:::1', '1:2:3:4:5:6:7:8:9']) {
      expect(maskIp(bad)).toBeNull();
    }
  });
});
