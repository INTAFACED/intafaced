/**
 * Keeps the account's `ui.view` record and this device's view copy together.
 *
 * The device copy (`shared/preferences.ts`) is what the first paint reads. After sign-in the account record is read and wins
 * over the device copy. A change made here is written to the account (`preferences.set`, compare-and-set on the version read)
 * and only the fields this device changed are sent, so a second device's other choices are never overwritten with a stale copy.
 * A refused or offline write leaves the device copy as it is and reports `not-saved`. Nothing here carries a default: an empty
 * account record changes nothing on this device.
 */
import { UI_VIEW_NAMESPACE, uiViewPreferenceSchema, uiViewRequestId, type UiViewValue } from '@intafaced/contracts/ui-view-preferences';
import { z } from 'zod';
import type { ApiClient, ApiResult } from './api';
import type { Preferences } from './preferences';

const storedSchema = uiViewPreferenceSchema.extend({ outcome: z.literal('stored') });

export type ViewSyncStatus = 'idle' | 'synced' | 'not-saved';

type SyncedFields = 'layoutMode' | 'hideBalances' | 'displayCurrency' | 'theme';
const SYNCED: readonly SyncedFields[] = ['layoutMode', 'hideBalances', 'displayCurrency', 'theme'];
type Fields = Pick<Preferences, SyncedFields>;

/** The four fields of the device copy that live on the account. */
export function accountFields(preferences: Preferences): Fields {
  return {
    layoutMode: preferences.layoutMode,
    hideBalances: preferences.hideBalances,
    displayCurrency: preferences.displayCurrency,
    theme: preferences.theme,
  };
}

const CONFLICTS = ['preferences.version_conflict', 'identity.preferences_idempotency_conflict'] as const;
/** Another device wrote first (or a write at this version was already stored with other contents): read again, then write once more. */
function isConflict(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  return (
    result.status === 409 || result.code === 'CONFLICT' || CONFLICTS.some((code) => result.code === code || result.message.includes(code))
  );
}

export type ViewSync = {
  /** Read the account record and apply it to this device. */
  pull: (signal?: AbortSignal) => Promise<ViewSyncStatus>;
  /** Write what this device changed since the last read or write. */
  push: (signal?: AbortSignal) => Promise<ViewSyncStatus>;
};

export function createViewSync(options: {
  /** The client now: its token changes when the session refreshes, so it is asked for on every call. */
  api: () => ApiClient;
  userId: string;
  /** The device copy now. */
  local: () => Preferences;
  /** Put account values into the device copy without writing them back. */
  applyRemote: (patch: Partial<Fields>) => void;
}): ViewSync {
  const { userId, local, applyRemote } = options;
  let loaded = false;
  let version = 0;
  let record: UiViewValue = {};
  /** What this device showed when it last read the account or wrote to it: a field is "changed" when it differs from this. */
  let agreed: Fields = accountFields(local());

  async function read(signal?: AbortSignal): Promise<boolean> {
    const result = await options
      .api()
      .query('identity', 'preferences.get', { namespace: UI_VIEW_NAMESPACE }, uiViewPreferenceSchema, { signal });
    if (!result.ok) return false;
    version = result.data.version;
    record = result.data.value ?? {};
    loaded = true;
    return true;
  }

  function adopt(): void {
    const patch: Partial<Fields> = {};
    for (const field of SYNCED) {
      const value = record[field];
      if (value !== undefined) (patch as Record<string, unknown>)[field] = value;
    }
    if (Object.keys(patch).length) applyRemote(patch);
    agreed = accountFields(local());
  }

  async function pull(signal?: AbortSignal): Promise<ViewSyncStatus> {
    if (!(await read(signal))) return 'not-saved';
    adopt();
    return 'synced';
  }

  function changed(): Partial<Fields> {
    const now = accountFields(local());
    const patch: Partial<Fields> = {};
    for (const field of SYNCED) if (now[field] !== agreed[field]) (patch as Record<string, unknown>)[field] = now[field];
    return patch;
  }

  async function push(signal?: AbortSignal): Promise<ViewSyncStatus> {
    if (!loaded && !(await read(signal))) return 'not-saved';
    for (let attempt = 0; attempt < 2; attempt++) {
      const patch = changed();
      if (Object.keys(patch).length === 0) return 'synced';
      const result = await options.api().mutate(
        'identity',
        'preferences.set',
        {
          namespace: UI_VIEW_NAMESPACE,
          value: { ...record, ...patch },
          ifVersion: version,
          clientRequestId: uiViewRequestId(userId, version),
        },
        storedSchema,
        { signal },
      );
      if (result.ok) {
        version = result.data.version;
        record = result.data.value ?? {};
        agreed = { ...agreed, ...patch };
        return 'synced';
      }
      // Read the other device's record and send this device's change on top of it. The device copy is not touched.
      if (!isConflict(result) || !(await read(signal))) return 'not-saved';
    }
    return 'not-saved';
  }

  /** One call at a time: a second change waits for the first write, so it is sent with the version that write returned. */
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
