/**
 * Keeps the interface language on the account (`account.display`, written by svc-identity under I-account-lifecycle-01) and this
 * device's copy together, the way `view-sync.ts` does for the view record.
 *
 * Signed out, the choice lives in this browser only and nothing is sent. After sign-in the account's language wins over the device
 * copy; a change made here is written once (compare-and-set on the version read) and a second device shows it after its next
 * sign-in. A refused or unsent write leaves the device copy as it is and reports `not-saved`. An account with no language chosen
 * changes nothing on this device, and the display currency the account holds is sent back as it was read.
 */
// hand-declared-ok: svc-identity declares the account.display answer in its router, and packages/contracts has no browser-safe schema for it
import { z } from 'zod';
import type { ApiClient, ApiResult } from './api';
import { canonicalUiLocale, type UiLocale } from './locale';
import type { ViewSyncStatus } from './view-sync';

export const ACCOUNT_DISPLAY_NAMESPACE = 'account.display' as const;

const displaySchema = z
  .object({
    namespace: z.literal(ACCOUNT_DISPLAY_NAMESPACE),
    version: z.number().int(),
    value: z.object({ locale: z.string().nullable(), displayCurrency: z.string().nullable() }).strict().nullable(),
  })
  .strict();
const storedSchema = displaySchema.extend({ outcome: z.literal('stored') });
type Stored = z.infer<typeof displaySchema>['value'];

/** One id per (person, version read): a retry after a lost reply returns the first result, a write after another device's uses a new id. */
export function accountDisplayRequestId(userId: string, ifVersion: number): string {
  return `account-display:${userId.toLowerCase()}:${ifVersion}`;
}

const CONFLICTS = ['preferences.version_conflict', 'identity.preferences_idempotency_conflict'] as const;
function isConflict(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  return (
    result.status === 409 || result.code === 'CONFLICT' || CONFLICTS.some((code) => result.code === code || result.message.includes(code))
  );
}

export type LanguageSync = {
  pull: (signal?: AbortSignal) => Promise<ViewSyncStatus>;
  push: (signal?: AbortSignal) => Promise<ViewSyncStatus>;
};

export function createLanguageSync(options: {
  api: () => ApiClient;
  userId: string;
  /** The language this device shows now. */
  local: () => UiLocale;
  /** Put the account's language into the device copy without writing it back. */
  applyRemote: (language: UiLocale) => void;
}): LanguageSync {
  const { userId, local, applyRemote } = options;
  let loaded = false;
  let version = 0;
  let record: Stored = null;
  let agreed: UiLocale = local();

  async function read(signal?: AbortSignal): Promise<boolean> {
    const result = await options
      .api()
      .query('identity', 'preferences.get', { namespace: ACCOUNT_DISPLAY_NAMESPACE }, displaySchema, { signal });
    if (!result.ok) return false;
    version = result.data.version;
    record = result.data.value;
    loaded = true;
    return true;
  }

  async function pull(signal?: AbortSignal): Promise<ViewSyncStatus> {
    const asked = local();
    if (!(await read(signal)) || signal?.aborted) return 'not-saved';
    const during = local();
    const remote = canonicalUiLocale(record?.locale);
    if (remote) applyRemote(remote);
    agreed = local();
    // A choice made while the read was out, with nothing on the account to overrule it, stays unagreed so the next push sends it.
    if (!remote && during !== asked) agreed = asked;
    return 'synced';
  }

  async function push(signal?: AbortSignal): Promise<ViewSyncStatus> {
    if (!loaded && !(await read(signal))) return 'not-saved';
    for (let attempt = 0; attempt < 2; attempt++) {
      const language = local();
      if (language === agreed) return 'synced';
      const result = await options.api().mutate(
        'identity',
        'preferences.set',
        {
          namespace: ACCOUNT_DISPLAY_NAMESPACE,
          value: { locale: language, displayCurrency: record?.displayCurrency ?? null },
          ifVersion: version,
          clientRequestId: accountDisplayRequestId(userId, version),
        },
        storedSchema,
        { signal },
      );
      if (result.ok) {
        version = result.data.version;
        record = result.data.value;
        agreed = language;
        return 'synced';
      }
      // Another device wrote first: read its record and send this device's language on top of it.
      if (!isConflict(result) || !(await read(signal))) return 'not-saved';
    }
    return 'not-saved';
  }

  /** One call at a time, so a second change is sent with the version the first write returned. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial =
    <A extends unknown[]>(run: (...args: A) => Promise<ViewSyncStatus>) =>
    (...args: A): Promise<ViewSyncStatus> => {
      const next = queue.then(() => run(...args));
      queue = next.catch(() => undefined);
      return next;
    };
  return { pull: serial(pull), push: serial(push) };
}
