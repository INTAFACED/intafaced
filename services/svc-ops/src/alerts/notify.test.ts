import { describe, expect, it } from 'vitest';
import { matchersHold, parseRoute, resolveRoute, timingOf, timingReady } from './notify.js';
import { OPS_ALERT_DEFAULT_CONTACT_UNSET, OPS_GROUP_TIMING_UNSET, OPS_MATCHER_INVALID } from '../codes.js';
import { OpsError } from '../codes.js';

const labels = { team: 'ops', env: 'test' };

describe('alert routing matchers', () => {
  it('sends an unmatched alert to the default contact', () => {
    const tree = parseRoute({
      defaultContactId: 'ops-desk',
      policies: [{ id: 'pay', matchers: [{ label: 'team', op: 'eq', value: 'pay' }], continue: false }],
    });
    expect(resolveRoute(tree, labels).contacts).toEqual(['ops-desk']);
    expect(resolveRoute(tree, labels).policyIds).toEqual([]);
  });

  it('uses the deepest matching policy', () => {
    const tree = parseRoute({
      defaultContactId: 'ops-desk',
      policies: [
        {
          id: 'ops',
          matchers: [{ label: 'team', op: 'eq', value: 'ops' }],
          continue: false,
          contactId: 'ops-contact',
          children: [{ id: 'test', matchers: [{ label: 'env', op: 'eq', value: 'test' }], continue: false, contactId: 'test-contact' }],
        },
      ],
    });
    expect(resolveRoute(tree, labels).primaryContact).toBe('test-contact');
  });

  it('refuses a blank default contact and a zero wait', () => {
    expect(() => parseRoute({ policies: [] })).toThrow(expect.objectContaining({ code: OPS_ALERT_DEFAULT_CONTACT_UNSET }));
    expect(() => timingOf({ groupWaitSeconds: 0 })).toThrow(OpsError);
    expect(() => timingOf({ groupWaitSeconds: 0 })).toThrow(expect.objectContaining({ code: OPS_GROUP_TIMING_UNSET }));
    expect(timingReady(timingOf({}))).toBe(false);
  });

  it('refuses a matcher that is not a label match', () => {
    expect(() =>
      parseRoute({
        defaultContactId: 'ops-desk',
        policies: [{ id: 'bad', matchers: [{ label: 'Team', op: 'eq', value: 'ops' }], continue: false }],
      }),
    ).toThrow(expect.objectContaining({ code: OPS_MATCHER_INVALID }));
    expect(matchersHold([{ label: 'team', op: 'neq', value: 'pay' }], labels)).toBe(true);
    expect(matchersHold([{ label: 'team', op: 'match', value: 'o*' }], labels)).toBe(true);
  });
});
