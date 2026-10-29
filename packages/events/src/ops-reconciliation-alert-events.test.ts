import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './catalog.js';

const ts = () => new Date().toISOString();
const id = () => crypto.randomUUID();

describe('OPS-reconciliation-04 reconciliation alert events', () => {
  it('declares the four subjects', () => {
    expect(EVENT_CATALOG.coreOpsReconciliationAlertOpened.subject).toBe('intafaced.core-ops.reconciliation_alert.opened');
    expect(EVENT_CATALOG.coreOpsReconciliationAlertUpdated.subject).toBe('intafaced.core-ops.reconciliation_alert.updated');
    expect(EVENT_CATALOG.coreOpsReconciliationAlertResolved.subject).toBe('intafaced.core-ops.reconciliation_alert.resolved');
    expect(EVENT_CATALOG.coreOpsReconciliationAlertAccepted.subject).toBe('intafaced.core-ops.reconciliation_alert.accepted');
  });

  it('raises a run that could not finish as an error alert with no asset', () => {
    const opened = {
      alertId: id(),
      sequence: 1,
      controlId: id(),
      runId: id(),
      assetId: null,
      periodStart: ts(),
      periodEnd: ts(),
      cause: 'error',
      team: 'platform',
      openedAt: ts(),
    };
    expect(EVENT_CATALOG.coreOpsReconciliationAlertOpened.schema.safeParse(opened).success).toBe(true);
    expect(EVENT_CATALOG.coreOpsReconciliationAlertOpened.schema.safeParse({ ...opened, team: 'support' }).success).toBe(false);
    expect(EVENT_CATALOG.coreOpsReconciliationAlertOpened.schema.safeParse({ ...opened, sequence: 0 }).success).toBe(false);
  });

  it('refuses an unknown transition, a non-uuid corrective transaction and a blank approver', () => {
    const updated = { alertId: id(), sequence: 2, transition: 'reopened', state: 'open', actor: 'auto', changedAt: ts() };
    expect(EVENT_CATALOG.coreOpsReconciliationAlertUpdated.schema.safeParse(updated).success).toBe(true);
    expect(EVENT_CATALOG.coreOpsReconciliationAlertUpdated.schema.safeParse({ ...updated, transition: 'resolved' }).success).toBe(false);

    const resolved = {
      alertId: id(),
      sequence: 3,
      resolution: 'fixed',
      correctiveTxIds: [id()],
      passingRunId: null,
      actor: 'op-1',
      resolvedAt: ts(),
    };
    expect(EVENT_CATALOG.coreOpsReconciliationAlertResolved.schema.safeParse(resolved).success).toBe(true);
    expect(EVENT_CATALOG.coreOpsReconciliationAlertResolved.schema.safeParse({ ...resolved, correctiveTxIds: ['tx-1'] }).success).toBe(
      false,
    );

    const accepted = {
      alertId: id(),
      sequence: 4,
      requestedBy: 'op-1',
      approvedBy: 'op-2',
      evidenceHash: 'a'.repeat(64),
      acceptedAt: ts(),
    };
    expect(EVENT_CATALOG.coreOpsReconciliationAlertAccepted.schema.safeParse(accepted).success).toBe(true);
    expect(EVENT_CATALOG.coreOpsReconciliationAlertAccepted.schema.safeParse({ ...accepted, approvedBy: '' }).success).toBe(false);
    expect(EVENT_CATALOG.coreOpsReconciliationAlertAccepted.schema.safeParse({ ...accepted, evidenceHash: 'x' }).success).toBe(false);
  });
});
