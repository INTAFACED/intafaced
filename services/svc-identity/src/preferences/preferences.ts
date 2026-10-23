/**
 * Per-user preferences. get and set touch only the caller's row.
 * ifVersion is compare-and-set. A replay of the same client id returns the first result.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { ACCOUNT_DISPLAY_NAMESPACE, parseAccountDisplay, type AccountDisplayValue } from './account-display.js';
import { UI_VIEW_NAMESPACE, parseUiView, type UiViewValue } from './ui-view.js';
import { HOME_TILES_NAMESPACE, parseHomeTiles, type HomeTilesValue } from './home-tiles.js';
import {
  CHART_TEMPLATES_NAMESPACE,
  LAYOUTS_NAMESPACE,
  NO_LAYOUT_CAPS,
  layoutsForRead,
  parseChartTemplates,
  parseLayouts,
  type LayoutCaps,
} from './layouts.js';
import type { ChartTemplatesValue, LayoutsValue } from '@intafaced/contracts/layouts-preferences';
import type { SavedScreensValue, WatchlistsValue } from '@intafaced/contracts/watchlists-preferences';
import {
  NO_WATCHLIST_CAPS,
  SAVED_SCREENS_NAMESPACE,
  WATCHLISTS_NAMESPACE,
  parseSavedScreens,
  parseWatchlists,
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

export type PreferenceNamespace =
  | typeof TRADE_VIEWS_NAMESPACE
  | typeof ACCOUNT_DISPLAY_NAMESPACE
  | typeof UI_VIEW_NAMESPACE
  | typeof HOME_TILES_NAMESPACE
  | typeof WATCHLISTS_NAMESPACE
  | typeof SAVED_SCREENS_NAMESPACE
  | typeof LAYOUTS_NAMESPACE
  | typeof CHART_TEMPLATES_NAMESPACE;
export type PreferenceValue =
  | TradeViewsValue
  | AccountDisplayValue
  | UiViewValue
  | HomeTilesValue
  | WatchlistsValue
  | SavedScreensValue
  | LayoutsValue
  | ChartTemplatesValue;

/** Owner-published settings a value is checked against. Blank means nothing is listed. */
export type PreferenceSettings = {
  readonly displayCurrencies: readonly string[];
  /** The watchlist and saved-screen caps. Absent or blank: a write that needs a cap is refused. */
  readonly watchlists?: WatchlistCaps;
  /** The saved-layout and chart-template limits. Absent or blank: a write that needs one is refused. */
  readonly layouts?: LayoutCaps;
};
const NO_SETTINGS: PreferenceSettings = { displayCurrencies: [], watchlists: NO_WATCHLIST_CAPS, layouts: NO_LAYOUT_CAPS };

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
  | { readonly namespace: typeof LAYOUTS_NAMESPACE; readonly version: number; readonly value: LayoutsValue | null }
  | { readonly namespace: typeof CHART_TEMPLATES_NAMESPACE; readonly version: number; readonly value: ChartTemplatesValue | null };

type StoredResult = {
  outcome: 'stored' | 'conflict';
  namespace: PreferenceNamespace;
  version: number;
  value: PreferenceValue | null;
  code?: typeof PREFERENCES_VERSION_CONFLICT;
};

function callerId(context: Context): string {
  const principal = context.principal;
  if (!principal || context.service !== null || !principal.userId) {
    throw new PreferencesError('A signed-in account is required', 'operator.denied');
  }
  return principal.userId.toLowerCase();
}

/** Every namespace the door stores, each with the check that decides what its value may hold. */
const NAMESPACES: Readonly<Record<PreferenceNamespace, (value: unknown, settings: PreferenceSettings) => PreferenceValue>> = {
  [TRADE_VIEWS_NAMESPACE]: (value) => parseTradeViews(value),
  [ACCOUNT_DISPLAY_NAMESPACE]: (value, settings) => parseAccountDisplay(value, settings.displayCurrencies),
  [UI_VIEW_NAMESPACE]: (value) => parseUiView(value),
  [HOME_TILES_NAMESPACE]: (value) => parseHomeTiles(value),
  [WATCHLISTS_NAMESPACE]: (value, settings) => parseWatchlists(value, settings.watchlists),
  [SAVED_SCREENS_NAMESPACE]: (value, settings) => parseSavedScreens(value, settings.watchlists),
  [LAYOUTS_NAMESPACE]: (value, settings) => parseLayouts(value, settings.layouts ?? NO_LAYOUT_CAPS),
  [CHART_TEMPLATES_NAMESPACE]: (value, settings) => parseChartTemplates(value, settings.layouts ?? NO_LAYOUT_CAPS),
};

function requireNamespace(namespace: string): PreferenceNamespace {
  if (!Object.prototype.hasOwnProperty.call(NAMESPACES, namespace)) {
    throw new PreferencesError(`${PREFERENCES_NAMESPACE_UNKNOWN}: ${namespace}`, PREFERENCES_NAMESPACE_UNKNOWN);
  }
  return namespace as PreferenceNamespace;
}

function parseValue(namespace: PreferenceNamespace, value: unknown, settings: PreferenceSettings): PreferenceValue {
  return NAMESPACES[namespace](value, settings);
}

export async function getPreferences(
  sql: Sql,
  context: Context,
  namespace: string,
  settings: PreferenceSettings = NO_SETTINGS,
): Promise<PreferenceView> {
  const userId = callerId(context);
  const named = requireNamespace(namespace);
  const [row] = await sql<Array<{ version: string; value: PreferenceValue }>>`
    SELECT version::text AS version, value FROM user_preferences WHERE user_id = ${userId} AND namespace = ${named}
  `;
  if (!row) return { namespace: named, version: 0, value: null } as PreferenceView;
  // A layout past the owner's restore window is not returned, even before the next write drops it from the record.
  const value =
    named === LAYOUTS_NAMESPACE ? layoutsForRead(row.value as LayoutsValue | null, settings.layouts ?? NO_LAYOUT_CAPS) : row.value;
  return { namespace: named, version: Number(row.version), value } as PreferenceView;
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
    value = parseValue(namespace, input.value, settings);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : PREFERENCES_VALUE_INVALID;
    throw new PreferencesError(code, code);
  }
  const hash = fingerprint(namespace, value, input.ifVersion);
  const stored = await transaction(sql, async (tx) => {
    const [prior] = await tx<Array<{ fingerprint: string; result: StoredResult }>>`
      SELECT fingerprint, result FROM user_preference_receipts
      WHERE user_id = ${userId} AND client_request_id = ${clientRequestId}
      FOR UPDATE
    `;
    if (prior) {
      if (prior.fingerprint !== hash) {
        throw new PreferencesError(PREFERENCES_IDEMPOTENCY_CONFLICT, PREFERENCES_IDEMPOTENCY_CONFLICT);
      }
      return prior.result;
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
    } else if (!current) {
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
      if (!updated[0]) {
        result = {
          outcome: 'conflict',
          code: PREFERENCES_VERSION_CONFLICT,
          namespace,
          version: currentVersion,
          value: currentValue,
        };
      } else {
        result = { outcome: 'stored', namespace, version: next, value };
      }
    }
    await tx`
      INSERT INTO user_preference_receipts (user_id, client_request_id, fingerprint, result)
      VALUES (${userId}, ${clientRequestId}, ${hash}, ${tx.json(result as never)})
    `;
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
