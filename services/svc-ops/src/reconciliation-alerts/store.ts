import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { ReconciliationEvaluation, ReconciliationEvaluationCursor } from '@intafaced/contracts/ledger-reconciliation';
import {
  OPS_ALERT_REPEAT_UNSET,
  OPS_ALERT_SOURCE_UNAVAILABLE,
  type OpsAlert,
  type OpsAlertCursor,
  type OpsAlertDetail,
  type OpsAlertList,
  type OpsAlertListInput,
  type OpsAlertSnooze,
  type OpsAlertSource,
  type OpsAlertTimelineEntry,
  type OpsReconciliationPeriods,
  type OpsReconciliationPeriodsInput,
} from '@intafaced/contracts/ops-reconciliation-alerts';
import {
  OPS_ALERT_NOT_FOUND,
  OPS_ALERT_SNOOZE_END_INVALID,
  OPS_ALERT_STATE_ILLEGAL,
  OPS_IDEMPOTENCY_CONFLICT,
  OpsError,
} from '../codes.js';
import { failingTargets, repeatNotice, type NoticeOutcome } from './decide.js';

const SOURCE = 'ledger.reconciliation_evaluations';
/** The actor the timeline names for what the feed did; a person is always their own user id. */
export const FEED_ACTOR = 'system:reconciliation-feed';

type Db = Sql | TransactionSql;

interface AlertRow {
  id: string;
  kind: 'reconciliation';
  state: OpsAlert['state'];
  control_id: string;
  asset_id: string | null;
  period_start: Date;
  period_end: Date;
  severity: OpsAlert['severity'];
  occurrences: number;
  first_seen: Date;
  last_seen: Date;
  evidence: OpsAlert['evidence'];
  ack_by: string | null;
  ack_at: Date | null;
  ack_note: string | null;
  notices_sent: number;
  last_notice_at: Date | null;
  version: number;
  snooze_id: string | null;
  snooze_starts_at: Date | null;
  snooze_ends_at: Date | null;
  snooze_by: string | null;
  snooze_reason: string | null;
}

interface SnoozeRow {
  id: string;
  starts_at: Date;
  ends_at: Date;
  snoozed_by: string;
  reason: string | null;
  expired_at: Date | null;
}

const ALERT_COLUMNS = (sql: Db, now: Date) => sql`
  a.id, a.kind, a.state, a.control_id, a.asset_id, a.period_start, a.period_end, a.severity, a.occurrences, a.first_seen,
  a.last_seen, a.evidence, a.ack_by, a.ack_at, a.ack_note, a.notices_sent, a.last_notice_at, a.version,
  s.id AS snooze_id, s.starts_at AS snooze_starts_at, s.ends_at AS snooze_ends_at, s.snoozed_by AS snooze_by,
  s.reason AS snooze_reason
  FROM ops.reconciliation_alerts a
  LEFT JOIN ops.reconciliation_alert_snoozes s
    ON s.alert_id = a.id AND s.expired_at IS NULL AND s.starts_at <= ${now} AND s.ends_at > ${now}
`;

const iso = (date: Date): string => date.toISOString();

export interface ReconciliationAlertStoreOptions {
  /** Owner value: how often a still-failing alert may notify again. Null is blank: nothing is re-sent. */
  readonly repeatSeconds: number | null;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/**
 * The reconciliation alert store (OPS-reconciliation-03). Every write is one transaction; every evaluation is taken once
 * by run id, so reading the feed again from an older cursor changes nothing. No call here holds or moves a balance.
 */
export class ReconciliationAlertStore {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly sql: Sql,
    private readonly options: ReconciliationAlertStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  get repeatSeconds(): number | null {
    return this.options.repeatSeconds;
  }

