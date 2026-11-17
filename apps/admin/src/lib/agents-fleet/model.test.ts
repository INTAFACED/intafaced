import { describe, expect, it } from 'vitest';
import { filterWords, parseFleetAction } from './model';

describe('the agent fleet desk route body (AG-registry-01, AG-control-02)', () => {
  it('takes an audit log read with nothing else', () => {
    expect(parseFleetAction({ action: 'audit' })).toEqual({ action: 'audit' });
  });

  it('still refuses a switch without its request id or reference', () => {
    expect(parseFleetAction({ action: 'restore', ref: 'own:x' })).toBeNull();
    expect(parseFleetAction({ action: 'restore', requestId: 'agents-fleet:restore:1' })).toBeNull();
  });

  it('names an export filter as the desk shows it', () => {
    expect(filterWords({})).toBe('All agents');
    expect(filterWords({ riskSignal: 'no_owner' })).toBe('Risk signal: Enabled with no owner');
    expect(filterWords({ riskSignal: 'no_such' })).toBe('riskSignal: no_such');
  });
});
