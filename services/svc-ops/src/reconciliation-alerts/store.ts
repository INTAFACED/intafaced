import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { ReconciliationEvaluation, ReconciliationEvaluationCursor } from '@intafaced/contracts/ledger-reconciliation';
import {
  OPS_ALERT_ACCEPT_ACTION,
  OPS_ALERT_REPEAT_UNSET,
  OPS_ALERT_SOURCE_UNAVAILABLE,
  OPS_RESOLVE_LEDGER_UNAVAILABLE,
  OPS_RESOLVE_NOTE_REQUIRED,
  OPS_RESOLVE_TRANSACTION_NOT_FOUND,
  opsAlertAcceptFields,
  opsAlertEvidenceCanonical,
  type OpsAlert,
  type OpsAlertCursor,
  type OpsAlertDetail,
  type OpsAlertList,
  type OpsAlertListInput,
  type OpsAlertSnooze,
  type OpsAlertSource,
  type OpsAlertTimelineEntry,
  type OpsPlatformIncident,
  type OpsReconciliationPeriods,
  type OpsReconciliationPeriodsInput,
} from '@intafaced/contracts/ops-reconciliation-alerts';
import {
  OPS_ALERT_NOT_FOUND,
  OPS_ALERT_SNOOZE_END_INVALID,
  OPS_ALERT_STATE_ILLEGAL,
  OPS_APPROVAL_NOT_FOUNDERS,
  OPS_IDEMPOTENCY_CONFLICT,
  OpsError,
} from '../codes.js';
import { consumeFounderApproval, type ApprovalConsumer } from '../operator-desks.js';
import { alertTargets, repeatNotice, sameFrozenFigures, type AlertTarget, type NoticeOutcome } from './decide.js';
import { queueAlertEvent } from './events.js';
import type { CorrectiveTxPort } from './transactions-client.js';