  async cursor(): Promise<ReconciliationEvaluationCursor | null> {
    const [row] = await this.sql<{ cursor_finished_at: string | null; cursor_run_id: string | null }[]>`
      SELECT cursor_finished_at, cursor_run_id FROM ops.reconciliation_feed WHERE source = ${SOURCE}
    `;
    return row?.cursor_finished_at && row.cursor_run_id ? { finishedAt: row.cursor_finished_at, id: row.cursor_run_id } : null;
  }

  /** A read succeeded: the source is ok and the cursor moves to where the page ended (never backwards). */
  async recordRead(next: ReconciliationEvaluationCursor | null): Promise<void> {
    const at = this.now();
    await this.sql`
      INSERT INTO ops.reconciliation_feed (source, cursor_finished_at, cursor_run_id, last_ok_at, error_message, error_since)
      VALUES (${SOURCE}, ${next?.finishedAt ?? null}, ${next?.id ?? null}, ${at}, NULL, NULL)
      ON CONFLICT (source) DO UPDATE SET
        cursor_finished_at = coalesce(EXCLUDED.cursor_finished_at, ops.reconciliation_feed.cursor_finished_at),
        cursor_run_id = coalesce(EXCLUDED.cursor_run_id, ops.reconciliation_feed.cursor_run_id),
        last_ok_at = EXCLUDED.last_ok_at, error_message = NULL, error_since = NULL
    `;
  }

  /** A read failed: the source is unavailable since the first failure in a row; the cursor stays. */
  async recordFailure(message: string): Promise<void> {
    const at = this.now();
    await this.sql`
      INSERT INTO ops.reconciliation_feed (source, error_message, error_since) VALUES (${SOURCE}, ${message}, ${at})
      ON CONFLICT (source) DO UPDATE SET error_message = EXCLUDED.error_message,
        error_since = coalesce(ops.reconciliation_feed.error_since, EXCLUDED.error_since)
    `;
  }

  async source(db: Db = this.sql): Promise<OpsAlertSource> {
    const [row] = await db<{ last_ok_at: Date | null; error_message: string | null; error_since: Date | null }[]>`
      SELECT last_ok_at, error_message, error_since FROM ops.reconciliation_feed WHERE source = ${SOURCE}
    `;
    if (row?.error_since) {
      return {
        status: 'unavailable',
        code: OPS_ALERT_SOURCE_UNAVAILABLE,
        message: row.error_message ?? '',
        since: iso(row.error_since),
        lastOkAt: row.last_ok_at ? iso(row.last_ok_at) : null,
      };
    }
    return row?.last_ok_at ? { status: 'ok', readAt: iso(row.last_ok_at) } : { status: 'never_read' };
  }

