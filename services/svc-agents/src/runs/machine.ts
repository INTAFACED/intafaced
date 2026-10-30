/**
 * The run state machine (AG-sessions-01, ENGINE RS-2). A run is admitted before anything runs, then runs, and ends
 * completed, refused or failed; a run may wait for an approval in between. A failed or refused run billed nothing, so
 * the same request id may run it again (RS-4); a completed run is final. Any other move is refused with
 * `agents.run_transition_invalid`.
 */

export const RUN_STATES = ['admitted', 'running', 'waiting_approval', 'completed', 'refused', 'failed'] as const;
export type RunState = (typeof RUN_STATES)[number];

const MOVES: Readonly<Record<RunState, readonly RunState[]>> = {
  admitted: ['running', 'refused', 'failed'],
  running: ['waiting_approval', 'completed', 'refused', 'failed'],
  waiting_approval: ['running', 'refused', 'failed'],
  completed: [],
  refused: ['running'],
  failed: ['running'],
};

export class RunTransitionError extends Error {
  readonly code = 'agents.run_transition_invalid' as const;
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super('agents.run_transition_invalid');
    this.name = 'RunTransitionError';
  }
}

export function canMove(from: RunState, to: RunState): boolean {
  return MOVES[from].includes(to);
}

/** Throws `agents.run_transition_invalid` for a move RS-2 does not allow. */
export function assertMove(from: RunState, to: RunState): void {
  if (!canMove(from, to)) throw new RunTransitionError(from, to);
}
