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
import type { OpsRead } from '@/lib/console-announcements';
import { opsReadOf, writeRefusalOf, type FounderCallContext, type RefusalView, founderRecordRead } from '@/lib/desk';
import { OPS_PREFERENCES_GET, OPS_PREFERENCES_SET } from '@intafaced/contracts/ops-preferences-procedures';

export type PreferencesView = OpsRead<Preferences>;

/** In front of every page (the theme and the home link), so bounded like the maintenance-mode read. */
export const PREFERENCES_READ_TIMEOUT_MS = 2_000;

const parse = (raw: unknown): Preferences | null => {
  const parsed = preferencesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** svc-ops `preferences.get` as the signed-in founder. Never throws. */
export async function loadPreferences(ctx: FounderCallContext): Promise<PreferencesView> {
  const result = await founderRecordRead(ctx, OPS_PREFERENCES_GET, undefined, parse, { timeoutMs: PREFERENCES_READ_TIMEOUT_MS });
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
  const result = await founderRecordRead(ctx, OPS_PREFERENCES_SET, input, parse);
  if (result.kind === 'ok') return { status: 200, reply: { ok: true, preferences: result.data } };
  return writeRefusalOf(result);
}