const SOURCE = 'ledger.reconciliation_evaluations';
/** The actor the timeline names for what the feed did; a person is always their own user id. */
export const FEED_ACTOR = 'system:reconciliation-feed';
/** The actor for what the evaluator decided on its own: a reopen and an automatic resolve. The events say `auto` too. */
export const AUTO_ACTOR = 'auto';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The hash an acceptance freezes: SHA-256 (hex) of the evidence as the contract orders it. */
export const evidenceHash = (evidence: unknown): string => sha256(opsAlertEvidenceCanonical(evidence));
const LIVE = ['open', 'acknowledged'] as const;

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
  cause: OpsAlert['cause'];
  error_code: string | null;
  error_phase: string | null;
  resolution: 'fixed' | 'auto' | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  corrective_tx_ids: string[];
  passing_run_id: string | null;
  resolve_note: string | null;
  accepted_requested_by: string | null;
  accepted_approved_by: string | null;
  accepted_at: Date | null;
  accepted_note: string | null;
  accepted_evidence_hash: string | null;
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
  a.cause, a.error_code, a.error_phase, a.resolution, a.resolved_by, a.resolved_at, a.corrective_tx_ids::text[] AS corrective_tx_ids,
  a.passing_run_id, a.resolve_note, a.accepted_requested_by, a.accepted_approved_by, a.accepted_at, a.accepted_note,
  a.accepted_evidence_hash, s.id AS snooze_id, s.starts_at AS snooze_starts_at, s.ends_at AS snooze_ends_at, s.snoozed_by AS snooze_by,
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
  /** identity's approval consumer; without it an acceptance refuses `action_approval.identity_unwired`. */
  readonly approvals?: ApprovalConsumer;
  /** The ledger's `transactionsExist` door; without it a fix refuses `ops.resolve_ledger_unavailable`. */
  readonly correctiveTx?: CorrectiveTxPort;
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
   * Takes one settled evaluation: counts it against its period, then for each alert it raises (a failing asset to
   * finance, a run that could not finish to the platform team) counts the live alert, reopens a resolved one, leaves an
   * accepted one with the same figures frozen, or opens a new one. A passing run resolves every live alert of its control
   * and period automatically. Returns false when the run was already taken.
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
      if (run.status === 'PASS') {
        await this.autoResolve(tx, evaluation, now);
        return true;
      }
      for (const target of alertTargets(evaluation)) await this.raise(tx, evaluation, target, now);
      return true;
    })) as boolean;
  }

  /** A passing run resolves each live alert of its control and period, FAIL and ERROR alike, naming the run. */
  private async autoResolve(tx: TransactionSql, evaluation: ReconciliationEvaluation, now: Date): Promise<void> {
    const { run } = evaluation;
    const resolved = await tx<{ id: string; version: number }[]>`
      UPDATE ops.reconciliation_alerts SET state = 'resolved', resolution = 'auto', resolved_by = ${AUTO_ACTOR},
        resolved_at = ${now}, passing_run_id = ${run.id}, version = version + 1
       WHERE control_id = ${run.controlId} AND period_start = ${run.periodStart}::text::timestamptz
         AND state IN ('open', 'acknowledged')
      RETURNING id, version
    `;
    for (const alert of resolved) {
      await this.endSnooze(tx, alert.id, now);
      await this.timeline(tx, { alertId: alert.id, at: now, kind: 'resolved', actor: AUTO_ACTOR, runId: run.id });
      await queueAlertEvent(
        tx,
        'coreOpsReconciliationAlertResolved',
        {
          alertId: alert.id,
          sequence: alert.version,
          resolution: 'auto',
          correctiveTxIds: [],
          passingRunId: run.id,
          actor: AUTO_ACTOR,
          resolvedAt: iso(now),
        },
        now,
      );
    }
  }

  private async raise(tx: TransactionSql, evaluation: ReconciliationEvaluation, target: AlertTarget, now: Date): Promise<void> {
    const { run } = evaluation;
    const asset = target.asset;
    const assetId = asset?.assetId ?? null;
    const errorCode = target.cause === 'error' ? target.errorCode : null;
    const errorPhase = target.cause === 'error' ? target.phase : null;
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
    const finishedAt = evaluation.finishedAt;
    // One live alert per fingerprint; the lock makes two feed readers count a failure once, never open two alerts.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.reconciliation_alert:${run.controlId}:${target.cause}:${assetId ?? ''}:${run.periodStart}`}))`;
    // The newest alert of this fingerprint, whatever its state.
    const [latest] = await tx<{ id: string; state: OpsAlert['state']; last_notice_at: Date | null; snoozed: boolean }[]>`
      SELECT a.id, a.state, a.last_notice_at, EXISTS (
        SELECT 1 FROM ops.reconciliation_alert_snoozes s
         WHERE s.alert_id = a.id AND s.expired_at IS NULL AND s.starts_at <= ${now} AND s.ends_at > ${now}
      ) AS snoozed
        FROM ops.reconciliation_alerts a
       WHERE a.kind = 'reconciliation' AND a.control_id = ${run.controlId} AND a.cause = ${target.cause}
         AND coalesce(a.asset_id, '') = ${assetId ?? ''} AND a.period_start = ${run.periodStart}::text::timestamptz
       ORDER BY (a.state IN ('open', 'acknowledged')) DESC, a.first_seen DESC, a.id DESC
       LIMIT 1
       FOR UPDATE OF a
    `;
    // An accepted discrepancy is frozen: a failure with the figures any accepted alert of this fingerprint froze changes
    // nothing, whatever alert came after it; different figures count on the live alert, reopen, or open a new one.
    if (target.cause === 'fail') {
      const accepted = await tx<{ evidence: OpsAlert['evidence'] }[]>`
        SELECT a.evidence FROM ops.reconciliation_alerts a
         WHERE a.kind = 'reconciliation' AND a.control_id = ${run.controlId} AND a.cause = 'fail' AND a.state = 'accepted'
           AND coalesce(a.asset_id, '') = ${assetId ?? ''} AND a.period_start = ${run.periodStart}::text::timestamptz
      `;
      if (accepted.some((row) => sameFrozenFigures(row.evidence.asset, asset))) return;
    }
    if (latest && LIVE.includes(latest.state as (typeof LIVE)[number])) {
      const notice = repeatNotice({
        repeatSeconds: this.options.repeatSeconds,
        lastNoticeAt: latest.last_notice_at,
        now,
        snoozed: latest.snoozed,
      });
      const sent = notice === 'sent';
      await tx`
        UPDATE ops.reconciliation_alerts SET occurrences = occurrences + 1,
          last_seen = greatest(last_seen, date_trunc('milliseconds', ${finishedAt}::text::timestamptz)),
          last_run_id = ${run.id}, evidence = ${tx.json(evidence as never)}, severity = ${tx.json(evaluation.severity as never)},
          period_end = ${run.periodEnd}::text::timestamptz, error_code = ${errorCode}, error_phase = ${errorPhase},
          notices_sent = notices_sent + ${sent ? 1 : 0}, last_notice_at = ${sent ? now : latest.last_notice_at},
          version = version + 1
        WHERE id = ${latest.id}
      `;
      await this.timeline(tx, { alertId: latest.id, at: now, kind: 'repeated', actor: FEED_ACTOR, runId: run.id, notice });
      return;
    }
    if (latest?.state === 'resolved') {
      // A repeat failure in the period reopens the resolved alert: the acknowledgement and resolution clear (the timeline
      // keeps both) and the in-console notice goes again unless a snooze is in force.
      const notice = repeatNotice({ repeatSeconds: 0, lastNoticeAt: null, now, snoozed: latest.snoozed });
      const sent = notice === 'sent';
      const [reopened] = await tx<{ version: number }[]>`
        UPDATE ops.reconciliation_alerts SET state = 'open', ack_by = NULL, ack_at = NULL, ack_note = NULL,
          resolution = NULL, resolved_by = NULL, resolved_at = NULL, corrective_tx_ids = '{}', passing_run_id = NULL,
          resolve_note = NULL, occurrences = occurrences + 1,
          last_seen = greatest(last_seen, date_trunc('milliseconds', ${finishedAt}::text::timestamptz)),
          last_run_id = ${run.id}, evidence = ${tx.json(evidence as never)}, severity = ${tx.json(evaluation.severity as never)},
          period_end = ${run.periodEnd}::text::timestamptz, error_code = ${errorCode}, error_phase = ${errorPhase},
          notices_sent = notices_sent + ${sent ? 1 : 0}, last_notice_at = ${sent ? now : latest.last_notice_at},
          version = version + 1
        WHERE id = ${latest.id}
        RETURNING version
      `;
      await this.timeline(tx, { alertId: latest.id, at: now, kind: 'reopened', actor: AUTO_ACTOR, runId: run.id, notice });
      await queueAlertEvent(
        tx,
        'coreOpsReconciliationAlertUpdated',
        { alertId: latest.id, sequence: reopened!.version, transition: 'reopened', state: 'open', actor: AUTO_ACTOR, changedAt: iso(now) },
        now,
      );
      return;
    }
    const id = this.newId();
    await tx`
      INSERT INTO ops.reconciliation_alerts (id, kind, state, control_id, asset_id, period_start, period_end, severity,
        occurrences, first_seen, last_seen, last_run_id, evidence, notices_sent, last_notice_at, version, cause, error_code,
        error_phase)
      VALUES (${id}, 'reconciliation', 'open', ${run.controlId}, ${assetId}, ${run.periodStart}::text::timestamptz,
        ${run.periodEnd}::text::timestamptz, ${tx.json(evaluation.severity as never)}, 1,
        date_trunc('milliseconds', ${finishedAt}::text::timestamptz),
        date_trunc('milliseconds', ${finishedAt}::text::timestamptz), ${run.id}, ${tx.json(evidence as never)},
        1, ${now}, 1, ${target.cause}, ${errorCode}, ${errorPhase})
    `;
    await this.timeline(tx, { alertId: id, at: now, kind: 'opened', actor: FEED_ACTOR, runId: run.id, notice: 'sent' });
    await queueAlertEvent(
      tx,
      'coreOpsReconciliationAlertOpened',
      {
        alertId: id,
        sequence: 1,
        controlId: run.controlId,
        runId: run.id,
        assetId,
        periodStart: iso(new Date(run.periodStart)),
        periodEnd: iso(new Date(run.periodEnd)),
        cause: target.cause,
        team: teamOf(target.cause),
        openedAt: iso(now),
      },
      now,
    );
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
        tx_ids: string[];
      }[]
    >`
      SELECT id::text AS id, at, kind, actor, note, run_id, notice, snooze_id, tx_ids::text[] AS tx_ids
        FROM ops.reconciliation_alert_timeline
       WHERE alert_id = ${alertId} ORDER BY reconciliation_alert_timeline.id ASC
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
        txIds: entry.tx_ids,
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
      const moved = await tx<{ version: number }[]>`
        UPDATE ops.reconciliation_alerts SET state = 'acknowledged', ack_by = ${input.actor}, ack_at = ${now},
          ack_note = ${input.note}, version = version + 1
         WHERE id = ${input.alertId} AND state = 'open' RETURNING version
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
      await this.updated(tx, input.alertId, moved[0]!.version, 'acknowledged', 'acknowledged', input.actor, now);
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
      const [bumped] = await tx<{ version: number }[]>`
        UPDATE ops.reconciliation_alerts SET version = version + 1 WHERE id = ${input.alertId} RETURNING version
      `;
      await this.updated(tx, input.alertId, bumped!.version, 'snoozed', 'snoozed', input.actor, now);
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

  /**
   * Lifts the snooze in force on an open or acknowledged alert. With none in force it changes nothing and answers the
   * alert as it is. A resolved or accepted alert has none: resolving and accepting end it.
   */
  async unsnooze(input: { alertId: string; actor: string; key: string }): Promise<OpsAlertDetail> {
    return this.write(input.key, input.alertId, 'unsnoozed', input.actor, async (tx, now) => {
      const state = await this.liveState(tx, input.alertId);
      if (state !== 'open' && state !== 'acknowledged') {
        throw new OpsError(OPS_ALERT_STATE_ILLEGAL, `This alert is ${state}, so it has no snooze to lift. Nothing was changed.`);
      }
      const lifted = await tx<{ id: string }[]>`
        UPDATE ops.reconciliation_alert_snoozes SET expired_at = ${now}
         WHERE alert_id = ${input.alertId} AND expired_at IS NULL AND ends_at > ${now} RETURNING id
      `;
      if (!lifted.length) return;
      const [bumped] = await tx<{ version: number }[]>`
        UPDATE ops.reconciliation_alerts SET version = version + 1 WHERE id = ${input.alertId} RETURNING version
      `;
      await this.updated(tx, input.alertId, bumped!.version, 'unsnoozed', state, input.actor, now);
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

  /**
   * One founder resolves a live FAIL alert as fixed, linking the corrective ledger transactions. Each id is first checked
   * with the ledger's `transactionsExist` door: an id the ledger never booked refuses `ops.resolve_transaction_not_found`
   * and a door that cannot answer refuses `ops.resolve_ledger_unavailable`, both with nothing changed. Then compare and set
   * on the state, as acknowledge does. A platform (ERROR) alert resolves only when a later run passes. The same key from
   * the same founder answers the stored result without asking the ledger again.
   */
  async resolveFixed(input: {
    alertId: string;
    actor: string;
    txIds: readonly string[];
    note: string | null;
    key: string;
  }): Promise<OpsAlertDetail> {
    const txIds = [...new Set(input.txIds.map((id) => id.toLowerCase()))];
    const [used] = await this.sql<{ alert_id: string }[]>`
      SELECT alert_id FROM ops.reconciliation_alert_timeline WHERE idempotency_key = ${input.key}
    `;
    if (!used) {
      const port = this.options.correctiveTx;
      if (!port?.configured) {
        throw new OpsError(
          OPS_RESOLVE_LEDGER_UNAVAILABLE,
          'The ledger is not wired to this service, so the corrective transactions cannot be checked. Nothing was changed.',
        );
      }
      const read = await port.exist(txIds);
      if (!read.ok) throw new OpsError(OPS_RESOLVE_LEDGER_UNAVAILABLE, `${read.message} Nothing was changed.`);
      const found = new Set(read.found.map((id) => id.toLowerCase()));
      const missing = txIds.filter((id) => !found.has(id));
      if (missing.length) {
        throw new OpsError(OPS_RESOLVE_TRANSACTION_NOT_FOUND, `The ledger has no transaction ${missing.join(', ')}. Nothing was changed.`);
      }
    }
    return this.write(input.key, input.alertId, 'resolved', input.actor, async (tx, now) => {
      const [moved] = await tx<{ version: number }[]>`
        UPDATE ops.reconciliation_alerts SET state = 'resolved', resolution = 'fixed', resolved_by = ${input.actor},
          resolved_at = ${now}, corrective_tx_ids = ${txIds}::uuid[], resolve_note = ${input.note}, version = version + 1
         WHERE id = ${input.alertId} AND state IN ('open', 'acknowledged') AND cause = 'fail'
        RETURNING version
      `;
      if (!moved) throw await this.illegal(tx, input.alertId, 'resolved as fixed');
      await this.endSnooze(tx, input.alertId, now);
      await this.timeline(tx, {
        alertId: input.alertId,
        at: now,
        kind: 'resolved',
        actor: input.actor,
        note: input.note,
        key: input.key,
        txIds,
      });
      await queueAlertEvent(
        tx,
        'coreOpsReconciliationAlertResolved',
        {
          alertId: input.alertId,
          sequence: moved.version,
          resolution: 'fixed',
          correctiveTxIds: txIds,
          passingRunId: null,
          actor: input.actor,
          resolvedAt: iso(now),
        },
        now,
      );
    });
  }

  /**
   * Accepts a live FAIL discrepancy two founders approved. A blank note refuses before any approval is spent. The evidence
   * the approval signed must still be the alert's evidence: if a later run changed it, the acceptance is refused and the
   * approval is not spent. Then identity spends the approval (proposed by `requesterId`, approved by another founder) and
   * the alert freezes: state, note, both names and the evidence hash. Replaying the same approval answers the stored result.
   */
  async accept(input: {
    alertId: string;
    requesterId: string;
    note: string;
    evidenceHash: string;
    approvalId: string;
    operationId: string;
  }): Promise<OpsAlertDetail> {
    // The note is stored and hashed exactly as the approval bound it; only the blank check trims.
    const note = input.note;
    if (!note.trim()) {
      throw new OpsError(OPS_RESOLVE_NOTE_REQUIRED, 'Accepting a discrepancy needs a note. Nothing was changed and no approval was spent.');
    }
    const key = `${OPS_ALERT_ACCEPT_ACTION}:${input.approvalId.trim()}`;
    return this.write(key, input.alertId, 'accepted', input.requesterId, async (tx, now) => {
      const [row] = await tx<{ state: OpsAlert['state']; cause: OpsAlert['cause']; evidence: OpsAlert['evidence'] }[]>`
        SELECT state, cause, evidence FROM ops.reconciliation_alerts WHERE id = ${input.alertId} FOR UPDATE
      `;
      if (!row) throw new OpsError(OPS_ALERT_NOT_FOUND, 'No reconciliation alert has this id.');
      if (row.cause !== 'fail' || (row.state !== 'open' && row.state !== 'acknowledged')) {
        throw await this.illegal(tx, input.alertId, 'accepted');
      }
      if (evidenceHash(row.evidence) !== input.evidenceHash) {
        throw new OpsError(
          OPS_ALERT_STATE_ILLEGAL,
          'The evidence changed after the acceptance was asked (a later run failed with other figures). Nothing was changed and the approval was not spent; ask again on the evidence shown now.',
        );
      }
      const consumed = await consumeFounderApproval(this.options.approvals, {
        approvalId: input.approvalId,
        operationId: input.operationId,
        requestId: `ops-recon-accept:${sha256(key)}`,
        actionType: OPS_ALERT_ACCEPT_ACTION,
        targetService: 'svc-ops',
        targetId: `reconciliation-alert:${input.alertId}`,
        fields: opsAlertAcceptFields(input.alertId, note, input.evidenceHash),
        requesterId: input.requesterId,
      });
      const approvedBy = consumed.approverId?.trim() ?? '';
      if (!approvedBy || approvedBy.toLowerCase() === input.requesterId.trim().toLowerCase()) {
        throw new OpsError(OPS_APPROVAL_NOT_FOUNDERS, 'An acceptance needs a second founder to approve it. Nothing was changed.');
      }
      const [moved] = await tx<{ version: number }[]>`
        UPDATE ops.reconciliation_alerts SET state = 'accepted', accepted_requested_by = ${input.requesterId},
          accepted_approved_by = ${approvedBy}, accepted_at = ${now}, accepted_note = ${note},
          accepted_evidence_hash = ${input.evidenceHash}, accepted_approval_id = ${consumed.approvalId}, version = version + 1
         WHERE id = ${input.alertId}
        RETURNING version
      `;
      await this.endSnooze(tx, input.alertId, now);
      await this.timeline(tx, { alertId: input.alertId, at: now, kind: 'accepted', actor: input.requesterId, note, key });
      await queueAlertEvent(
        tx,
        'coreOpsReconciliationAlertAccepted',
        {
          alertId: input.alertId,
          sequence: moved!.version,
          requestedBy: input.requesterId,
          approvedBy,
          evidenceHash: input.evidenceHash,
          noteHash: sha256(note),
          acceptedAt: iso(now),
        },
        now,
      );
    });
  }

  /** Ledger reconcile runs that could not finish, newest received first, as `ledger.reconciliation_run.failed` brought them. */
  async incidents(limit: number): Promise<OpsPlatformIncident[]> {
    const rows = await this.sql<
      {
        event_key: string;
        error_code: string;
        phase: string;
        consecutive_incomplete: number;
        ledger_run_id: string | null;
        occurred_at: Date;
        received_at: Date;
      }[]
    >`
      SELECT event_key, error_code, phase, consecutive_incomplete, ledger_run_id, occurred_at, received_at
        FROM ops.reconciliation_platform_incidents ORDER BY received_at DESC, event_key ASC LIMIT ${limit}
    `;
    return rows.map((row) => ({
      eventKey: row.event_key,
      team: 'platform',
      errorCode: row.error_code,
      phase: row.phase,
      consecutiveIncomplete: row.consecutive_incomplete,
      ledgerRunId: row.ledger_run_id,
      occurredAt: iso(row.occurred_at),
      receivedAt: iso(row.received_at),
    }));
  }

  /** Why a resolve or accept does not fit the alert as it stands now. */
  private async illegal(tx: TransactionSql, alertId: string, move: string): Promise<OpsError> {
    const current = await this.get(alertId, tx);
    const { alert } = current;
    if (alert.cause === 'error') {
      return new OpsError(
        OPS_ALERT_STATE_ILLEGAL,
        `This is a platform alert (the run could not finish), so it cannot be ${move}; it resolves when a later run of the control passes. Nothing was changed.`,
      );
    }
    return new OpsError(OPS_ALERT_STATE_ILLEGAL, `This alert is ${alert.state}, so it cannot be ${move}. Nothing was changed.`);
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

  /** Resolving and accepting end the snooze in force; it stays readable as expired. */
  private async endSnooze(tx: TransactionSql, alertId: string, now: Date): Promise<void> {
    await tx`UPDATE ops.reconciliation_alert_snoozes SET expired_at = ${now} WHERE alert_id = ${alertId} AND expired_at IS NULL`;
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
      txIds?: readonly string[];
    },
  ): Promise<void> {
    await tx`
      INSERT INTO ops.reconciliation_alert_timeline (alert_id, at, kind, actor, note, run_id, notice, snooze_id, idempotency_key,
        tx_ids)
      VALUES (${entry.alertId}, ${entry.at}, ${entry.kind}, ${entry.actor}, ${entry.note ?? null}, ${entry.runId ?? null},
        ${entry.notice ?? null}, ${entry.snoozeId ?? null}, ${entry.key ?? null}, ${[...(entry.txIds ?? [])]}::uuid[])
    `;
  }

  private async updated(
    tx: TransactionSql,
    alertId: string,
    sequence: number,
    transition: 'acknowledged' | 'snoozed' | 'unsnoozed',
    state: 'open' | 'acknowledged' | 'snoozed',
    actor: string,
    now: Date,
  ): Promise<void> {
    await queueAlertEvent(
      tx,
      'coreOpsReconciliationAlertUpdated',
      { alertId, sequence, transition, state, actor, changedAt: iso(now) },
      now,
    );
  }

  private view(row: AlertRow): OpsAlert {
    const live = row.state === 'open' || row.state === 'acknowledged';
    const seconds = this.options.repeatSeconds;
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      cause: row.cause,
      team: teamOf(row.cause),
      error: row.cause === 'error' && row.error_code ? { code: row.error_code, phase: row.error_phase } : null,
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
      resolved:
        row.resolution && row.resolved_by && row.resolved_at
          ? {
              resolution: row.resolution,
              by: row.resolved_by,
              at: iso(row.resolved_at),
              correctiveTxIds: row.corrective_tx_ids,
              passingRunId: row.passing_run_id,
              note: row.resolve_note,
            }
          : null,
      accepted:
        row.accepted_at && row.accepted_requested_by && row.accepted_approved_by && row.accepted_note && row.accepted_evidence_hash
          ? {
              requestedBy: row.accepted_requested_by,
              approvedBy: row.accepted_approved_by,
              at: iso(row.accepted_at),
              note: row.accepted_note,
              evidenceHash: row.accepted_evidence_hash,
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

function teamOf(cause: OpsAlert['cause']): OpsAlert['team'] {
  return cause === 'fail' ? 'finance' : 'platform';
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
