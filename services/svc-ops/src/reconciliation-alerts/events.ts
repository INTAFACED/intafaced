/**
 * Reconciliation alert events (OPS-reconciliation-04).
 *
 * Every alert transition writes one row to `ops.reconciliation_alert_events` in its own transaction; `relayAlertEvents`
 * publishes the rows after the commit, at least once, each under its business key
 * `ops:reconciliation-alert:<alertId>:<sequence>` (sequence = the alert's version after the change), so a consumer that
 * receives one twice applies it once. The payloads carry ids and states only: no amount, account or customer data.
 *
 * svc-ops reads its own transition events back from the bus too (`subscribeAlertReceipts`): one receipt per event key, the
 * delivery check on this outbox, so an event delivered twice is stored once.
 *
 * svc-ops also reads `ledger.reconciliation_run.failed`: each one is a platform incident (the ledger's own reconcile run
 * could not finish), stored once by the event's business key however often the bus delivers it. Never a finance alert.
 */
import type { Sql, TransactionSql } from 'postgres';
import { EVENT_CATALOG, type EventBus, type PayloadOf, type Subscription } from '@intafaced/events';

export type AlertEventName =
  | 'coreOpsReconciliationAlertOpened'
  | 'coreOpsReconciliationAlertUpdated'
  | 'coreOpsReconciliationAlertResolved'
  | 'coreOpsReconciliationAlertAccepted';
export type AlertEventPayload<K extends AlertEventName> = PayloadOf<K>;

export const alertEventKey = (alertId: string, sequence: number): string => `ops:reconciliation-alert:${alertId}:${sequence}`;

/**
 * Queues one transition event in the caller's transaction. The payload is checked against the catalog here, so a payload
 * the bus would refuse fails the transition instead of sitting unpublishable in the outbox.
 */
export async function queueAlertEvent<K extends AlertEventName>(
  tx: TransactionSql,
  name: K,
  payload: AlertEventPayload<K>,
  now: Date,
): Promise<void> {
  const parsed = EVENT_CATALOG[name].schema.parse(payload) as AlertEventPayload<K>;
  const { alertId, sequence } = parsed as { alertId: string; sequence: number };
  await tx`
    INSERT INTO ops.reconciliation_alert_events (alert_id, sequence, name, payload, idempotency_key, created_at)
    VALUES (${alertId}, ${sequence}, ${name}, ${tx.json(parsed as never)}, ${alertEventKey(alertId, sequence)}, ${now})
  `;
}

/** One literal publish per subject, so the event wiring gate sees each publisher. */
async function publishAlertEvent(bus: EventBus, name: AlertEventName, payload: unknown, idempotencyKey: string): Promise<void> {
  switch (name) {
    case 'coreOpsReconciliationAlertOpened':
      await bus.publish('coreOpsReconciliationAlertOpened', payload as PayloadOf<'coreOpsReconciliationAlertOpened'>, { idempotencyKey });
      return;
    case 'coreOpsReconciliationAlertUpdated':
      await bus.publish('coreOpsReconciliationAlertUpdated', payload as PayloadOf<'coreOpsReconciliationAlertUpdated'>, { idempotencyKey });
      return;
    case 'coreOpsReconciliationAlertResolved':
      await bus.publish('coreOpsReconciliationAlertResolved', payload as PayloadOf<'coreOpsReconciliationAlertResolved'>, {
        idempotencyKey,
      });
      return;
    case 'coreOpsReconciliationAlertAccepted':
      await bus.publish('coreOpsReconciliationAlertAccepted', payload as PayloadOf<'coreOpsReconciliationAlertAccepted'>, {
        idempotencyKey,
      });
      return;
  }
}

/**
 * Publishes queued alert events oldest first, each in its own transaction under a row lock (SKIP LOCKED, so two relays
 * never hold one row), marking it published only after the bus took it. A crash between the publish and the mark
 * publishes the same key again, which a consumer applies once. A publish that fails leaves the row for the next tick.
 */
export async function relayAlertEvents(deps: { sql: Sql; bus: EventBus; now: () => Date }, limit = 50): Promise<number> {
  const due = await deps.sql<{ id: string }[]>`
    SELECT e.id::text AS id FROM ops.reconciliation_alert_events e WHERE e.published_at IS NULL ORDER BY e.id LIMIT ${limit}
  `;
  let published = 0;
  for (const { id } of due) {
    const sent = await deps.sql.begin(async (tx) => {
      const [row] = await tx<{ name: AlertEventName; payload: unknown; idempotency_key: string }[]>`
        SELECT name, payload, idempotency_key FROM ops.reconciliation_alert_events
         WHERE id = ${id} AND published_at IS NULL FOR UPDATE SKIP LOCKED
      `;
      if (!row) return false;
      await publishAlertEvent(deps.bus, row.name, row.payload, row.idempotency_key);
      await tx`UPDATE ops.reconciliation_alert_events SET published_at = ${deps.now()} WHERE id = ${id}`;
      return true;
    });
    if (sent) published += 1;
  }
  return published;
}

/**
 * Stores each `ledger.reconciliation_run.failed` as one platform incident, keyed by the event's business key, so the same event delivered twice is stored once.
 */
