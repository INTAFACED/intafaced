/**
 * Operator and caller session lists.
 *
 * Spend is the sum of sealed `usage_windows.charged_amount`, grouped by the
 * asset recorded on the row (`charged_asset`). A window sealed before that
 * column existed is labelled with the service fee asset — the only asset this
 * runtime posts — and is never repriced from token rates. A session with no
 * sealed window has spend null and reason `no_settled_window`.
 */

import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { AgentError } from '../errors.js';

export type SessionSpendLine = { readonly assetId: string; readonly amount: string };

export type SessionListRow = {
  readonly id: string;
  readonly agentId: string;
  readonly userId: string;
  readonly status: 'open' | 'closed';
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly actionCount: number;
  readonly spend: readonly SessionSpendLine[] | null;
  readonly spendReason: 'no_settled_window' | null;
};

export type SessionListPage = {
  readonly items: readonly SessionListRow[];
  readonly nextCursor: string | null;
};

export type ListSessionsInput = {
  /** When set, the list is only this user's rows. Customer door always sets it. */
  readonly userId?: string | null;
  readonly agentId?: string | null;
  readonly status?: 'open' | 'closed' | null;
  readonly from?: Date | null;
  readonly to?: Date | null;
  readonly limit: number;
  readonly cursor?: string | null;
  /** Used only when a sealed window has no stored asset. Blank then refuses. */
  readonly feeAssetId: string;
};

type SessionSql = {
  id: string;
  user_id: string;
  agent_id: string;
  status: 'open' | 'closed';
  opened_at: Date;
  /** Microseconds since epoch, as text. The list cursor uses this, not the JS Date. */
  opened_us: string;
  closed_at: Date | null;
  action_count: number;
};

type WindowSql = {
  session_id: string;
  charged_amount: string | null;
  charged_asset: string | null;
  sealed_at: Date | null;
};

function refuseCursor(): never {
  throw new AgentError('session list cursor is not valid', 'agents.cursor_invalid', 'agents.refused.cursor_invalid');
}

function encodeCursor(openedUs: string, id: string): string {
  return Buffer.from(`${openedUs}\n${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { us: string; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    refuseCursor();
  }
  const nl = raw.indexOf('\n');
  if (nl < 1) refuseCursor();
  const us = raw.slice(0, nl);
  const id = raw.slice(nl + 1);
  if (!/^[0-9]{1,20}$/.test(us) || !/^[0-9a-f-]{36}$/i.test(id)) refuseCursor();
  return { us, id };
}

function spendOf(windows: readonly WindowSql[], feeAssetId: string): Pick<SessionListRow, 'spend' | 'spendReason'> {
  const sealed = windows.filter((w) => w.sealed_at !== null && w.charged_amount !== null);
  if (sealed.length === 0) return { spend: null, spendReason: 'no_settled_window' };
  const byAsset = new Map<string, bigint>();
  for (const window of sealed) {
    const stored = window.charged_asset?.trim() ?? '';
    const assetId = stored.length > 0 ? stored : feeAssetId.trim();
    if (assetId.length === 0) {
      throw new AgentError(
        'AGENTS_FEE_ASSET_ID is unset — a sealed window has no stored asset',
        'agents.fee_asset_unset',
        'agents.refused.fee_asset_unset',
      );
    }
    const amount = parseAmount(window.charged_amount ?? '0');
    byAsset.set(assetId, (byAsset.get(assetId) ?? 0n) + amount);
  }
  const spend = [...byAsset.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([assetId, amount]) => ({ assetId, amount: formatAmount(amount) }));
  return { spend, spendReason: null };
}

export async function listSessions(sql: Sql, input: ListSessionsInput): Promise<SessionListPage> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const cursorUs = cursor?.us ?? null;
  const cursorId = cursor?.id ?? null;
  const userId = input.userId ?? null;
  const agentId = input.agentId ?? null;
  const status = input.status ?? null;
  const from = input.from ?? null;
  const to = input.to ?? null;

  const rows = await sql<SessionSql[]>`
    SELECT s.id,
           s.user_id,
           s.agent_id,
           s.status,
           s.opened_at,
           (extract(epoch from s.opened_at) * 1000000)::bigint::text AS opened_us,
           s.closed_at,
           (SELECT count(*)::int FROM agents.agent_actions a WHERE a.session_id = s.id) AS action_count
      FROM agents.agent_sessions s
     WHERE (${cursorUs}::text IS NULL
            OR (s.opened_at, s.id) < (
                 timestamptz 'epoch' + ${cursorUs}::bigint * interval '1 microsecond',
                 ${cursorId}::uuid
               ))
       AND (${userId}::text IS NULL OR s.user_id = ${userId})
       AND (${agentId}::text IS NULL OR s.agent_id = ${agentId})
       AND (${status}::text IS NULL OR s.status = ${status}::agents.session_status)
       AND (${from}::timestamptz IS NULL OR s.opened_at >= ${from}::timestamptz)
       AND (${to}::timestamptz IS NULL OR s.opened_at <= ${to}::timestamptz)
     ORDER BY s.opened_at DESC, s.id DESC
     LIMIT ${input.limit + 1}
  `;

  const page = rows.slice(0, input.limit);
  const ids = page.map((row) => row.id);
  const windows =
    ids.length === 0
      ? []
      : await sql<WindowSql[]>`
          SELECT session_id, charged_amount::text AS charged_amount, charged_asset, sealed_at
            FROM agents.usage_windows
           WHERE session_id IN ${sql(ids)}
        `;
  const bySession = new Map<string, WindowSql[]>();
  for (const window of windows) {
    const list = bySession.get(window.session_id) ?? [];
    list.push(window);
    bySession.set(window.session_id, list);
  }

  const items = page.map((row) => {
    const spend = spendOf(bySession.get(row.id) ?? [], input.feeAssetId);
    return {
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id,
      status: row.status,
      openedAt: row.opened_at.toISOString(),
      closedAt: row.closed_at ? row.closed_at.toISOString() : null,
      actionCount: row.action_count,
      spend: spend.spend,
      spendReason: spend.spendReason,
    };
  });

  const last = page[page.length - 1];
  const nextCursor = rows.length > input.limit && last ? encodeCursor(last.opened_us, last.id) : null;
  return { items, nextCursor };
}