  /**
   * Takes one settled evaluation: counts it against its period, then opens or counts one alert per failing asset. Returns
   * false when the run was already taken.
   */
  async ingest(evaluation: ReconciliationEvaluation): Promise<boolean> {
    const { run } = evaluation;
    if (run.status === 'started') return false;
    return (await this.sql.begin(async (tx) => {
      const now = this.now();
      const taken = await tx`
        INSERT INTO ops.reconciliation_ingested_runs (run_id, ingested_at) VALUES (${run.id}, ${now})
        ON CONFLICT (run_id) DO NOTHING RETURNING run_id
      `;
      if (!taken.length) return false;
      await tx`
        INSERT INTO ops.reconciliation_periods (control_id, period_start, period_end, evaluations, last_run_id, last_status)
        VALUES (${run.controlId}, ${run.periodStart}::text::timestamptz, ${run.periodEnd}::text::timestamptz, 1, ${run.id}, ${run.status})
        ON CONFLICT (control_id, period_start) DO UPDATE SET evaluations = ops.reconciliation_periods.evaluations + 1,
          period_end = EXCLUDED.period_end, last_run_id = EXCLUDED.last_run_id, last_status = EXCLUDED.last_status
      `;
      for (const asset of failingTargets(evaluation)) {
        const assetId = asset?.assetId ?? null;
        const evidence = {
          run: {
            id: run.id,
            status: run.status,
            asOf: run.asOf,
            readAt: run.readAt,
            sources: run.sources,
            outsideSide: run.outsideSide,
            periodStart: run.periodStart,
            periodEnd: run.periodEnd,
          },
          finishedAt: evaluation.finishedAt,
          asset,
        };
        // One live alert per fingerprint; the lock makes two feed readers count a failure once, never open two alerts.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.reconciliation_alert:${run.controlId}:${assetId ?? ''}:${run.periodStart}`}))`;
        const [live] = await tx<{ id: string; last_notice_at: Date | null; snoozed: boolean }[]>`
          SELECT a.id, a.last_notice_at, EXISTS (
            SELECT 1 FROM ops.reconciliation_alert_snoozes s
             WHERE s.alert_id = a.id AND s.expired_at IS NULL AND s.starts_at <= ${now} AND s.ends_at > ${now}
          ) AS snoozed
            FROM ops.reconciliation_alerts a
           WHERE a.kind = 'reconciliation' AND a.control_id = ${run.controlId} AND coalesce(a.asset_id, '') = ${assetId ?? ''}
             AND a.period_start = ${run.periodStart}::text::timestamptz AND a.state IN ('open', 'acknowledged')
           FOR UPDATE OF a
        `;
        if (!live) {
          const id = this.newId();
          await tx`
            INSERT INTO ops.reconciliation_alerts (id, kind, state, control_id, asset_id, period_start, period_end, severity,
              occurrences, first_seen, last_seen, last_run_id, evidence, notices_sent, last_notice_at, version)
            VALUES (${id}, 'reconciliation', 'open', ${run.controlId}, ${assetId}, ${run.periodStart}::text::timestamptz,
              ${run.periodEnd}::text::timestamptz, ${tx.json(evaluation.severity as never)}, 1,
              date_trunc('milliseconds', ${evaluation.finishedAt}::text::timestamptz),
              date_trunc('milliseconds', ${evaluation.finishedAt}::text::timestamptz), ${run.id}, ${tx.json(evidence as never)},
              1, ${now}, 1)
          `;
          await this.timeline(tx, { alertId: id, at: now, kind: 'opened', actor: FEED_ACTOR, runId: run.id, notice: 'sent' });
          continue;
        }
        const notice = repeatNotice({
          repeatSeconds: this.options.repeatSeconds,
          lastNoticeAt: live.last_notice_at,
          now,
          snoozed: live.snoozed,
        });
        const sent = notice === 'sent';
        await tx`
          UPDATE ops.reconciliation_alerts SET occurrences = occurrences + 1,
            last_seen = greatest(last_seen, date_trunc('milliseconds', ${evaluation.finishedAt}::text::timestamptz)),
            last_run_id = ${run.id}, evidence = ${tx.json(evidence as never)}, severity = ${tx.json(evaluation.severity as never)},
            period_end = ${run.periodEnd}::text::timestamptz,
            notices_sent = notices_sent + ${sent ? 1 : 0}, last_notice_at = ${sent ? now : live.last_notice_at},
            version = version + 1
          WHERE id = ${live.id}
        `;
        await this.timeline(tx, { alertId: live.id, at: now, kind: 'repeated', actor: FEED_ACTOR, runId: run.id, notice });
      }
      return true;
    })) as boolean;
  }

  async list(input: OpsAlertListInput): Promise<OpsAlertList> {
    const now = this.now();
    const after = input.after;
    const rows = await this.sql<AlertRow[]>`
      SELECT ${ALERT_COLUMNS(this.sql, now)}
       WHERE (${input.state ?? null}::text IS NULL OR a.state = ${input.state ?? null})
         AND (${after ? after.lastSeen : null}::text IS NULL
              OR (a.last_seen, a.id) < (${after ? after.lastSeen : null}::text::timestamptz, ${after ? after.id : null}::uuid))
       ORDER BY a.last_seen DESC, a.id DESC
       LIMIT ${input.limit + 1}
    `;
    const page = rows.slice(0, input.limit).map((row) => this.view(row));
    const last = page.at(-1);
    const next: OpsAlertCursor | null = rows.length > input.limit && last ? { lastSeen: last.lastSeen, id: last.id } : null;
    return { source: await this.source(), alerts: page, next };
  }

