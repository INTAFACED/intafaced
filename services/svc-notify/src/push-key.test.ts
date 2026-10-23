import { describe, expect, it } from 'vitest';
import { PUSH_KEY_UNSET, pushKeyPolicy } from './push-key.js';

const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const gateway = { NOTIFY_PUSH_GATEWAY_URL: 'https://push.example.test/send', NOTIFY_PUSH_GATEWAY_TOKEN: 'x'.repeat(16) };

describe('push public key policy (HM-notifications-02)', () => {
  it('gives the key only when the gateway URL and token are set too', () => {
    expect(pushKeyPolicy({ ...gateway, NOTIFY_PUSH_PUBLIC_KEY: KEY })).toEqual({ publicKey: KEY, unsetCode: null });
  });

  it('withholds it, with its code, while any part of push delivery is blank', () => {
    const unset = { publicKey: null, unsetCode: PUSH_KEY_UNSET };
    expect(pushKeyPolicy({})).toEqual(unset);
    expect(pushKeyPolicy({ NOTIFY_PUSH_PUBLIC_KEY: KEY })).toEqual(unset);
    expect(pushKeyPolicy({ ...gateway })).toEqual(unset);
    expect(pushKeyPolicy({ ...gateway, NOTIFY_PUSH_PUBLIC_KEY: '   ' })).toEqual(unset);
    expect(pushKeyPolicy({ ...gateway, NOTIFY_PUSH_GATEWAY_TOKEN: '', NOTIFY_PUSH_PUBLIC_KEY: KEY })).toEqual(unset);
  });

  it('never hands a browser a value that is not a key', () => {
    expect(pushKeyPolicy({ ...gateway, NOTIFY_PUSH_PUBLIC_KEY: 'not a key!' })).toMatchObject({ publicKey: null });
    expect(pushKeyPolicy({ ...gateway, NOTIFY_PUSH_PUBLIC_KEY: 'short' })).toMatchObject({ publicKey: null });
  });
});
