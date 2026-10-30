import { describe, expect, it } from 'vitest';
import {
  buildDefineBody,
  buildUpdateBody,
  controlRefusal,
  describeAccountSet,
  describeRun,
  describeSchedule,
  emptyControlForm,
  formFromControl,
  lifecycleMoves,
  parseControlList,
  parseControlRun,
  runInstant,
  runMargin,
  type ControlForm,
} from './reconciliation';
import { CONTROL_ID, controlView, runView } from './reconciliation-fixtures.test-util';
import { updateReconciliationControlInputSchema } from '@intafaced/contracts/ledger-reconciliation';

const REASON = 'LOCAL TEST define the USDT floor control';
const form = (extra: Partial<ControlForm> = {}): ControlForm => ({ ...emptyControlForm(), assetId: 'USDT', reason: REASON, ...extra });

describe('define body: what the founder typed, and nothing filled in', () => {
  it('a blank tolerance is sent blank, so svc-ledger answers ops.control_policy_unset itself', () => {
    const built = buildDefineBody(form({ activate: true, cadence: 'daily', hour: '6', minute: '30', severity: 'warning' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({
      template: 'threshold',
      schedule: { cadence: 'daily', hour: 6, minute: 30 },
      severity: 'warning',
      accountSet: { mode: 'query', assetId: 'USDT' },
      reason: REASON,
      activate: true,
    });
    expect(built.body).not.toHaveProperty('tolerance');
  });
  it('typed 0 is a tolerance of zero, not a blank', () => {
    const built = buildDefineBody(form({ toleranceDefault: '0', toleranceByAsset: 'BTC=0.5' }));
    expect(built.ok && built.body.tolerance).toEqual({ default: '0', byAsset: { BTC: '0.5' } });
  });
  it('an account set with no filter is refused before it is sent, naming the contract code', () => {
    const built = buildDefineBody(form({ assetId: '' }));
    expect(built).toMatchObject({ ok: false });
    expect(!built.ok && built.why).toContain('ops.control_policy_unset');
  });
  it('a rail boundary is sent as the rail, kept through an edit, and refused beside an owner filter', () => {
    const built = buildDefineBody(form({ template: 'outside_balance', rail: 'crypto-native', toleranceDefault: '0' }));
    expect(built.ok && built.body.accountSet).toEqual({ mode: 'query', rail: 'crypto-native', assetId: 'USDT' });
    const clash = buildDefineBody(form({ rail: 'crypto-native', ownerType: 'user' }));
    expect(!clash.ok && clash.why).toContain('Rail boundary names its own accounts');
    const view = controlView({ accountSet: { mode: 'query', rail: 'crypto-native', assetId: 'USDT' } });
    expect(formFromControl(view).rail).toBe('crypto-native');
    expect(describeAccountSet(view)).toContain('boundary of rail crypto-native');
  });
  it('a schedule needs its minute and hour, a threshold needs its bound, and a pair must be ASSET=amount', () => {
    expect(buildDefineBody(form({ cadence: 'daily', minute: '5' }))).toMatchObject({ ok: false });
    expect(buildDefineBody(form({ cadence: 'hourly' }))).toMatchObject({ ok: false });
    expect(buildDefineBody(form({ thresholdByAsset: 'USDT=1' }))).toMatchObject({ ok: false });
    expect(buildDefineBody(form({ toleranceByAsset: 'USDT 1' }))).toMatchObject({ ok: false });
    expect(buildDefineBody(form({ toleranceDefault: '-1' }))).toMatchObject({ ok: false });
    expect(buildDefineBody(form({ reason: 'too short' }))).toMatchObject({ ok: false });
  });
  it('named accounts are lower-cased ids', () => {
    const id = '7C1D2E3F-1111-4222-8333-444455556666';
    const built = buildDefineBody(form({ accountMode: 'explicit', accountIds: `${id}\n` }));
    expect(built.ok && built.body.accountSet).toEqual({ mode: 'explicit', accountIds: [id.toLowerCase()] });
  });
});

describe('update body from what svc-ledger holds', () => {
  it('a control read back and saved unchanged sends the same policy', () => {
    const view = controlView();
    const built = buildUpdateBody(view, { ...formFromControl(view), reason: 'LOCAL TEST change the explanation' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toMatchObject({
      controlId: CONTROL_ID,
      explanation: 'TEST USDT float floor',
      labels: ['test'],
      schedule: { cadence: 'daily', hour: 6, minute: 30 },
      severity: 'warning',
      tolerance: { default: '0' },
      accountSet: { mode: 'query', assetId: 'USDT' },
      threshold: { bound: 'min', byAsset: { USDT: '1' } },
    });
    expect(built.body).not.toHaveProperty('margin');
  });
  it('a set value blanked in the form is refused, since svc-ledger would keep it; explanation and labels can be emptied', () => {
    const view = controlView({ margin: { status: 'set', value: '30' } });
    const reason = 'LOCAL TEST change the control';
    const blanked = buildUpdateBody(view, { ...formFromControl(view), margin: '', toleranceDefault: '', reason });
    expect(blanked).toMatchObject({ ok: false });
    expect(!blanked.ok && blanked.why).toContain('tolerance, margin');
    const emptied = buildUpdateBody(view, { ...formFromControl(view), explanation: '', labels: '', reason });
    expect(emptied.ok && emptied.body).toMatchObject({ explanation: '', labels: [] });
  });
});

describe('a run instant and margin as svc-ledger signs them', () => {
  it('blank runs now; a typed UTC time becomes the ISO text svc-ledger hashes', () => {
    expect(runInstant('')).toBe('now');
    expect(runInstant('2026-10-23T06:30')).toBe('2026-10-23T06:30:00.000Z');
    expect(runInstant('2026-10-23T06:30:15')).toBe('2026-10-23T06:30:15.000Z');
    expect(runInstant('yesterday')).toBeNull();
    expect(runInstant('2026-13-40T06:30')).toBeNull();
    // An impossible day is refused, never rolled over into another instant both founders would sign.
    expect(runInstant('2026-02-30T00:00')).toBeNull();
    expect(runInstant('2026-10-23T24:00')).toBeNull();
  });
  it('a run now has no margin; a past run takes the typed margin, else the control’s, else none (ops.control_margin_unset)', () => {
    const past = '2026-10-23T06:30:00.000Z';
    expect(runMargin('now', '30', controlView())).toBe('unset');
    expect(runMargin(past, '0', controlView())).toBe('0');
    expect(runMargin(past, '', controlView({ margin: { status: 'set', value: '120' } }))).toBe('120');
    expect(runMargin(past, '', controlView())).toBeNull();
    expect(runMargin(past, '-5', controlView())).toBeNull();
  });
});

describe('reading svc-ledger', () => {
  it('a list and a run are accepted only in the contract’s shape', () => {
    expect(parseControlList({ controls: [controlView()] })).toHaveLength(1);
    expect(parseControlList({ controls: [{ ...controlView(), version: 0 }] })).toBeNull();
    expect(parseControlList({})).toBeNull();
    expect(parseControlRun(runView())).not.toBeNull();
    expect(parseControlRun({ ...runView(), status: 'GREEN' })).toBeNull();
  });
  it('a run says its status and each source’s as-of, with an outside side that is unset', () => {
    const line = describeRun(runView({ outsideSide: 'unset' }));
    expect(line).toContain('PASS');
    expect(line).toContain('ledger as of 2026-10-24T06:00:00.000Z');
    expect(line).toContain('outside unset');
    expect(line).toContain('Outside side: unset');
  });
  it('a run lists each asset’s evidence, and an ERROR names its code and phase', () => {
    const fail = describeRun(
      runView({
        status: 'FAIL',
        assets: [{ assetId: 'USDT', observed: '5', expected: '100', difference: '-95', tolerance: '0' }],
      }),
    );
    expect(fail).toContain('FAIL');
    expect(fail).toContain('USDT: observed 5, expected 100, difference -95, tolerance 0.');
    const error = describeRun(
      runView({
        status: 'ERROR',
        errorCode: { status: 'set', value: 'ledger.read_failed' },
        phase: { status: 'set', value: 'read' },
        assets: [],
      }),
    );
    expect(error).toContain('Error: ledger.read_failed at read.');
  });
  it('a rail run with open items names each item and the residual that decided it', () => {
    const run = runView({
      status: 'FAIL',
      assets: [{ assetId: 'USDT', observed: '-7', expected: '-12', difference: '5', tolerance: '1', reconcilingItems: '3', residual: '2' }],
      reconcilingItems: [
        { source: 'svc-pay', id: 'dep-held-1', kind: 'held', assetId: 'USDT', amount: '4' },
        { source: 'svc-pay', id: 'dep-unfunded-1', kind: 'reversal_unfunded', assetId: 'USDT', amount: '-1' },
      ],
    });
    expect(parseControlRun(run)).not.toBeNull();
    const line = describeRun(run);
    expect(line).toContain('USDT: observed -7, expected -12, difference 5, tolerance 1, reconciling items 3, residual 2.');
    expect(line).toContain('2 reconciling items: held dep-held-1 USDT 4 (svc-pay). reversal_unfunded dep-unfunded-1 USDT -1 (svc-pay).');
    expect(describeRun(runView())).not.toContain('reconciling');
    // A long list names the first 20 and says how many more the run holds.
    const many = runView({
      status: 'PASS',
      reconcilingItems: Array.from({ length: 23 }, (_, i) => ({
        source: 'svc-pay',
        id: `dep-${i}`,
        kind: 'held',
        assetId: 'USDT',
        amount: '1',
      })),
    });
    const long = describeRun(many);
    expect(long).toContain('23 reconciling items:');
    expect(long).toContain('held dep-19 USDT 1 (svc-pay).');
    expect(long).not.toContain('dep-20 ');
    expect(long).toContain('And 3 more on the run.');
  });
  it('schedules are UTC and a dynamic account set says it is matched at each run', () => {
    expect(describeSchedule(controlView())).toBe('Daily at 06:30 UTC');
    expect(describeSchedule(controlView({ schedule: { status: 'unset' } }))).toBe('Not set');
    expect(describeAccountSet(controlView())).toBe('Every account with asset USDT, matched at each run');
    expect(describeAccountSet(controlView({ accountSet: { mode: 'all' } }))).toBe('The whole book');
  });
  it('every control refusal is in words', () => {
    for (const code of [
      'ops.control_policy_unset',
      'ops.control_margin_unset',
      'ledger.reconcile_asof_invalid',
      'ledger.reconcile_builtin_immutable',
    ])
      expect(controlRefusal(code, 412)).not.toContain('refused (412)');
    expect(controlRefusal('something.else', 418)).toBe('The step was refused (418).');
  });
});

describe('pause, resume and retire', () => {
  const REASON_LC = 'LOCAL TEST pause while the rail is down';
  it('offers only the moves svc-ledger accepts from each state, and none on a built-in', () => {
    expect(lifecycleMoves(controlView({ state: 'draft' }))).toEqual(['retire']);
    expect(lifecycleMoves(controlView({ state: 'active' }))).toEqual(['pause', 'retire']);
    expect(lifecycleMoves(controlView({ state: 'paused' }))).toEqual(['resume', 'retire']);
    expect(lifecycleMoves(controlView({ state: 'retired' }))).toEqual([]);
    expect(lifecycleMoves(controlView({ builtin: true }))).toEqual([]);
  });
  it('a move travels alone, and only with the two-founder approval it spends', () => {
    const base = { controlId: CONTROL_ID, reason: REASON_LC, lifecycle: 'pause' } as const;
    expect(updateReconciliationControlInputSchema.safeParse({ ...base, approvalId: 'a', operationId: 'o' }).success).toBe(true);
    expect(updateReconciliationControlInputSchema.safeParse(base).success).toBe(false);
    expect(updateReconciliationControlInputSchema.safeParse({ ...base, approvalId: 'a', operationId: 'o', activate: true }).success).toBe(
      false,
    );
    // A key present with no value is not a second field.
    expect(
      updateReconciliationControlInputSchema.safeParse({ ...base, approvalId: 'a', operationId: 'o', severity: undefined }).success,
    ).toBe(true);
    // Approval ids never ride on an ordinary edit.
    expect(
      updateReconciliationControlInputSchema.safeParse({ controlId: CONTROL_ID, reason: REASON_LC, severity: 'info', approvalId: 'a' })
        .success,
    ).toBe(false);
  });
});