  async get(alertId: string, db: Db = this.sql): Promise<OpsAlertDetail> {
    const now = this.now();
    const [row] = await db<AlertRow[]>`SELECT ${ALERT_COLUMNS(db, now)} WHERE a.id = ${alertId}`;
    if (!row) throw new OpsError(OPS_ALERT_NOT_FOUND, 'No reconciliation alert has this id.');
    const timeline = await db<
      {
        id: string;
        at: Date;
        kind: OpsAlertTimelineEntry['kind'];
        actor: string;
        note: string | null;
        run_id: string | null;
        notice: NoticeOutcome | null;
        snooze_id: string | null;
      }[]
    >`
      SELECT id::text AS id, at, kind, actor, note, run_id, notice, snooze_id FROM ops.reconciliation_alert_timeline
       WHERE alert_id = ${alertId} ORDER BY id ASC
    `;
    const snoozes = await db<SnoozeRow[]>`
      SELECT id, starts_at, ends_at, snoozed_by, reason, expired_at FROM ops.reconciliation_alert_snoozes
       WHERE alert_id = ${alertId} ORDER BY (expired_at IS NULL) DESC, starts_at DESC, expired_at DESC, id DESC
    `;
    return {
      source: await this.source(db),
      alert: this.view(row),
      timeline: timeline.map((entry) => ({
        id: entry.id,
        at: iso(entry.at),
        kind: entry.kind,
        actor: entry.actor,
        note: entry.note,
        runId: entry.run_id,
        notice: entry.notice,
        snoozeId: entry.snooze_id,
      })),
      snoozes: snoozes.map(snoozeView),
    };
  }

  /**
   * One founder takes an open alert. Compare and set on the state: of two at once one wins and the other is refused
   * `ops.alert_state_illegal` with the alert unchanged. The same key from the same founder answers the stored result.
   */
  async acknowledge(input: { alertId: string; actor: string; note: string; key: string }): Promise<OpsAlertDetail> {
    return this.write(input.key, input.alertId, 'acknowledged', input.actor, async (tx, now) => {
      const moved = await tx`
        UPDATE ops.reconciliation_alerts SET state = 'acknowledged', ack_by = ${input.actor}, ack_at = ${now},
          ack_note = ${input.note}, version = version + 1
         WHERE id = ${input.alertId} AND state = 'open' RETURNING id
      `;
      if (!moved.length) {
        const current = await this.get(input.alertId, tx);
        const by = current.alert.acknowledged;
        throw new OpsError(
          OPS_ALERT_STATE_ILLEGAL,
          by
            ? `${by.by} acknowledged this alert at ${by.at}. Nothing was changed.`
            : `This alert is ${current.alert.state}, so it cannot be acknowledged. Nothing was changed.`,
        );
      }
      await this.timeline(tx, {
        alertId: input.alertId,
        at: now,
        kind: 'acknowledged',
        actor: input.actor,
        note: input.note,
        key: input.key,
      });
    });
  }

