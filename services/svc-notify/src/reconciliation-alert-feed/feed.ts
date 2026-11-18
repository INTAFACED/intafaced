/**
 * The finance and platform teams' reconciliation alert feed (OPS-reconciliation-04, J-ops-console-07 #10).
 *
 * svc-ops publishes every alert transition (opened, acknowledged, snoozed, unsnoozed, reopened, resolved, accepted) at least
 * once, each under its business key `ops:reconciliation-alert:<alertId>:<sequence>`. svc-notify keeps one row per key, so a
 * transition received twice is applied once, and the console shows on each alert what the teams were told and when.
 *
 * A row holds ids, states and times only, as the event does. Nothing is sent out of app from here, and nothing reaches a
 * customer's inbox: an alert is about INTAFACED's own books.
 */
import type { Sql } from 'postgres';
import type { PayloadOf } from '@intafaced/events';
import type { NotifyReconAlertFeedEntry } from '@intafaced/contracts/ops-reconciliation-alerts';

/** One received transition, as `reconciliationAlertFeed.list` answers it (`team` is set on `opened` only). */
export type ReconAlertFeedEntry = NotifyReconAlertFeedEntry;
type ReconAlertFeedKind = ReconAlertFeedEntry['kind'];

export type ReconAlertTransition = Omit<ReconAlertFeedEntry, 'receivedAt'>;

export interface ReconAlertFeedStore {
  /** Stores the transition once per business key; a second delivery of the same key changes nothing. */
  record(entry: ReconAlertTransition, receivedAt: Date): Promise<{ inserted: boolean }>;
  /** One alert's transitions as received, oldest sequence first. */
  list(alertId: string): Promise<ReconAlertFeedEntry[]>;
}

/** The feed entry an event becomes, under the key the bus delivered it with. */
export function opened(p: PayloadOf<'coreOpsReconciliationAlertOpened'>, eventKey: string): ReconAlertTransition {
  return {
    eventKey,
    alertId: p.alertId,
    sequence: p.sequence,
    kind: 'opened',
    team: p.team,
    state: 'open',
    actor: 'auto',
    occurredAt: p.openedAt,
  };
}
export function updated(p: PayloadOf<'coreOpsReconciliationAlertUpdated'>, eventKey: string): ReconAlertTransition {
  return {
    eventKey,
    alertId: p.alertId,
    sequence: p.sequence,
    kind: p.transition,
    team: null,
    state: p.state,
    actor: p.actor,
    occurredAt: p.changedAt,
  };
}
export function resolved(p: PayloadOf<'coreOpsReconciliationAlertResolved'>, eventKey: string): ReconAlertTransition {
  return {
    eventKey,
    alertId: p.alertId,
    sequence: p.sequence,
    kind: 'resolved',
    team: null,
    state: 'resolved',
    actor: p.actor,
    occurredAt: p.resolvedAt,
  };
}
export function accepted(p: PayloadOf<'coreOpsReconciliationAlertAccepted'>, eventKey: string): ReconAlertTransition {
  return {
    eventKey,
    alertId: p.alertId,
    sequence: p.sequence,
    kind: 'accepted',
    team: null,
    state: 'accepted',
    actor: p.approvedBy,
    occurredAt: p.acceptedAt,
  };
}

export class MemoryReconAlertFeedStore implements ReconAlertFeedStore {
  private readonly rows = new Map<string, ReconAlertFeedEntry>();

  async record(entry: ReconAlertTransition, receivedAt: Date): Promise<{ inserted: boolean }> {
    if (this.rows.has(entry.eventKey)) return { inserted: false };
    if ([...this.rows.values()].some((r) => r.alertId === entry.alertId && r.sequence === entry.sequence)) return { inserted: false };
    this.rows.set(entry.eventKey, { ...entry, receivedAt: receivedAt.toISOString() });
    return { inserted: true };
  }

  async list(alertId: string): Promise<ReconAlertFeedEntry[]> {
    return [...this.rows.values()].filter((r) => r.alertId === alertId).sort((a, b) => a.sequence - b.sequence);
  }
}

interface FeedRow {
  event_key: string;
  alert_id: string;
  sequence: number;
  kind: ReconAlertFeedKind;
  team: 'finance' | 'platform' | null;
  state: ReconAlertFeedEntry['state'];
  actor: string;
  occurred_at: Date;
  received_at: Date;
}

/** On notify.reconciliation_alert_feed (20261118141504_notify_reconciliation_alert_feed.sql). */
export class SqlReconAlertFeedStore implements ReconAlertFeedStore {
  constructor(private readonly sql: Sql) {}

  async record(entry: ReconAlertTransition, receivedAt: Date): Promise<{ inserted: boolean }> {
    // ON CONFLICT DO NOTHING covers both keys: the business key and (alert, sequence), which name the same transition.
    const rows = await this.sql<{ event_key: string }[]>`
      INSERT INTO notify.reconciliation_alert_feed (event_key, alert_id, sequence, kind, team, state, actor, occurred_at, received_at)
      VALUES (${entry.eventKey}, ${entry.alertId}, ${entry.sequence}, ${entry.kind}, ${entry.team}, ${entry.state}, ${entry.actor},
        ${entry.occurredAt}, ${receivedAt})
      ON CONFLICT DO NOTHING
      RETURNING event_key
    `;
    return { inserted: rows.length > 0 };
  }

  async list(alertId: string): Promise<ReconAlertFeedEntry[]> {
    const rows = await this.sql<FeedRow[]>`
      SELECT event_key, alert_id::text AS alert_id, sequence, kind, team, state, actor, occurred_at, received_at
        FROM notify.reconciliation_alert_feed WHERE alert_id = ${alertId} ORDER BY sequence
    `;
    return rows.map((r) => ({
      eventKey: r.event_key,
      alertId: r.alert_id,
      sequence: r.sequence,
      kind: r.kind,
      team: r.team,
      state: r.state,
      actor: r.actor,
      occurredAt: new Date(r.occurred_at).toISOString(),
      receivedAt: new Date(r.received_at).toISOString(),
    }));
  }
}
