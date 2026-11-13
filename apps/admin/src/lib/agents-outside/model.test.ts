import { describe, expect, it } from 'vitest';
import { parseOutsideAction } from './model';

const KEY = '33333333-3333-4333-8333-333333333333';

describe('parseOutsideAction (J-agents-21 #15)', () => {
  it('takes the two reads and a quarantine with a key, a reason and a request id', () => {
    expect(parseOutsideAction({ action: 'connections' })).toEqual({ action: 'connections' });
    expect(parseOutsideAction({ action: 'audit' })).toEqual({ action: 'audit' });
    expect(
      parseOutsideAction({ action: 'quarantine', keyId: KEY.toUpperCase(), reason: ' TEST why ', requestId: 'agents-outside:q:1' }),
    ).toEqual({
      action: 'quarantine',
      keyId: KEY,
      reason: 'TEST why',
      requestId: 'agents-outside:q:1',
    });
  });

  it('a reason under 3 characters is null, so it is refused before identity revokes anything', () => {
    expect(parseOutsideAction({ action: 'quarantine', keyId: KEY, reason: 'ab', requestId: 'agents-outside:q:1' })).toMatchObject({
      reason: null,
    });
  });

  it('passes a missing reason on as null, so the services refuse it by their own code', () => {
    expect(parseOutsideAction({ action: 'quarantine', keyId: KEY, reason: '  ', requestId: 'agents-outside:q:1' })).toMatchObject({
      reason: null,
    });
  });

  it('refuses anything else', () => {
    expect(parseOutsideAction(null)).toBeNull();
    expect(parseOutsideAction({ action: 'restore', keyId: KEY, requestId: 'agents-outside:q:1' })).toBeNull();
    expect(parseOutsideAction({ action: 'quarantine', keyId: 'nope', requestId: 'agents-outside:q:1' })).toBeNull();
    expect(parseOutsideAction({ action: 'quarantine', keyId: KEY, requestId: 'x'.repeat(129) })).toBeNull();
  });
});