  /** Mutes notices until `endsAt`; the alert still counts. A new snooze replaces the one in force, which stays readable. */
  async snooze(input: { alertId: string; actor: string; endsAt: string; reason: string | null; key: string }): Promise<OpsAlertDetail> {
    return this.write(input.key, input.alertId, 'snoozed', input.actor, async (tx, now) => {
      const state = await this.liveState(tx, input.alertId);
      if (state !== 'open' && state !== 'acknowledged') {
        throw new OpsError(OPS_ALERT_STATE_ILLEGAL, `This alert is ${state}, so it cannot be snoozed. Nothing was changed.`);
      }
      const endsAt = new Date(input.endsAt);
      if (!(endsAt.getTime() > now.getTime())) {
        throw new OpsError(OPS_ALERT_SNOOZE_END_INVALID, 'A snooze must end after now. Nothing was changed.');
      }
      await tx`UPDATE ops.reconciliation_alert_snoozes SET expired_at = ${now} WHERE alert_id = ${input.alertId} AND expired_at IS NULL`;
      const snoozeId = this.newId();
      await tx`
        INSERT INTO ops.reconciliation_alert_snoozes (id, alert_id, starts_at, ends_at, snoozed_by, reason)
        VALUES (${snoozeId}, ${input.alertId}, ${now}, ${endsAt}, ${input.actor}, ${input.reason})
      `;
      await tx`UPDATE ops.reconciliation_alerts SET version = version + 1 WHERE id = ${input.alertId}`;
      await this.timeline(tx, {
        alertId: input.alertId,
        at: now,
        kind: 'snoozed',
        actor: input.actor,
        note: input.reason,
        snoozeId,
        key: input.key,
      });
    });
  }

  /** Lifts the snooze in force. With none in force it changes nothing and answers the alert as it is. */
  async unsnooze(input: { alertId: string; actor: string; key: string }): Promise<OpsAlertDetail> {
    return this.write(input.key, input.alertId, 'unsnoozed', input.actor, async (tx, now) => {
      await this.liveState(tx, input.alertId);
      const lifted = await tx<{ id: string }[]>`
        UPDATE ops.reconciliation_alert_snoozes SET expired_at = ${now}
         WHERE alert_id = ${input.alertId} AND expired_at IS NULL AND ends_at > ${now} RETURNING id
      `;
      if (!lifted.length) return;
      await tx`UPDATE ops.reconciliation_alerts SET version = version + 1 WHERE id = ${input.alertId}`;
      await this.timeline(tx, {
        alertId: input.alertId,
        at: now,
        kind: 'unsnoozed',
        actor: input.actor,
        snoozeId: lifted[0]!.id,
        key: input.key,
      });
    });
  }

  /** Each evaluated period, newest first. Green only when evaluated and no alert in it is open or acknowledged. */
  async periods(input: OpsReconciliationPeriodsInput): Promise<OpsReconciliationPeriods> {
    const rows = await this.sql<
      {
        control_id: string;
        period_start: Date;
        period_end: Date;
        evaluations: number;
        last_run_id: string;
        last_status: 'PASS' | 'FAIL' | 'ERROR' | 'UNSET';
        open: number;
        acknowledged: number;
      }[]
    >`
      SELECT p.control_id, p.period_start, p.period_end, p.evaluations, p.last_run_id, p.last_status,
        count(a.id) FILTER (WHERE a.state = 'open')::int AS open,
        count(a.id) FILTER (WHERE a.state = 'acknowledged')::int AS acknowledged
        FROM ops.reconciliation_periods p
        LEFT JOIN ops.reconciliation_alerts a ON a.control_id = p.control_id AND a.period_start = p.period_start
       WHERE (${input.controlId ?? null}::uuid IS NULL OR p.control_id = ${input.controlId ?? null}::uuid)
       GROUP BY p.control_id, p.period_start
       ORDER BY p.period_start DESC, p.control_id ASC
       LIMIT ${input.limit}
    `;
    return {
      source: await this.source(),
      periods: rows.map((row) => ({
        controlId: row.control_id,
        periodStart: iso(row.period_start),
        periodEnd: iso(row.period_end),
        evaluations: row.evaluations,
        lastRunId: row.last_run_id,
        lastStatus: row.last_status,
        open: row.open,
        acknowledged: row.acknowledged,
        green: row.last_status === 'PASS' && row.open === 0 && row.acknowledged === 0,
      })),
    };
  }

