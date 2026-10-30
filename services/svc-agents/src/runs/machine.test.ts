import { describe, expect, it } from 'vitest';
import { RUN_STATES, RunTransitionError, assertMove, canMove, type RunState } from './machine.js';

describe('run state machine (ENGINE RS-2)', () => {
  const allowed: Array<[RunState, RunState]> = [
    ['admitted', 'running'],
    ['admitted', 'refused'],
    ['admitted', 'failed'],
    ['running', 'waiting_approval'],
    ['running', 'completed'],
    ['running', 'refused'],
    ['running', 'failed'],
    ['waiting_approval', 'running'],
    ['waiting_approval', 'refused'],
    ['waiting_approval', 'failed'],
    ['refused', 'running'],
    ['failed', 'running'],
  ];

  it('allows exactly the RS-2 moves and refuses every other pair with agents.run_transition_invalid', () => {
    const key = (from: RunState, to: RunState) => `${from}->${to}`;
    const yes = new Set(allowed.map(([from, to]) => key(from, to)));
    const refused: string[] = [];
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        expect(canMove(from, to)).toBe(yes.has(key(from, to)));
        if (yes.has(key(from, to))) {
          expect(() => assertMove(from, to)).not.toThrow();
        } else {
          refused.push(key(from, to));
          expect(() => assertMove(from, to)).toThrow(expect.objectContaining({ code: 'agents.run_transition_invalid', from, to }));
        }
      }
    }
    expect(refused).toHaveLength(RUN_STATES.length ** 2 - allowed.length);
  });

  it('keeps a completed run final and never moves back to admitted', () => {
    for (const to of RUN_STATES) expect(canMove('completed', to)).toBe(false);
    for (const from of RUN_STATES) expect(canMove(from, 'admitted')).toBe(false);
    const err = (() => {
      try {
        assertMove('completed', 'running');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(RunTransitionError);
    expect((err as RunTransitionError).message).toBe('agents.run_transition_invalid');
  });
});
