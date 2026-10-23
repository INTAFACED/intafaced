import { createServer, type AddressInfo } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  OPS_ACTIVE_TIME_UNSET,
  OPS_ALERT_DEFAULT_CONTACT_UNSET,
  OPS_FLAP_SUPPRESSION_UNSET,
  OPS_GROUP_TIMING_UNSET,
  OPS_MATCHER_INVALID,
  OPS_MUTE_TIMING_UNSET,
} from '../codes.js';
import { createMemoryNotify } from './notify-store.js';
import { groupDecision, matchersHold, parseRoute, resolveRoute, timingOf, timingReady, windowCovers } from './notify.js';
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

  it('refuses a blank flap or mute window and does not invent a duration', () => {
    expect(() => timingOf({ flapSeconds: 0 })).toThrow(expect.objectContaining({ code: OPS_FLAP_SUPPRESSION_UNSET }));
    expect(() => parseRoute({ defaultContactId: 'ops-desk', mute: { days: [] } })).toThrow(
      expect.objectContaining({ code: OPS_MUTE_TIMING_UNSET }),
    );
    expect(() => parseRoute({ defaultContactId: 'ops-desk', active: { location: 'Not/AZone' } })).toThrow(
      expect.objectContaining({ code: OPS_ACTIVE_TIME_UNSET }),
    );
    const mute = { days: [1], months: [1], years: [2026], start: '00:00', end: '01:00', location: 'UTC' };
    const active = { days: [23], months: [10], years: [2026], start: '00:00', end: '23:59', location: 'UTC' };
    const ready = { groupBy: ['team'], groupWaitSeconds: 30, groupIntervalSeconds: 60, repeatSeconds: 120, flapSeconds: 15 };
    expect(groupDecision({ timing: timingOf(ready), mute: null, active, silenceId: null, now: '2026-10-23T00:00:00.000Z' }).outcome).toBe(
      'refused',
    );
    expect(groupDecision({ timing: timingOf(ready), mute, active, silenceId: 'quiet', now: '2026-10-23T00:00:00.000Z' })).toMatchObject({
      outcome: 'suppressed',
      suppressed: { kind: 'silence', id: 'quiet' },
    });
    expect(windowCovers(active, '2026-10-23T00:00:00.000Z', OPS_ACTIVE_TIME_UNSET)).toBe(true);
    expect(windowCovers({ ...active, start: '22:00', end: '06:00' }, '2026-10-23T23:00:00.000Z', OPS_ACTIVE_TIME_UNSET)).toBe(true);
    expect(windowCovers({ ...active, start: '22:00', end: '06:00' }, '2026-10-23T12:00:00.000Z', OPS_ACTIVE_TIME_UNSET)).toBe(false);
  });
});

describe('alert send claim', () => {
  it('posts a webhook once when two sends share an idempotency key', async () => {
    const previous = process.env.OPS_ALERT_CHANNEL_KEY;
    process.env.OPS_ALERT_CHANNEL_KEY = 'notify-test-key';
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push(Buffer.concat(chunks).toString('utf8'));
        setTimeout(() => {
          res.writeHead(204);
          res.end();
        }, 50);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const store = createMemoryNotify();
      const at = '2026-10-23T00:00:00.000Z';
      await store.saveContact({
        id: 'hook-desk',
        name: 'Hook',
        integrations: [{ id: 'hook', kind: 'webhook', url: `http://127.0.0.1:${port}/hook`, secret: 'signing-secret' }],
        key: 'contact-key-01',
        actor: 'operator-1',
        reason: 'add hook',
        at,
      });
      const input = {
        contactId: 'hook-desk',
        integrationId: 'hook',
        key: 'test-key-0009',
        actor: 'operator-1',
        reason: 'try hook',
        at,
      };
      const [first, second] = await Promise.all([store.testChannel(input), store.testChannel(input)]);
      expect(first).toEqual(second);
      expect(seen).toHaveLength(1);
      const replay = await store.testChannel(input);
      expect(replay).toEqual(first);
      expect(seen).toHaveLength(1);
    } finally {
      server.close();
      if (previous === undefined) delete process.env.OPS_ALERT_CHANNEL_KEY;
      else process.env.OPS_ALERT_CHANNEL_KEY = previous;
    }
  });
});
