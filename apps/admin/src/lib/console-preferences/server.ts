import 'server-only';
import {
  PREFERENCES_STORAGE_UNCONFIGURED,
  SERVER_PREFERENCES,
  preferencesSchema,
  resolvePreferences,
  type EffectivePreferences,
  type Preferences,
  type PreferencesSetInput,
} from '@intafaced/contracts/ops-console-preferences';
import type { OpsRead } from '@/lib/console-announcements/model';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { opsReadOf } from '@/lib/desk/ops-read';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';

export type PreferencesView = OpsRead<Preferences>;

/** In front of every page (the theme and the home link), so bounded like the maintenance-mode read. */
export const PREFERENCES_READ_TIMEOUT_MS = 2_000;

const parse = (raw: unknown): Preferences | null => {
  const parsed = preferencesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** svc-ops `preferences.get` as the signed-in founder. Never throws. */
export async function loadPreferences(ctx: FounderCallContext): Promise<PreferencesView> {
  const result = await founderCall(ctx, 'ops', 'preferences.get', 'GET', undefined, parse, { timeoutMs: PREFERENCES_READ_TIMEOUT_MS });
  return opsReadOf(result, PREFERENCES_STORAGE_UNCONFIGURED, 'preferences');
}

/** The preferences in force: svc-ops' answer, or the server's own when it could not be read. */
export function effectiveOf(view: PreferencesView): EffectivePreferences {
  return view.kind === 'read' ? view.data.effective : resolvePreferences({});
}

export { SERVER_PREFERENCES };

export async function setPreferences(
  ctx: FounderCallContext,
  input: PreferencesSetInput,
): Promise<{ status: number; reply: { ok: true; preferences: Preferences } | ({ ok: false } & RefusalView) }> {
  const result = await founderCall(ctx, 'ops', 'preferences.set', 'POST', input, parse);
  if (result.kind === 'ok') return { status: 200, reply: { ok: true, preferences: result.data } };
  const status =
    result.kind === 'refused' ? result.refusal.status : result.kind === 'forbidden' ? 403 : result.kind === 'not_built' ? 501 : 503;
  const code =
    result.kind === 'refused' ? result.refusal.code : result.kind === 'forbidden' ? (result.refusal.code ?? 'operator.denied') : null;
  const uncertain = result.kind === 'unavailable' ? result.uncertain : result.kind === 'invalid';
  return { status: status >= 400 && status < 600 ? status : 502, reply: { ok: false, ...explainRefusal(code, status, uncertain) } };
}
