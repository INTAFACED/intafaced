import { describe, expect, it } from 'vitest';
import { decodeRunExecute } from './reconciliation-run';
import { CONTROL_ID, runView } from './reconciliation-fixtures.test-util';

describe('a run’s answer', () => {
  it('2xx counts only when it is a run of the control asked for', () => {
    expect(decodeRunExecute({ reached: true, status: 200, body: runView() }, CONTROL_ID)).toMatchObject({ ok: true });
    const other = decodeRunExecute(
      { reached: true, status: 200, body: runView({ controlId: '11111111-1111-4111-8111-111111111111' }) },
      CONTROL_ID,
    );
    expect(other).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    expect(decodeRunExecute({ reached: true, status: 200, body: { ok: true } }, CONTROL_ID)).toMatchObject({
      ok: false,
      refusal: { changed: 'unknown' },
    });
  });
  it('svc-ledger’s typed refusals are definite and keep their code', () => {
    for (const code of [
      'ops.control_margin_unset',
      'ledger.reconcile_asof_invalid',
      'ops.control_state_illegal',
      'ledger.idempotency_conflict',
    ]) {
      const reply = decodeRunExecute({ reached: true, status: 412, body: { message: code, code } }, CONTROL_ID);
      expect(reply).toMatchObject({ ok: false, refusal: { code, changed: 'no' } });
    }
  });
  it('identity’s approval refusal is read out of the message', () => {
    const reply = decodeRunExecute(
      {
        reached: true,
        status: 400,
        body: { message: 'approval not approved [action_approval.not_approved]', code: 'ledger.operator_request_failed' },
      },
      CONTROL_ID,
    );
    expect(reply).toMatchObject({ ok: false, refusal: { code: 'action_approval.not_approved' } });
  });
  it('sent with no answer is unknown; never sent is a definite no', () => {
    expect(decodeRunExecute({ reached: false, sent: true, detail: 'x' }, CONTROL_ID)).toMatchObject({
      ok: false,
      refusal: { changed: 'unknown' },
    });
    expect(decodeRunExecute({ reached: false, sent: false, detail: 'x' }, CONTROL_ID)).toMatchObject({
      ok: false,
      refusal: { code: 'admin.ledger_unconfigured', changed: 'no' },
    });
  });
});
