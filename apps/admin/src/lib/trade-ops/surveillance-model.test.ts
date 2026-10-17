import { describe, expect, it } from 'vitest';
import { adjudicationOutcome, checkAdjudication, readCasesOutcome } from './surveillance-model';

const ok = { caseId: 'c-1', decision: 'no_violation', rationale: 'orders were genuine, filled later' };

describe('surveillance law', () => {
  it('reading cases is the typed blocker', () => {
    expect(readCasesOutcome()).toMatchObject({ kind: 'refused', blocker: { key: 'surveillance_not_routed' } });
  });
  it('refuses automatic adjudication', () => {
    expect(checkAdjudication({ ...ok, auto: true })).toMatchObject({ ok: false, code: 'auto_adjudicate_forbidden' });
  });
  it('refuses any sanction or fine', () => {
    expect(checkAdjudication({ ...ok, fine: '100' })).toMatchObject({ ok: false, code: 'invented_sanction' });
    expect(checkAdjudication({ ...ok, sanction: 'ban' })).toMatchObject({ ok: false, code: 'invented_sanction' });
  });
  it('needs case, decision and rationale', () => {
    expect(checkAdjudication({ ...ok, caseId: '' })).toMatchObject({ code: 'surveillance.bad_case' });
    expect(checkAdjudication({ ...ok, decision: 'ban' })).toMatchObject({ code: 'surveillance.bad_decision' });
    expect(checkAdjudication({ ...ok, rationale: 'no' })).toMatchObject({ code: 'surveillance.bad_rationale' });
  });
  it('a valid decision ends in the typed blocker', () => {
    expect(adjudicationOutcome(ok)).toMatchObject({ kind: 'refused', blocker: { key: 'surveillance_not_routed' } });
  });
});
