/**
 * Per-user preferences. get and set touch only the caller's row.
 * ifVersion is compare-and-set. A replay of the same client id returns the first result. Setting the value the record
 * already holds, at its current version, is stored as it stands: nothing is written, the version stays, and no receipt is kept.
 *
 * A receipt keeps only what a replay needs: the outcome and the version (the value of a replayed set is the value the request
 * carried, which the fingerprint already matched). Receipts older than RECEIPT_RETENTION_DAYS are pruned on the account's next
 * write. A replay past that window is a stale version, so it is a conflict, never a second write.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { ACCOUNT_DISPLAY_NAMESPACE, parseAccountDisplay, type AccountDisplayValue } from './account-display.js';
import { UI_VIEW_NAMESPACE, parseUiView, type UiViewValue } from './ui-view.js';
import { HOME_TILES_NAMESPACE, parseHomeTiles, type HomeTilesValue } from './home-tiles.js';
import {
  ADDRESS_WATCHES_NAMESPACE,
  TOKEN_WATCHLIST_NAMESPACE,
  parseAddressWatches,
  parseTokenWatchlist,
  type AddressWatchesValue,
  type TokenWatchlistValue,
} from './protocol-watches.js';
import type { SavedScreensValue, WatchlistsValue } from '@intafaced/contracts/watchlists-preferences';
import {
  NO_WATCHLIST_CAPS,
  SAVED_SCREENS_NAMESPACE,
  WATCHLISTS_NAMESPACE,
  checkSavedScreenGrowth,
  checkWatchlistGrowth,
  parseSavedScreensShape,
  parseWatchlistsShape,
  type WatchlistCaps,
} from './watchlists.js';
import {
  PREFERENCES_CLIENT_ID_UNSET,
  PREFERENCES_IDEMPOTENCY_CONFLICT,
  PREFERENCES_NAMESPACE_UNKNOWN,
  PREFERENCES_VALUE_INVALID,
  PREFERENCES_VERSION_CONFLICT,
  PREFERENCES_VERSION_UNSET,
  TRADE_VIEWS_NAMESPACE,
  parseTradeViews,
  stableJson,
  type TradeViewsValue,
} from './trade-views.js';

/** How long a receipt is kept. Writes from the account prune the older ones. */
export const RECEIPT_RETENTION_DAYS = 30;

export type PreferenceNamespace =
  | typeof TRADE_VIEWS_NAMESPACE
  | typeof ACCOUNT_DISPLAY_NAMESPACE
  | typeof UI_VIEW_NAMESPACE
  | typeof HOME_TILES_NAMESPACE
  | typeof WATCHLISTS_NAMESPACE
  | typeof SAVED_SCREENS_NAMESPACE
  | typeof TOKEN_WATCHLIST_NAMESPACE
  | typeof ADDRESS_WATCHES_NAMESPACE;
export type PreferenceValue =
  | TradeViewsValue
  | AccountDisplayValue
  | UiViewValue
  | HomeTilesValue
  | WatchlistsValue
  | SavedScreensValue
  | TokenWatchlistValue
  | AddressWatchesValue;

/** Owner-published settings a value is checked against. Blank means nothing is listed. */
export type PreferenceSettings = {
  readonly displayCurrencies: readonly string[];
  /** The watchlist and saved-screen caps. Absent or blank: a write that grows a count past its cap is refused. */
  readonly watchlists?: WatchlistCaps;
};
const NO_SETTINGS: PreferenceSettings = { displayCurrencies: [], watchlists: NO_WATCHLIST_CAPS };

export class PreferencesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly current?: { version: number; value: PreferenceValue | null },
  ) {
    super(message);
    this.name = 'PreferencesError';
  }
}

/** Each namespace carries its own value shape. */
export type PreferenceView =
  | { readonly namespace: typeof TRADE_VIEWS_NAMESPACE; readonly version: number; readonly value: TradeViewsValue | null }
  | { readonly namespace: typeof ACCOUNT_DISPLAY_NAMESPACE; readonly version: number; readonly value: AccountDisplayValue | null }
  | { readonly namespace: typeof UI_VIEW_NAMESPACE; readonly version: number; readonly value: UiViewValue | null }
  | { readonly namespace: typeof HOME_TILES_NAMESPACE; readonly version: number; readonly value: HomeTilesValue | null }
  | { readonly namespace: typeof WATCHLISTS_NAMESPACE; readonly version: number; readonly value: WatchlistsValue | null }
  | { readonly namespace: typeof SAVED_SCREENS_NAMESPACE; readonly version: number; readonly value: SavedScreensValue | null }
  | { readonly namespace: typeof TOKEN_WATCHLIST_NAMESPACE; readonly version: number; readonly value: TokenWatchlistValue | null }
  | { readonly namespace: typeof ADDRESS_WATCHES_NAMESPACE; readonly version: number; readonly value: AddressWatchesValue | null };

