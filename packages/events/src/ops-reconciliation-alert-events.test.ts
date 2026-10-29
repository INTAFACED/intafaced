import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './catalog.js';

const ts = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const ok = (event: keyof typeof EVENT_CATALOG, payload: unknown) => EVENT_CATALOG[event].schema.safeParse(payload).success;

describe('OPS-reconciliation-04 reconciliation alert events', () => {
  it('declares the four subjects', () => {
    expect(EVENT_CATALOG.coreOpsReconciliationAlertOpened.subject).toBe('intafaced.core-ops.reconciliation_alert.opened');
    expect(EVENT_CATALOG.coreOpsReconciliationAlertUpdated.subject).toBe('intafaced.core-ops.reconciliation_alert.updated');
    expect(EVENT_CATALOG.coreOpsReconciliationAlertResolved.subject).toBe('intafaced.core-ops.reconciliation_alert.resolved');
    expect(EVENT_CATALOG.coreOpsReconciliationAlertAccepted.subject).toBe('intafaced.core-ops.reconciliation_alert.accepted');
  });

  it('raises a failing run to finance and a run that could not finish to the platform team, never crossed', () => {
    const start = '2026-10-29T00:00:00.000Z';
    const end = '2026-10-29T01:00:00.000Z';
    const opened = {
      alertId: id(),
      sequence: 1,
      controlId: id(),
      runId: id(),
      assetId: null,
      periodStart: start,
      periodEnd: end,
      cause: 'error',
      team: 'platform',
      openedAt: ts(),
    };
    expect(ok('coreOpsReconciliationAlertOpened', opened)).toBe(true);
    expect(ok('coreOpsReconciliationAlertOpened', { ...opened, cause: 'fail', team: 'finance', assetId: 'ETH' })).toBe(true);
    expect(ok('coreOpsReconciliationAlertOpened', { ...opened, team: 'finance' })).toBe(false);
    expect(ok('coreOpsReconciliationAlertOpened', { ...opened, cause: 'fail' })).toBe(false);
    expect(ok('coreOpsReconciliationAlertOpened', { ...opened, periodStart: end, periodEnd: start })).toBe(false);
    expect(ok('coreOpsReconciliationAlertOpened', { ...opened, sequence: 0 })).toBe(false);
  });

  it('ties the state to the transition', () => {
    const updated = { alertId: id(), sequence: 2, transition: 'reopened', state: 'open', actor: 'auto', changedAt: ts() };
    expect(ok('coreOpsReconciliationAlertUpdated', updated)).toBe(true);
    expect(ok('coreOpsReconciliationAlertUpdated', { ...updated, transition: 'unsnoozed', state: 'acknowledged' })).toBe(true);
    expect(ok('coreOpsReconciliationAlertUpdated', { ...updated, state: 'resolved' })).toBe(false);
    expect(ok('coreOpsReconciliationAlertUpdated', { ...updated, transition: 'acknowledged', state: 'accepted' })).toBe(false);
    expect(ok('coreOpsReconciliationAlertUpdated', { ...updated, transition: 'resolved' })).toBe(false);
  });

  it('makes a fix name its corrective transactions and an auto resolve name the passing run', () => {
    const fixed = {
      alertId: id(),
      sequence: 3,
      resolution: 'fixed',
      correctiveTxIds: [id()],
      passingRunId: null,
      actor: 'op-1',
      resolvedAt: ts(),
    };
    const auto = { ...fixed, resolution: 'auto', correctiveTxIds: [], passingRunId: id(), actor: 'auto' };
    expect(ok('coreOpsReconciliationAlertResolved', fixed)).toBe(true);
    expect(ok('coreOpsReconciliationAlertResolved', auto)).toBe(true);
    expect(ok('coreOpsReconciliationAlertResolved', { ...fixed, correctiveTxIds: [] })).toBe(false);
    expect(ok('coreOpsReconciliationAlertResolved', { ...fixed, correctiveTxIds: ['tx-1'] })).toBe(false);
    expect(ok('coreOpsReconciliationAlertResolved', { ...fixed, actor: 'auto' })).toBe(false);
    expect(ok('coreOpsReconciliationAlertResolved', { ...auto, passingRunId: null })).toBe(false);
    expect(ok('coreOpsReconciliationAlertResolved', { ...auto, correctiveTxIds: [id()] })).toBe(false);
  });

  it('accepts a discrepancy only with a second approver and the hashes of the frozen evidence and the note', () => {
    const accepted = {
      alertId: id(),
      sequence: 4,
      requestedBy: 'op-1',
      approvedBy: 'op-2',
      evidenceHash: 'a'.repeat(64),
      noteHash: 'b'.repeat(64),
      acceptedAt: ts(),
    };
    expect(ok('coreOpsReconciliationAlertAccepted', accepted)).toBe(true);
    expect(ok('coreOpsReconciliationAlertAccepted', { ...accepted, approvedBy: 'op-1' })).toBe(false);
    expect(ok('coreOpsReconciliationAlertAccepted', { ...accepted, approvedBy: '' })).toBe(false);
    expect(ok('coreOpsReconciliationAlertAccepted', { ...accepted, evidenceHash: 'x' })).toBe(false);
    const { noteHash: _omitted, ...withoutNote } = accepted;
    expect(ok('coreOpsReconciliationAlertAccepted', withoutNote)).toBe(false);
  });
});
