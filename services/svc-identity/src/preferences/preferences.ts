/**
 * Per-user preferences. get and set touch only the caller's row.
 * ifVersion is compare-and-set. A replay of the same client id returns the first result.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
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

export class PreferencesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly current?: { version: number; value: TradeViewsValue | null },
  ) {
    super(message);
    this.name = 'PreferencesError';
  }
}

export type PreferenceView = {
  readonly namespace: typeof TRADE_VIEWS_NAMESPACE;
  readonly version: number;
  readonly value: TradeViewsValue | null;
};

type StoredResult = {
  outcome: 'stored' | 'conflict';
  namespace: typeof TRADE_VIEWS_NAMESPACE;
  version: number;
  value: TradeViewsValue | null;
  code?: typeof PREFERENCES_VERSION_CONFLICT;
};

function callerId(context: Context): string {
  const principal = context.principal;
  if (!principal || context.service !== null || !principal.userId) {
    throw new PreferencesError('A signed-in account is required', 'operator.denied');
  }
  return principal.userId.toLowerCase();
}

function requireNamespace(namespace: string): typeof TRADE_VIEWS_NAMESPACE {
  if (namespace !== TRADE_VIEWS_NAMESPACE) {
    throw new PreferencesError(`${PREFERENCES_NAMESPACE_UNKNOWN}: ${namespace}`, PREFERENCES_NAMESPACE_UNKNOWN);
  }
  return TRADE_VIEWS_NAMESPACE;
}

export async function getPreferences(sql: Sql, context: Context, namespace: string): Promise<PreferenceView> {
  const userId = callerId(context);
  const named = requireNamespace(namespace);
  const [row] = await sql<Array<{ version: string; value: TradeViewsValue }>>`
    SELECT version::text AS version, value FROM user_preferences WHERE user_id = ${userId} AND namespace = ${named}
  `;
  if (!row) return { namespace: named, version: 0, value: null };
  return { namespace: named, version: Number(row.version), value: row.value };
}

function fingerprint(namespace: string, value: TradeViewsValue, ifVersion: number): string {
  return createHash('sha256').update(stableJson({ namespace, value, ifVersion })).digest('hex');
}

export async function setPreferences(
  sql: Sql,
  context: Context,
  input: { namespace: string; value?: unknown; ifVersion: number; clientRequestId: string },
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
  let value: TradeViewsValue;
  try {
    value = parseTradeViews(input.value);
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
    const [current] = await tx<Array<{ version: string; value: TradeViewsValue }>>`
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
