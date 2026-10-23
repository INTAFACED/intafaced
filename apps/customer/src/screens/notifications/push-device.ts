/**
 * This device's side of push (HM-notifications-02): whether the browser can receive push at all, the permission it
 * reports, and the device subscription the push gateway's public key makes. Nothing here runs on page load: the
 * settings page calls it only when the person presses "Allow notifications on this device". The permission is always
 * read from the browser, never stored or assumed.
 */

/** What the browser says about notifications for this site. `unsupported`: it has no push at all. */
export type DevicePermission = 'unsupported' | 'default' | 'granted' | 'denied';

/** The browser globals this needs; tests pass their own. */
export type PushHost = {
  Notification?: { permission: string; requestPermission(): Promise<string> };
  PushManager?: unknown;
  navigator: { serviceWorker?: { register(url: string, options?: { scope?: string }): Promise<PushRegistration> } };
};
type PushRegistration = {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
  };
};
type PushSubscriptionLike = { toJSON(): { endpoint?: string; keys?: Record<string, string> } };

/** The service worker that shows a pushed notice and opens its room when pressed. */
export const PUSH_WORKER = '/push-sw.js';

const asPermission = (value: string): DevicePermission => (value === 'granted' || value === 'denied' ? value : 'default');

export function hasPush(host: PushHost): boolean {
  return Boolean(host.Notification && host.PushManager && host.navigator.serviceWorker);
}

/** The permission as the browser reports it now. */
export function readPermission(host: PushHost): DevicePermission {
  return hasPush(host) && host.Notification ? asPermission(host.Notification.permission) : 'unsupported';
}

/**
 * Ask the browser, only when it has not been answered: a person who said no is never asked again from here (the browser
 * would not show the prompt anyway), and one who said yes is not asked twice.
 */
export async function askPermission(host: PushHost): Promise<DevicePermission> {
  const now = readPermission(host);
  if (now !== 'default' || !host.Notification) return now;
  return asPermission(await host.Notification.requestPermission());
}

/** A URL-safe base64 key (no padding) as the bytes `pushManager.subscribe` takes. */
export function keyBytes(key: string): Uint8Array {
  const base64 = (key + '='.repeat((4 - (key.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/**
 * This device's subscription, as the address the push gateway sends to: its endpoint and keys, as JSON. An existing
 * subscription is reused, so pressing again gives the same address and the service keeps one row for it. The address
 * is a device secret: it goes only to `registerTarget`, and is never shown or logged.
 */
export async function deviceAddress(host: PushHost, publicKey: string): Promise<string> {
  const worker = host.navigator.serviceWorker;
  if (!worker) throw new Error('push unsupported');
  const registration = await worker.register(PUSH_WORKER, { scope: '/' });
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint) throw new Error('push subscription has no endpoint');
  return JSON.stringify({ endpoint, keys: keys ?? {} });
}