type StoredResult = {
  outcome: 'stored' | 'conflict';
  namespace: PreferenceNamespace;
  version: number;
  value: PreferenceValue | null;
  code?: typeof PREFERENCES_VERSION_CONFLICT;
};

/** What a receipt keeps: enough to replay the outcome, no record. */
type ReceiptResult = { outcome: 'stored' | 'conflict'; version: number };

function callerId(context: Context): string {
  const principal = context.principal;
  if (!principal || context.service !== null || !principal.userId) {
    throw new PreferencesError('A signed-in account is required', 'operator.denied');
  }
  return principal.userId.toLowerCase();
}

interface Namespace {
  /** The value's shape. A value that is not the shape is refused before anything is read or stored. */
  shape: (value: unknown, settings: PreferenceSettings) => PreferenceValue;
  /** Refuses a write that grows a count past an owner cap, measured against the stored record. Absent for shape-only namespaces. */
  growth?: (next: PreferenceValue, stored: PreferenceValue | null, settings: PreferenceSettings) => void;
}

/** Every namespace the door stores, each with the check that decides what its value may hold. */
const NAMESPACES: Readonly<Record<PreferenceNamespace, Namespace>> = {
  [TRADE_VIEWS_NAMESPACE]: { shape: (value) => parseTradeViews(value) },
  [ACCOUNT_DISPLAY_NAMESPACE]: { shape: (value, settings) => parseAccountDisplay(value, settings.displayCurrencies) },
  [UI_VIEW_NAMESPACE]: { shape: (value) => parseUiView(value) },
  [HOME_TILES_NAMESPACE]: { shape: (value) => parseHomeTiles(value) },
  [WATCHLISTS_NAMESPACE]: {
    shape: (value) => parseWatchlistsShape(value),
    growth: (next, stored, settings) =>
      checkWatchlistGrowth(next as WatchlistsValue, stored as WatchlistsValue | null, settings.watchlists ?? NO_WATCHLIST_CAPS),
  },
  [SAVED_SCREENS_NAMESPACE]: {
    shape: (value) => parseSavedScreensShape(value),
    growth: (next, stored, settings) =>
      checkSavedScreenGrowth(next as SavedScreensValue, stored as SavedScreensValue | null, settings.watchlists ?? NO_WATCHLIST_CAPS),
  },
  [TOKEN_WATCHLIST_NAMESPACE]: { shape: (value) => parseTokenWatchlist(value) },
  [ADDRESS_WATCHES_NAMESPACE]: { shape: (value) => parseAddressWatches(value) },
};

function requireNamespace(namespace: string): PreferenceNamespace {
  if (!Object.prototype.hasOwnProperty.call(NAMESPACES, namespace)) {
    throw new PreferencesError(`${PREFERENCES_NAMESPACE_UNKNOWN}: ${namespace}`, PREFERENCES_NAMESPACE_UNKNOWN);
  }
  return namespace as PreferenceNamespace;
}

/** A check's refusal, with the code it carries (or the invalid-value code when it carries none). */
function refusedAs(err: unknown): PreferencesError {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : PREFERENCES_VALUE_INVALID;
  return new PreferencesError(code, code);
}

export async function getPreferences(sql: Sql, context: Context, namespace: string): Promise<PreferenceView> {
  const userId = callerId(context);
  const named = requireNamespace(namespace);
  const [row] = await sql<Array<{ version: string; value: PreferenceValue }>>`
    SELECT version::text AS version, value FROM user_preferences WHERE user_id = ${userId} AND namespace = ${named}
  `;
  if (!row) return { namespace: named, version: 0, value: null } as PreferenceView;
  return { namespace: named, version: Number(row.version), value: row.value } as PreferenceView;
}

function fingerprint(namespace: string, value: PreferenceValue, ifVersion: number): string {
  return createHash('sha256').update(stableJson({ namespace, value, ifVersion })).digest('hex');
}

