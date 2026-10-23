/**
 * The push gateway's public application key, for the customer app's "Allow notifications on this device" step
 * (HM-notifications-02). A browser needs it to create a device subscription. It is public by design: the matching private
 * key stays with the gateway and never reaches this service.
 *
 * Blank means the owner has not configured push delivery: the key is withheld unless the gateway URL and token are set
 * too, because a device registered with no gateway behind it could never be reached. The app then shows the permission
 * state and the `vendor.push` notice instead of registering.
 */
export const PUSH_KEY_UNSET = 'notify.push_key_unset' as const;

/** URL-safe base64 (no padding), the form browsers take for an application server key. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

export type PushKeyPolicy = { publicKey: string; unsetCode: null } | { publicKey: null; unsetCode: typeof PUSH_KEY_UNSET };

export function pushKeyPolicy(env: Record<string, string | undefined>): PushKeyPolicy {
  const key = env.NOTIFY_PUSH_PUBLIC_KEY?.trim();
  const gateway = Boolean(env.NOTIFY_PUSH_GATEWAY_URL?.trim() && env.NOTIFY_PUSH_GATEWAY_TOKEN?.trim());
  if (!key || !gateway || !KEY_SHAPE.test(key)) return { publicKey: null, unsetCode: PUSH_KEY_UNSET };
  return { publicKey: key, unsetCode: null };
}
