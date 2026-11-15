import { describe, expect, it } from 'vitest';
import { parseRoutesAction, rateOf, routeSay } from './model';

const CHANGE = '11111111-1111-4111-8111-111111111111';

describe('the routing table desk’s route body (J-agents-20)', () => {
  it('passes a proposal with its ceiling, both rates and its request id; blank rates are "not set"', () => {
    const body = {
      action: 'propose',
      task: 'index.embed',
      maxOutputTokens: 2,
      inputPerMillion: '0.1',
      outputPerMillion: '0',
      requestId: 'agents-routes:x:1',
    };
    expect(parseRoutesAction(body)).toEqual({ ...body });
    expect(parseRoutesAction({ ...body, inputPerMillion: '', outputPerMillion: ' ' })).toMatchObject({
      inputPerMillion: null,
      outputPerMillion: null,
    });
  });

  it('refuses a rate that is not an unsigned decimal, a fractional ceiling, a bad task or request id', () => {
    const body = {
      action: 'propose',
      task: 'index.embed',
      maxOutputTokens: 2,
      inputPerMillion: '1',
      outputPerMillion: '1',
      requestId: 'agents-routes:x:1',
    };
    expect(parseRoutesAction({ ...body, inputPerMillion: '-1' })).toBeNull();
    expect(parseRoutesAction({ ...body, inputPerMillion: 1 })).toBeNull();
    expect(parseRoutesAction({ ...body, maxOutputTokens: 1.5 })).toBeNull();
    expect(parseRoutesAction({ ...body, task: 'a b' })).toBeNull();
    expect(parseRoutesAction({ ...body, requestId: 'short' })).toBeNull();
  });

  it('withdraw and confirm take a change id; anything else is refused', () => {
    expect(parseRoutesAction({ action: 'confirm', changeId: CHANGE })).toEqual({ action: 'confirm', changeId: CHANGE });
    expect(parseRoutesAction({ action: 'withdraw', changeId: 'nope' })).toBeNull();
    expect(parseRoutesAction({ action: 'drop' })).toBeNull();
    expect(parseRoutesAction(null)).toBeNull();
  });

  it('says each refusal in words with its code', () => {
    expect(routeSay('agents.route_change_same_founder')).toBe(
      'You asked for this change. A second founder confirms it. (agents.route_change_same_founder)',
    );
    expect(rateOf('1.250')).toBe('1.250');
  });
});
