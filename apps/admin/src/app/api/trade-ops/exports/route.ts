import { readRestrictionHistory } from '@/lib/trade-ops/approvals-calls';
import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import {
  exportFilename,
  killSwitchRows,
  orderRows,
  KILL_SWITCH_COLUMNS,
  ORDER_COLUMNS,
  RESTRICTION_COLUMNS,
  EXPORT_DATASETS,
  type ExportDataset,
  type PreparedExport,
} from '@/lib/trade-ops/csv';
import { blocked, ok, refused } from '@/lib/trade-ops/outcome';
import { readKillSwitchSnapshot, readOpenOrders } from '@/lib/trade-ops/reads';
import { historyRows, validateLimit, validateUserId } from '@/lib/trade-ops/restrictions';
import { exportChartFeedControls } from '@/lib/trade-ops/chart-feed-calls';
import { CHART_CONTROL_COLUMNS, chartControlRows } from '@/lib/trade-ops/chart-feed-model';

/**
 * Exports BFF. The browser asks for the rows of one readable dataset and writes the file itself.
 *   POST { action: 'prepare', dataset, includeSeeded?, userId?, day? }   -> Outcome<{ dataset, scope, columns, rows, filename, note }>
 *        chart_controls_audit: every applied chart feed change (svc-trade's journal), optionally one UTC day (YYYY-MM-DD);
 *        svc-trade refuses the whole file over the owner's row limit, naming the limit.
 *   POST { action: 'server_export', dataset: 'fills'|'positions'|'order_history', ... } -> BLOCKED (export_missing)
 * Rows are plain text exactly as the services sent them (decimals untouched); csv.ts does the quoting.
 */
export const dynamic = 'force-dynamic';

const ORDER_CAP = 500;

export const POST = (req: Request) =>
  tradeOpsRoute(req, async (ctx, body) => {
    if (body.action === 'server_export') {
      const kind = body.dataset;
      if (kind !== 'fills' && kind !== 'positions' && kind !== 'order_history')
        return refused('trade_ops.dataset_invalid', 'Choose fills, positions or order history.', 400);
      for (const key of ['from', 'to'] as const) {
        const v = body[key];
        if (v !== undefined && v !== '' && (typeof v !== 'string' || Number.isNaN(Date.parse(v))))
          return refused('trade_ops.date_invalid', `The ${key} date is not a valid date.`, 400);
      }
      if (body.userId !== undefined && body.userId !== '') {
        const u = validateUserId(body.userId);
        if (!u.ok) return refused(u.code, u.message, 400);
      }
      return blocked(BLOCKERS.export_missing);
    }
    if (body.action !== 'prepare') return refused('trade_ops.action_unknown', 'Unknown exports action.', 400);
    const requested = body.dataset;
    if (typeof requested !== 'string' || !(EXPORT_DATASETS as readonly string[]).includes(requested))
      return refused('trade_ops.dataset_invalid', 'Choose one of the readable datasets.', 400);
    const dataset = requested as ExportDataset;

    if (dataset === 'open_orders') {
      const includeSeeded = body.includeSeeded === true;
      const r = await readOpenOrders(ctx, ORDER_CAP);
      if (r.kind !== 'ok') return r;
      const rows = orderRows(r.data, includeSeeded);
      const notes = [
        ...(r.data.length >= ORDER_CAP
          ? [`The service returned the cap of ${ORDER_CAP} orders; there may be more open orders than this file holds.`]
          : []),
        includeSeeded ? 'Seeded (market-maker) rows are included and marked seeded = yes.' : 'Seeded (market-maker) rows are left out.',
      ];
      const scope = includeSeeded ? 'open-orders-with-seeded' : 'open-orders';
      return ok<PreparedExport>({ dataset, scope, columns: ORDER_COLUMNS, rows, filename: exportFilename(scope, r.asOf), notes }, r.asOf);
    }
    if (dataset === 'kill_switch_audit') {
      const r = await readKillSwitchSnapshot();
      if (r.kind !== 'ok') return r;
      return ok<PreparedExport>(
        {
          dataset,
          scope: 'kill-switch-audit',
          columns: KILL_SWITCH_COLUMNS,
          rows: killSwitchRows(r.data.audit),
          filename: exportFilename('kill-switch-audit', r.asOf),
          notes: [],
        },
        r.asOf,
      );
    }
    if (dataset === 'chart_controls_audit') {
      const day = typeof body.day === 'string' ? body.day.trim() : '';
      if (day !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))))
        return refused('trade_ops.date_invalid', 'The day is not a valid date (YYYY-MM-DD).', 400);
      const from = day ? `${day}T00:00:00.000Z` : null;
      const to = day ? new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString() : null;
      const r = await exportChartFeedControls(ctx, { from, to });
      if (r.kind !== 'ok') return r;
      const scope = day ? `chart-controls-audit-${day}` : 'chart-controls-audit';
      return ok<PreparedExport>(
        {
          dataset,
          scope,
          columns: CHART_CONTROL_COLUMNS,
          rows: chartControlRows(r.data.rows),
          filename: exportFilename(scope, r.asOf),
          notes: [
            `Every applied chart feed change${day ? ` on ${day} (UTC)` : ''}, oldest first, with who proposed, approved and applied it. The owner's row limit is ${r.data.rowLimit}.`,
          ],
        },
        r.asOf,
      );
    }
    const user = validateUserId(body.userId);
    if (!user.ok) return refused(user.code, user.message, 400);
    const limit = validateLimit(200);
    if (!limit.ok) return refused(limit.code, limit.message, 400);
    const r = await readRestrictionHistory(ctx, user.value, limit.value);
    if (r.kind !== 'ok') return r;
    const rows = historyRows(r.data).map((h) => [
      h.at,
      h.auditId,
      h.requestId,
      h.userId,
      h.action,
      h.outcome,
      h.code,
      h.actor,
      h.reason,
      h.versionBefore,
      h.versionAfter,
    ]);
    const scope = `restriction-history-${user.value}`;
    return ok<PreparedExport>(
      {
        dataset,
        scope,
        columns: RESTRICTION_COLUMNS,
        rows,
        filename: exportFilename(scope, r.asOf),
        notes: r.data.length >= 200 ? ['The service gave the latest 200 entries; older ones are not in this file.'] : [],
      },
      r.asOf,
    );
  });
