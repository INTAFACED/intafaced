import { describe, expect, it } from 'vitest';
import { urlForLog } from './env.js';

// Stand-in credentials only; none of these is a real host or key.
describe('urlForLog keeps scheme and host, and drops every credential-bearing part', () => {
  it('drops userinfo, path and query', () => {
    const out = urlForLog('nats://TEST-USER:TEST-PASS-91ab@bus.test:4222/x?token=TEST-TOKEN-55');
    expect(out).toBe('nats://bus.test:4222');
  });
  it('drops an API key in the path', () => {
    expect(urlForLog('https://rpc.test/v2/TEST-KEY-0f3c')).toBe('https://rpc.test');
  });
  it('handles a comma-separated server list', () => {
    expect(urlForLog('nats://a:TEST-PASS@one.test:4222,nats://two.test:4222')).toBe('nats://one.test:4222,nats://two.test:4222');
  });
  it('never echoes an unparseable value, and returns null when unset', () => {
    expect(urlForLog('TEST-NOT-A-URL-secret')).not.toContain('TEST-NOT-A-URL-secret');
    expect(urlForLog(undefined)).toBeNull();
    expect(urlForLog('  ')).toBeNull();
  });
});
