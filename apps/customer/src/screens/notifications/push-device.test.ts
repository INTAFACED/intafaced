import { describe, expect, it, vi } from 'vitest';
import { askPermission, deviceAddress, hasPush, keyBytes, readPermission, PUSH_WORKER, type PushHost } from './push-device';

function host(permission: string | null, answer = 'granted', existing: object | null = null) {
  const subscribe = vi.fn(async () => ({
    toJSON: () => ({ endpoint: 'https://push.example.test/e/1', keys: { p256dh: 'p', auth: 'a' } }),
  }));
  const getSubscription = vi.fn(async () => (existing ? { toJSON: () => existing } : null));
  const register = vi.fn(async () => ({ pushManager: { getSubscription, subscribe } }));
  const requestPermission = vi.fn(async () => answer);
  const value: PushHost =
    permission === null
      ? { navigator: {} }
      : { Notification: { permission, requestPermission }, PushManager: {}, navigator: { serviceWorker: { register } } };
  return { value, subscribe, getSubscription, register, requestPermission };
}

describe('this device and push (HM-notifications-02)', () => {
  it('reads the permission from the browser, and says when it has no push at all', () => {
    expect(readPermission(host('granted').value)).toBe('granted');
    expect(readPermission(host('denied').value)).toBe('denied');
    expect(readPermission(host('default').value)).toBe('default');
    expect(readPermission(host(null).value)).toBe('unsupported');
    expect(hasPush(host(null).value)).toBe(false);
  });

  it('asks the browser only while the question is unanswered', async () => {
    const fresh = host('default', 'denied');
    expect(await askPermission(fresh.value)).toBe('denied');
    expect(fresh.requestPermission).toHaveBeenCalledTimes(1);
    const refused = host('denied');
    expect(await askPermission(refused.value)).toBe('denied');
    expect(refused.requestPermission).not.toHaveBeenCalled();
    const allowed = host('granted');
    expect(await askPermission(allowed.value)).toBe('granted');
    expect(allowed.requestPermission).not.toHaveBeenCalled();
  });

  it('subscribes with the key once and gives the endpoint and keys as the address', async () => {
    const fresh = host('granted');
    const address = await deviceAddress(
      fresh.value,
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    );
    expect(JSON.parse(address)).toEqual({ endpoint: 'https://push.example.test/e/1', keys: { p256dh: 'p', auth: 'a' } });
    expect(fresh.register).toHaveBeenCalledWith(PUSH_WORKER, { scope: '/' });
    expect(fresh.subscribe).toHaveBeenCalledTimes(1);
  });

  it('reuses this device’s subscription, so pressing again gives the same address', async () => {
    const again = host('granted', 'granted', { endpoint: 'https://push.example.test/e/old', keys: { auth: 'x' } });
    expect(JSON.parse(await deviceAddress(again.value, 'AAAAAAAAAAAAAAAAAAAAAA'))).toEqual({
      endpoint: 'https://push.example.test/e/old',
      keys: { auth: 'x' },
    });
    expect(again.subscribe).not.toHaveBeenCalled();
  });

  it('turns the URL-safe key into its bytes', () => {
    expect(Array.from(keyBytes('AQID_-8'))).toEqual([1, 2, 3, 255, 239]);
  });
});
