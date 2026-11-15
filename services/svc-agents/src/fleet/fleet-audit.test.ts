import { describe, expect, it } from 'vitest';
import { fleetKey, requestIdOf } from './control.js';

describe('the fleet audit log read (AG-registry-01, AG-control-02)', () => {
  it('reads the request id back out of a business key, colons in the request id included', () => {
    const operator = '44444444-4444-4444-8444-444444444444';
    expect(requestIdOf(fleetKey('export', operator, 'agents-fleet:export:abc'), 'export', operator)).toBe('agents-fleet:export:abc');
    expect(requestIdOf(fleetKey('restore_request', operator, 'r1-xyz'), 'restore_request', operator)).toBe('r1-xyz');
  });

  it('keeps a key of another shape whole, never a guessed id', () => {
    expect(requestIdOf('agents:fleet:export:someone-else:r1', 'export', 'me')).toBe('agents:fleet:export:someone-else:r1');
  });
});
