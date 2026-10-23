// A sync group's study command: each chart applies it once, a chart that joins after it was issued never replays it.
import { describe, expect, it } from 'vitest';
import { joinedNonce, pendingCommand, type GroupCommands } from './group-commands';

const issued: GroupCommands = { blue: { kind: 'sma', nonce: 4 } };

describe('a group command', () => {
  it('a chart that joins a group after the command was issued counts it as applied, so it is not pending', () => {
    const applied = joinedNonce(issued, 'blue');
    expect(applied).toBe(4);
    expect(pendingCommand(issued.blue, applied)).toBeNull();
  });

  it('a chart not mounted when the command fired still owes it, until it applies it', () => {
    const applied = 2;
    expect(pendingCommand(issued.blue, applied)).toEqual({ kind: 'sma', nonce: 4 });
    expect(pendingCommand(issued.blue, 4)).toBeNull();
  });

  it('a new command is pending for every chart that has applied the one before', () => {
    const next: GroupCommands = { blue: { kind: 'rsi', nonce: 5 } };
    expect(pendingCommand(next.blue, 4)).toEqual({ kind: 'rsi', nonce: 5 });
  });

  it('a chart in no group, or in a group with no command, has nothing pending and joins at zero', () => {
    expect(joinedNonce(issued, null)).toBe(0);
    expect(joinedNonce(issued, 'green')).toBe(0);
    expect(pendingCommand(issued.green, 0)).toBeNull();
  });
});
