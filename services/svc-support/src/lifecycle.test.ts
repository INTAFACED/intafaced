import { describe, expect, it } from 'vitest';
import type { SupportTicketStatus } from '@intafaced/contracts';
import { TICKET_TRANSITIONS, checkTransition, isTerminal } from './lifecycle.js';

const ALL: readonly SupportTicketStatus[] = ['open', 'pending', 'on_hold', 'resolved', 'closed'];

describe('ticket lifecycle', () => {
  it('closed is terminal — nothing follows it', () => {
    expect(isTerminal('closed')).toBe(true);
    expect(TICKET_TRANSITIONS.closed).toEqual([]);
    for (const to of ALL) {
      // Including closed → closed, which is refused as `same_status`.
      expect(checkTransition('closed', to).status).toBe('refuse');
    }
  });

  it('no status may transition to itself', () => {
    for (const s of ALL) {
      const check = checkTransition(s, s);
      expect(check).toEqual({ status: 'refuse', reason: 'same_status' });
    }
  });

  it('resolved may be reopened — a user saying "not fixed" needs the same ticket', () => {
    expect(checkTransition('resolved', 'open')).toEqual({ status: 'ok' });
  });

  it('the legal moves are exactly the table, and the table is not everything', () => {
    // The point of this assertion is that a future edit widening the table has
    // to change a number here. A transition set that quietly became "anything
    // goes" would pass every other test in this file.
    const legal = ALL.flatMap((from) => (TICKET_TRANSITIONS[from] ?? []).map((to) => `${from}->${to}`));
    expect(legal.sort()).toEqual(
      [
        'open->pending',
        'open->on_hold',
        'open->resolved',
        'open->closed',
        'pending->open',
        'pending->on_hold',
        'pending->resolved',
        'pending->closed',
        'on_hold->open',
        'on_hold->pending',
        'on_hold->resolved',
        'on_hold->closed',
        'resolved->open',
        'resolved->closed',
      ].sort(),
    );
    // 5 statuses × 5 targets = 25 pairs; 14 legal means 11 refused.
    const refused = ALL.flatMap((from) => ALL.map((to) => checkTransition(from, to))).filter((c) => c.status === 'refuse');
    expect(refused).toHaveLength(11);
  });

  it('refusals carry a code, not a sentence', () => {
    // Asserted on the CODE so rewording a message can never turn a red test
    // green — and so a caller can branch on it.
    expect(checkTransition('closed', 'open')).toEqual({ status: 'refuse', reason: 'illegal' });
    expect(checkTransition('open', 'open')).toEqual({ status: 'refuse', reason: 'same_status' });
  });
});
