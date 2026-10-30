// hand-declared-ok: svc-identity's handle.get, handle.change and handle.setDiscoverable answers have no schema in packages/contracts.
/**
 * The caller's own handle settings (PP-send-request-03): change the handle under a lifetime cap the owner publishes,
 * and choose whether people can find the account by its handle. svc-identity `handle.get`, `handle.change` and
 * `handle.setDiscoverable`.
 *
 * A blank cap is the owner's setting not yet published: `changeCap` and `changesLeft` are null and every change is
 * refused with `identity.handle_change_cap_unset`. This file never fills in a number.
 */
import { z } from 'zod';
import type { ApiClient } from '../shared/api';

export const handleSettingsSchema = z.object({
  handle: z.string().min(1),
  discoverable: z.boolean(),
  changesUsed: z.number().int().nonnegative(),
  changeCap: z.number().int().positive().nullable(),
  changesLeft: z.number().int().nonnegative().nullable(),
});
export type HandleSettings = z.infer<typeof handleSettingsSchema>;

/** The refusal codes the service sends for a change or a switch, each naming the rule or state that refused it. */
export const HANDLE_CHANGE_CODES = [
  'identity.handle_characters',
  'identity.handle_length',
  'identity.handle_taken',
  'identity.handle_unchanged',
  'identity.handle_changed_elsewhere',
  'identity.handle_change_cap_unset',
  'identity.handle_change_cap_reached',
  'identity.security_locked',
  'identity.delegated_refused',
  'identity.session_not_live',
  'auth.account_frozen',
] as const;
export type HandleChangeCode = (typeof HANDLE_CHANGE_CODES)[number];

export type HandleSettingsOutcome =
  { kind: 'ok'; settings: HandleSettings } | { kind: 'refused'; code: HandleChangeCode } | { kind: 'failed' };

const known = (code: string | undefined): code is HandleChangeCode => (HANDLE_CHANGE_CODES as readonly string[]).includes(code ?? '');

export async function fetchHandleSettings(api: ApiClient, signal?: AbortSignal): Promise<HandleSettingsOutcome> {
  const result = await api.query('identity', 'handle.get', undefined, handleSettingsSchema, { signal });
  return result.ok ? { kind: 'ok', settings: result.data } : { kind: 'failed' };
}

export async function changeHandle(api: ApiClient, input: { handle: string; fromHandle: string }): Promise<HandleSettingsOutcome> {
  const result = await api.mutate('identity', 'handle.change', input, handleSettingsSchema);
  if (result.ok) return { kind: 'ok', settings: result.data };
  return known(result.code) ? { kind: 'refused', code: result.code } : { kind: 'failed' };
}

export async function setHandleDiscoverable(api: ApiClient, discoverable: boolean): Promise<HandleSettingsOutcome> {
  const result = await api.mutate('identity', 'handle.setDiscoverable', { discoverable }, handleSettingsSchema);
  if (result.ok) return { kind: 'ok', settings: result.data };
  return known(result.code) ? { kind: 'refused', code: result.code } : { kind: 'failed' };
}