  private async write(
    key: string,
    alertId: string,
    kind: OpsAlertTimelineEntry['kind'],
    actor: string,
    apply: (tx: TransactionSql, now: Date) => Promise<void>,
  ): Promise<OpsAlertDetail> {
    return (await this.sql.begin(async (tx) => {
      // One key at a time, so a retried request waits for the first and then answers its stored result.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.reconciliation_alert_key:${key}`}))`;
      const [used] = await tx<{ alert_id: string; kind: string; actor: string }[]>`
        SELECT alert_id, kind, actor FROM ops.reconciliation_alert_timeline WHERE idempotency_key = ${key}
      `;
      if (used) {
        if (used.alert_id !== alertId || used.kind !== kind || used.actor !== actor) {
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key already names a different alert action.');
        }
        return this.get(alertId, tx);
      }
      await apply(tx, this.now());
      return this.get(alertId, tx);
    })) as OpsAlertDetail;
  }

  private async liveState(tx: TransactionSql, alertId: string): Promise<OpsAlert['state']> {
    const [row] = await tx<{ state: OpsAlert['state'] }[]>`
      SELECT state FROM ops.reconciliation_alerts WHERE id = ${alertId} FOR UPDATE
    `;
    if (!row) throw new OpsError(OPS_ALERT_NOT_FOUND, 'No reconciliation alert has this id.');
    return row.state;
  }

  private async timeline(
    tx: TransactionSql,
    entry: {
      alertId: string;
      at: Date;
      kind: OpsAlertTimelineEntry['kind'];
      actor: string;
      note?: string | null;
      runId?: string;
      notice?: NoticeOutcome;
      snoozeId?: string;
      key?: string;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO ops.reconciliation_alert_timeline (alert_id, at, kind, actor, note, run_id, notice, snooze_id, idempotency_key)
      VALUES (${entry.alertId}, ${entry.at}, ${entry.kind}, ${entry.actor}, ${entry.note ?? null}, ${entry.runId ?? null},
        ${entry.notice ?? null}, ${entry.snoozeId ?? null}, ${entry.key ?? null})
    `;
  }

  private view(row: AlertRow): OpsAlert {
    const live = row.state === 'open' || row.state === 'acknowledged';
    const seconds = this.options.repeatSeconds;
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      controlId: row.control_id,
      assetId: row.asset_id,
      periodStart: iso(row.period_start),
      periodEnd: iso(row.period_end),
      severity: row.severity,
      occurrences: row.occurrences,
      firstSeen: iso(row.first_seen),
      lastSeen: iso(row.last_seen),
      evidence: row.evidence,
      acknowledged: row.ack_by && row.ack_at && row.ack_note ? { by: row.ack_by, at: iso(row.ack_at), note: row.ack_note } : null,
      snooze:
        row.snooze_id && row.snooze_starts_at && row.snooze_ends_at && row.snooze_by
          ? {
              id: row.snooze_id,
              startsAt: iso(row.snooze_starts_at),
              endsAt: iso(row.snooze_ends_at),
              by: row.snooze_by,
              reason: row.snooze_reason,
              expiredAt: null,
            }
          : null,
      notices: {
        sent: row.notices_sent,
        lastSentAt: row.last_notice_at ? iso(row.last_notice_at) : null,
        repeat:
          seconds === null
            ? { status: 'unset', code: OPS_ALERT_REPEAT_UNSET }
            : {
                status: 'set',
                seconds,
                nextDueAt: live && row.last_notice_at ? iso(new Date(row.last_notice_at.getTime() + seconds * 1000)) : null,
              },
        outside: { email: 'vendor.email', push: 'vendor.push' },
      },
      version: row.version,
    };
  }
}

function snoozeView(row: SnoozeRow): OpsAlertSnooze {
  return {
    id: row.id,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    by: row.snoozed_by,
    reason: row.reason,
    expiredAt: row.expired_at ? iso(row.expired_at) : null,
  };
}