export async function setPreferences(
  sql: Sql,
  context: Context,
  input: { namespace: string; value?: unknown; ifVersion: number; clientRequestId: string },
  settings: PreferenceSettings = NO_SETTINGS,
): Promise<StoredResult> {
  const userId = callerId(context);
  const namespace = requireNamespace(input.namespace);
  const clientRequestId = input.clientRequestId.trim();
  if (clientRequestId.length < 1 || clientRequestId.length > 200) {
    throw new PreferencesError(PREFERENCES_CLIENT_ID_UNSET, PREFERENCES_CLIENT_ID_UNSET);
  }
  if (!Number.isSafeInteger(input.ifVersion) || input.ifVersion < 0) {
    throw new PreferencesError(PREFERENCES_VERSION_UNSET, PREFERENCES_VERSION_UNSET);
  }
  let value: PreferenceValue;
  try {
    value = NAMESPACES[namespace].shape(input.value, settings);
  } catch (err) {
    throw refusedAs(err);
  }
  const hash = fingerprint(namespace, value, input.ifVersion);
  const stored = await transaction(sql, async (tx) => {
    await tx`
      DELETE FROM user_preference_receipts
      WHERE user_id = ${userId} AND created_at < now() - make_interval(days => ${RECEIPT_RETENTION_DAYS}::int)
    `;
    const [prior] = await tx<Array<{ fingerprint: string; result: ReceiptResult }>>`
      SELECT fingerprint, result FROM user_preference_receipts
      WHERE user_id = ${userId} AND client_request_id = ${clientRequestId}
      FOR UPDATE
    `;
    if (prior) {
      if (prior.fingerprint !== hash) {
        throw new PreferencesError(PREFERENCES_IDEMPOTENCY_CONFLICT, PREFERENCES_IDEMPOTENCY_CONFLICT);
      }
      if (prior.result.outcome === 'stored') return { outcome: 'stored', namespace, version: prior.result.version, value } as StoredResult;
      // A replayed conflict answers with the record as it stands now, which is what the caller needs to rebase.
      const [now] = await tx<Array<{ version: string; value: PreferenceValue }>>`
        SELECT version::text AS version, value FROM user_preferences WHERE user_id = ${userId} AND namespace = ${namespace}
      `;
      return {
        outcome: 'conflict',
        code: PREFERENCES_VERSION_CONFLICT,
        namespace,
        version: now ? Number(now.version) : 0,
        value: now?.value ?? null,
      } as StoredResult;
    }
    const [current] = await tx<Array<{ version: string; value: PreferenceValue }>>`
      SELECT version::text AS version, value FROM user_preferences
      WHERE user_id = ${userId} AND namespace = ${namespace}
      FOR UPDATE
    `;
    const currentVersion = current ? Number(current.version) : 0;
    const currentValue = current?.value ?? null;
    let result: StoredResult;
    if (currentVersion !== input.ifVersion) {
      result = {
        outcome: 'conflict',
        code: PREFERENCES_VERSION_CONFLICT,
        namespace,
        version: currentVersion,
        value: currentValue,
      };
    } else if (current && stableJson(value) === stableJson(currentValue)) {
      // Saving what the record already holds changes nothing: no write, the record keeps its version, and no receipt is
      // kept, so a client whose request id names only the version it read can still send its next change under that id.
      // Sending this request again is the same no-op, or a conflict once the record has moved on.
      return { outcome: 'stored', namespace, version: currentVersion, value: currentValue } as StoredResult;
    } else {
      // A refusal here stores no receipt, so the same request can be sent again once the cap allows it.
      try {
        NAMESPACES[namespace].growth?.(value, currentValue, settings);
      } catch (err) {
        throw refusedAs(err);
      }
      if (!current) {
        const inserted = await tx<Array<{ version: string }>>`
          INSERT INTO user_preferences (user_id, namespace, value, version)
          VALUES (${userId}, ${namespace}, ${tx.json(value as never)}, 1)
          ON CONFLICT (user_id, namespace) DO NOTHING
          RETURNING version::text AS version
        `;
        result = inserted[0]
          ? { outcome: 'stored', namespace, version: 1, value }
          : { outcome: 'conflict', code: PREFERENCES_VERSION_CONFLICT, namespace, version: currentVersion, value: currentValue };
      } else {
        const next = currentVersion + 1;
        const updated = await tx<Array<{ version: string }>>`
          UPDATE user_preferences
          SET value = ${tx.json(value as never)}, version = ${next}, updated_at = now()
          WHERE user_id = ${userId} AND namespace = ${namespace} AND version = ${currentVersion}
          RETURNING version::text AS version
        `;
        result = updated[0]
          ? { outcome: 'stored', namespace, version: next, value }
          : { outcome: 'conflict', code: PREFERENCES_VERSION_CONFLICT, namespace, version: currentVersion, value: currentValue };
      }
    }
    const receipt: ReceiptResult = { outcome: result.outcome, version: result.version };
    const kept = await tx<Array<{ client_request_id: string }>>`
      INSERT INTO user_preference_receipts (user_id, client_request_id, fingerprint, result)
      VALUES (${userId}, ${clientRequestId}, ${hash}, ${tx.json(receipt as never)})
      ON CONFLICT (user_id, client_request_id) DO NOTHING
      RETURNING client_request_id
    `;
    if (kept.length === 0) {
      // An identical request committed first (this transaction's snapshot predates it). A serialization failure makes the
      // transaction run again on a fresh snapshot, and that run replays the first request's receipt.
      throw Object.assign(new Error('receipt written by a concurrent request'), { code: '40001' });
    }
    return result;
  });
  if (stored.outcome === 'conflict') {
    throw new PreferencesError(PREFERENCES_VERSION_CONFLICT, PREFERENCES_VERSION_CONFLICT, {
      version: stored.version,
      value: stored.value,
    });
  }
  return stored;
}