export async function subscribeRunFailed(deps: { sql: Sql; bus: EventBus; now: () => Date }): Promise<Subscription> {
  return deps.bus.subscribe(
    'ledgerReconciliationRunFailed',
    async (payload, envelope) => {
      await deps.sql`
        INSERT INTO ops.reconciliation_platform_incidents (event_key, error_code, phase, consecutive_incomplete, ledger_run_id,
          occurred_at, received_at)
        VALUES (${envelope.idempotencyKey}, ${payload.errorCode}, ${payload.phase}, ${payload.consecutiveIncomplete},
          ${payload.runId}, ${envelope.occurredAt}, ${deps.now()})
        ON CONFLICT (event_key) DO NOTHING
      `;
    },
    { durable: 'ops-recon-run-failed' },
  );
}

/** The durable consumers of svc-ops' own alert transition events, one per subject. */
export const ALERT_RECEIPT_DURABLES = {
  coreOpsReconciliationAlertOpened: 'ops-recon-alert-receipt-opened',
  coreOpsReconciliationAlertUpdated: 'ops-recon-alert-receipt-updated',
  coreOpsReconciliationAlertResolved: 'ops-recon-alert-receipt-resolved',
  coreOpsReconciliationAlertAccepted: 'ops-recon-alert-receipt-accepted',
} as const satisfies Record<AlertEventName, string>;

/** One receipt of a transition event as the bus brought it back: stored once by its business key, never changed after. */
export async function storeAlertReceipt(
  sql: Sql,
  receipt: {
    eventKey: string;
    alertId: string;
    sequence: number;
    event: 'opened' | 'updated' | 'resolved' | 'accepted';
    transition: 'acknowledged' | 'snoozed' | 'unsnoozed' | 'reopened' | null;
    occurredAt: string;
  },
  now: Date,
): Promise<boolean> {
  // The key is the event's own business key, and it must be the one this alert and sequence publish under: an envelope that
  // names another key is not one of these events, and a receipt keyed by it would never match the outbox row.
  if (receipt.eventKey !== alertEventKey(receipt.alertId, receipt.sequence)) {
    throw new Error(`receipt key ${receipt.eventKey} is not the key of alert ${receipt.alertId} sequence ${receipt.sequence}`);
  }
  const stored = await sql`
    INSERT INTO ops.reconciliation_alert_receipts (event_key, alert_id, sequence, event, transition, occurred_at, received_at)
    VALUES (${receipt.eventKey}, ${receipt.alertId}, ${receipt.sequence}, ${receipt.event}, ${receipt.transition},
      ${receipt.occurredAt}, ${now})
    ON CONFLICT (event_key) DO NOTHING
  `;
  return stored.count === 1;
}

/**
 * svc-ops reads its own `core-ops.reconciliation_alert.*` events back from the bus and stores one receipt per event key: the
 * delivery check on the outbox (an alert whose newest sequence has no receipt has a transition the bus has not delivered).
 * Delivery is at least once, so the same event received twice is stored once and changes nothing the second time.
 */
export async function subscribeAlertReceipts(deps: { sql: Sql; bus: EventBus; now: () => Date }): Promise<Subscription[]> {
  const { sql, bus, now } = deps;
  return Promise.all([
    bus.subscribe(
      'coreOpsReconciliationAlertOpened',
      async (p, env) => {
        await storeAlertReceipt(
          sql,
          {
            eventKey: env.idempotencyKey,
            alertId: p.alertId,
            sequence: p.sequence,
            event: 'opened',
            transition: null,
            occurredAt: env.occurredAt,
          },
          now(),
        );
      },
      { durable: ALERT_RECEIPT_DURABLES.coreOpsReconciliationAlertOpened },
    ),
    bus.subscribe(
      'coreOpsReconciliationAlertUpdated',
      async (p, env) => {
        await storeAlertReceipt(
          sql,
          {
            eventKey: env.idempotencyKey,
            alertId: p.alertId,
            sequence: p.sequence,
            event: 'updated',
            transition: p.transition,
            occurredAt: env.occurredAt,
          },
          now(),
        );
      },
      { durable: ALERT_RECEIPT_DURABLES.coreOpsReconciliationAlertUpdated },
    ),
    bus.subscribe(
      'coreOpsReconciliationAlertResolved',
      async (p, env) => {
        await storeAlertReceipt(
          sql,
          {
            eventKey: env.idempotencyKey,
            alertId: p.alertId,
            sequence: p.sequence,
            event: 'resolved',
            transition: null,
            occurredAt: env.occurredAt,
          },
          now(),
        );
      },
      { durable: ALERT_RECEIPT_DURABLES.coreOpsReconciliationAlertResolved },
    ),
    bus.subscribe(
      'coreOpsReconciliationAlertAccepted',
      async (p, env) => {
        await storeAlertReceipt(
          sql,
          {
            eventKey: env.idempotencyKey,
            alertId: p.alertId,
            sequence: p.sequence,
            event: 'accepted',
            transition: null,
            occurredAt: env.occurredAt,
          },
          now(),
        );
      },
      { durable: ALERT_RECEIPT_DURABLES.coreOpsReconciliationAlertAccepted },
    ),
  ]);
}
