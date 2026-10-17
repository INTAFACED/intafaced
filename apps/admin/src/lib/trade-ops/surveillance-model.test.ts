import { describe, expect, it } from 'vitest';
import { adjudicationOutcome, checkAdjudication, parseSurveillanceCases } from './surveillance-model';

const ok = { caseId: 'c-1', decision: 'no_violation', rationale: 'orders were genuine, filled later' };

describe('surveillance cases', () => {
  it('reads svc-matching cases exactly as presented', () => {
    const row = { accountId: 'a-1', marketId: 'm-1', reason: 'spoofing: 12 cancels inside 2s', status: 'open' };
    expect(parseSurveillanceCases([row])).toEqual([row]);
    expect(parseSurveillanceCases([])).toEqual([]);
  });
  it('shows nothing rather than a guess when a row is not in that shape', () => {
    expect(parseSurveillanceCases({ cases: [] })).toBeNull();
    expect(parseSurveillanceCases([{ accountId: 'a-1', marketId: 'm-1', reason: 'x', status: 'closed' }])).toBeNull();
    expect(parseSurveillanceCases([null])).toBeNull();
  });
});

describe('surveillance law', () => {
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
  it('a valid decision ends in the adjudicate blocker, which names the real gap', () => {
    expect(adjudicationOutcome(ok)).toMatchObject({ kind: 'refused', blocker: { key: 'surveillance_adjudicate_not_exposed' } });
  });
});
