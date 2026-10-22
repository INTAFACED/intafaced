import { afterEach, describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { describeChannelsPolicy, pushPublicKeyOf } from './channels-policy.js';

/**
 * HM-notifications-02: the channels policy read carries the push gateway's
 * PUBLIC application key, or null when it is unset. The gateway token never.
 * Key and token strings here are the test's own.
 */

const KEY = 'BTestPublicApplicationKey-0123456789abcdef';
const TOKEN = 'test-push-gateway-token-must-never-leak-0001';
const saved = { key: process.env.NOTIFY_PUSH_PUBLIC_KEY, token: process.env.NOTIFY_PUSH_GATEWAY_TOKEN };

afterEach(() => {
  if (saved.key === undefined) delete process.env.NOTIFY_PUSH_PUBLIC_KEY;
  else process.env.NOTIFY_PUSH_PUBLIC_KEY = saved.key;
  if (saved.token === undefined) delete process.env.NOTIFY_PUSH_GATEWAY_TOKEN;
  else process.env.NOTIFY_PUSH_GATEWAY_TOKEN = saved.token;
});

describe('channelsPolicy.pushPublicKey', () => {
  it('key unset -> null', () => {
    expect(describeChannelsPolicy({}).pushPublicKey).toBeNull();
    expect(pushPublicKeyOf({ NOTIFY_PUSH_PUBLIC_KEY: '   ' })).toBeNull();
    expect(pushPublicKeyOf({ NOTIFY_PUSH_PUBLIC_KEY: '' })).toBeNull();
  });

  it('key set -> returned; token never present in output', () => {
    process.env.NOTIFY_PUSH_GATEWAY_TOKEN = TOKEN;
    process.env.NOTIFY_PUSH_PUBLIC_KEY = KEY;
    const policy = describeChannelsPolicy();
    expect(policy.pushPublicKey).toBe(KEY);
    const wire = JSON.stringify(policy);
    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toMatch(/NOTIFY_PUSH_GATEWAY_TOKEN|gatewayToken/i);
  });

  it('the public router read carries the key and never the token', async () => {
    process.env.NOTIFY_PUSH_GATEWAY_TOKEN = TOKEN;
    process.env.NOTIFY_PUSH_PUBLIC_KEY = KEY;
    const { createNotifyRouter } = await import('./router.js');
    const edgeContext = createEdgeContext({ secret: 'notify-push-key-test-edge-secret-value', serviceName: 'svc-notify' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon-push-key' });
    const result = await createNotifyRouter({} as never)
      .createCaller(anon)
      .notify.channelsPolicy();
    expect(result.pushPublicKey).toBe(KEY);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
