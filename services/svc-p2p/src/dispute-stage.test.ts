import { describe, expect, it } from 'vitest';
import {
  assertStage,
  canMoveStage,
  DISPUTE_STAGES,
  DisputeStageError,
  eventsFor,
  INITIAL_STAGE,
  stageDeadline,
  TERMINAL_STAGES,
  timedTransition,
  type DisputeEvent,
} from './dispute-stage.js';
import { TRADE_STATUSES } from './state.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DisputeStageError) return e.code;
    throw e;
  }
  return undefined;
}

const T0 = new Date('2026-10-22T00:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

describe('P-disputes-security-02 dispute stages', () => {
  it('stages sit beside trade status: TRADE_STATUSES gains no stage (only the shared word cancelled overlaps)', () => {
    expect(TRADE_STATUSES).toEqual(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']);
    const overlap = DISPUTE_STAGES.filter((s) => (TRADE_STATUSES as readonly string[]).includes(s));
    expect(overlap).toEqual(['cancelled']);
  });

  it('exhaustive: every pair either passes assertStage or refuses with a stage code', () => {
    for (const from of DISPUTE_STAGES) {
      for (const to of DISPUTE_STAGES) {
        const c = code(() => assertStage(from, to));
        if (TERMINAL_STAGES.has(from)) expect(c).toBe('p2p.dispute_resolved');
        else if (canMoveStage(from, to)) expect(c).toBeUndefined();
        else expect(c).toBe('p2p.invalid_stage');
      }
    }
  });

  it('edges are closed and terminal stages are immutable', () => {
    for (const t of TERMINAL_STAGES) for (const to of DISPUTE_STAGES) expect(canMoveStage(t, to)).toBe(false);
    for (const s of DISPUTE_STAGES) expect(canMoveStage(s, s)).toBe(false);
    expect(code(() => assertStage('under_review', 'released'))).toBe('p2p.invalid_stage');
    expect(code(() => assertStage('nope', 'under_review'))).toBe('p2p.invalid_stage');
  });

  it('every non-terminal stage can still reach resolved or cancelled', () => {
    for (const start of DISPUTE_STAGES) {
      const seen = new Set([start]);
      const q = [start];
      while (q.length) {
        const s = q.shift()!;
        for (const to of DISPUTE_STAGES) if (canMoveStage(s, to) && !seen.has(to)) (seen.add(to), q.push(to));
      }
      expect([...seen].some((s) => TERMINAL_STAGES.has(s))).toBe(true);
    }
  });

  it('open → counterparty_response with a deadline; response → under_review; invalid jump refused', () => {
    expect(INITIAL_STAGE).toBe('counterparty_response');
    expect(stageDeadline('counterparty_response', T0, { respondentWindowSeconds: 3600 })).toEqual(at(3600));
    expect(code(() => assertStage('counterparty_response', 'under_review'))).toBeUndefined();
    expect(code(() => assertStage('counterparty_response', 'resolved'))).toBe('p2p.invalid_stage');
  });

  it('blank or bad timer refuses p2p.config_unset; untimed stages have no deadline', () => {
    for (const v of [undefined, null, 0, -5, 1.5, NaN]) {
      expect(code(() => stageDeadline('counterparty_response', T0, { respondentWindowSeconds: v }))).toBe('p2p.config_unset');
    }
    expect(code(() => stageDeadline('providing_proof', T0, {}))).toBe('p2p.config_unset');
    expect(stageDeadline('under_review', T0, {})).toBeNull();
  });

  it('respondent window expires → under_review; nothing due before the deadline or on untimed stages', () => {
    expect(timedTransition('counterparty_response', at(60), at(59))).toBeNull();
    expect(timedTransition('counterparty_response', at(60), at(60))).toEqual({ from: 'counterparty_response', to: 'under_review' });
    expect(timedTransition('providing_proof', at(60), at(61))?.to).toBe('under_review');
    expect(timedTransition('under_review', at(60), at(61))).toBeNull();
    expect(timedTransition('counterparty_response', null, at(61))).toBeNull();
  });

  it('internal notes and unflagged events never reach a party; operators see all', () => {
    const ev = (id: string, kind: DisputeEvent['kind'], visibleToParties?: boolean): DisputeEvent => ({
      id,
      kind,
      at: T0,
      actor: 'm',
      visibleToParties,
    });
    const all = [
      ev('1', 'stage_changed', true),
      ev('2', 'note', true),
      ev('3', 'note'),
      ev('4', 'evidence_added'),
      ev('5', 'ruling', true),
    ];
    expect(eventsFor('party', all).map((e) => e.id)).toEqual(['1', '5']);
    expect(eventsFor('operator', all)).toHaveLength(5);
  });
});
