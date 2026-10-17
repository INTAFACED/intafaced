import { describe, expect, it } from 'vitest';
import {
  adjudicationOutcome,
  checkAdjudication,
  detectorLines,
  parseDetectors,
  parseSurveillanceCases,
  surveillanceEmptyText,
} from './surveillance-model';

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

describe('detector state', () => {
  const off = (reason: string) => ({ enabled: false, gap: 'detector_gap', reason, threshold: null });
  const block = { spoofing: off('spoofing'), layering: off('layering') };
  it('reads the block svc-matching sends', () => {
    expect(parseDetectors(block)).toEqual({
      spoofing: { enabled: false, gap: 'detector_gap' },
      layering: { enabled: false, gap: 'detector_gap' },
    });
    expect(parseDetectors({ spoofing: { enabled: true, gap: null }, layering: { enabled: true } })).toEqual({
      spoofing: { enabled: true, gap: null },
      layering: { enabled: true, gap: null },
    });
  });
  it('is unknown (null) for a missing or garbage block, never on', () => {
    for (const bad of [
      undefined,
      null,
      'x',
      [],
      {},
      { spoofing: off('spoofing') },
      { spoofing: { enabled: 'yes' }, layering: block.layering },
    ])
      expect(parseDetectors(bad)).toBeNull();
  });
  it('the empty text names the off or unknown detectors and never says only "no open cases"', () => {
    const offText = surveillanceEmptyText(parseDetectors(block));
    expect(offText).toContain('spoofing and layering detectors are off');
    expect(offText).toContain('not a sign that there is no spoofing and layering');
    expect(surveillanceEmptyText(null)).toContain('unknown');
    expect(surveillanceEmptyText(null)).toContain('not a sign');
    const one = surveillanceEmptyText({ spoofing: { enabled: true, gap: null }, layering: { enabled: false, gap: 'detector_gap' } });
    expect(one).toContain('layering detector is off');
    expect(detectorLines(parseDetectors(block))).toHaveLength(2);
  });
  it('only both detectors on gives the plain empty sentence', () => {
    const on = { enabled: true, gap: null };
    expect(detectorLines({ spoofing: on, layering: on })).toEqual([]);
    expect(surveillanceEmptyText({ spoofing: on, layering: on })).toBe('The matching engine reports no open cases.');
  });
});
