import { describe, expect, it } from 'vitest';
import { createClientIpResolver } from './client-ip.js';

describe('trusted edge client IP boundary', () => {
  it('ignores spoofed dedicated headers from direct and untrusted socket peers', () => {
    const resolve = createClientIpResolver('10.0.0.0/8');
    expect(resolve('203.0.113.5', '198.51.100.1')).toBe('203.0.113.5');
    expect(resolve('203.0.113.5', 'malformed')).toBe('203.0.113.5');
    expect(resolve('203.0.113.5', ['198.51.100.1'])).toBe('203.0.113.5');
  });
  it('uses a validated dedicated client IP only from configured trusted IPv4 and IPv6 peers', () => {
    const resolve = createClientIpResolver('10.0.0.0/8, 2001:db8:1::/48');
    expect(resolve('10.2.3.4', '198.51.100.1')).toBe('198.51.100.1');
    expect(resolve('2001:db8:1::abc', '2001:0db8:2:0:0:0:0:1')).toBe('2001:db8:2::1');
    expect(resolve('2001:db8:2::abc', '198.51.100.1')).toBe('2001:db8:2::abc');
    expect(resolve('10.2.3.4', undefined)).toBe('10.2.3.4');
  });
  it('matches mapped IPv6 peers to IPv4 CIDRs and canonicalizes equivalent client addresses', () => {
    const resolve = createClientIpResolver('10.0.0.0/8');
    expect(resolve('::ffff:10.2.3.4', '::ffff:198.51.100.1')).toBe('198.51.100.1');
    expect(resolve('::ffff:a02:304', '::ffff:c633:6401')).toBe('198.51.100.1');
    expect(resolve('::ffff:203.0.113.5', '198.51.100.1')).toBe('203.0.113.5');
    expect(createClientIpResolver('::ffff:10.0.0.0/104')('10.2.3.4', '198.51.100.1')).toBe('198.51.100.1');
  });
  it('missing proxy configuration retains the safe shared-peer budget', () => {
    for (const config of [undefined, '', '  ']) {
      expect(createClientIpResolver(config)('10.2.3.4', '198.51.100.1')).toBe('10.2.3.4');
    }
  });
  it('malformed CIDR configuration refuses without exposing supplied addresses', () => {
    for (const config of [
      '10.0.0.1',
      '10.0.0.1/33',
      '::1/129',
      'bad/24',
      '10.0.0.0/-1',
      '10.0.0.0/08',
      '10.0.0.0/8,',
      'fe80::1%en0/64',
      '10.0.0.0/8/24',
    ]) {
      expect(() => createClientIpResolver(config)).toThrow('ops.crm.proxy_configuration_invalid');
    }
  });
  it('malformed trusted forwarding or missing peer refuses instead of admitting an invented IP', () => {
    const resolve = createClientIpResolver('10.0.0.0/8');
    for (const header of ['198.51.100.1, 192.0.2.1', 'not-an-IP', ' 198.51.100.1', 'fe80::1%en0', ['198.51.100.1']]) {
      expect(() => resolve('10.2.3.4', header)).toThrow('ops.crm.client_ip_invalid');
    }
    expect(() => resolve(undefined, '198.51.100.1')).toThrow('ops.crm.client_ip_unavailable');
    expect(() => resolve('invalid', '198.51.100.1')).toThrow('ops.crm.client_ip_unavailable');
  });
});
