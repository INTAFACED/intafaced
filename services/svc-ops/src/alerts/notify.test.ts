import { createServer, type AddressInfo } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  OPS_ACTIVE_TIME_UNSET,
  OPS_ALERT_DEFAULT_CONTACT_UNSET,
  OPS_FLAP_SUPPRESSION_UNSET,
  OPS_GROUP_TIMING_UNSET,
  OPS_MATCHER_INVALID,
  OPS_MUTE_TIMING_UNSET,
  OPS_ALERT_CHANNEL_KEY_UNSET,
  OPS_CHANNEL_TARGET_UNSET,
  OPS_IDEMPOTENCY_CONFLICT,
} from '../codes.js';
import { assertChannelTarget, refusedAddress } from './channel-target.js';
import { VENDOR_EMAIL } from '@intafaced/contracts';
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

describe('alert routing tree walk (review fixes)', () => {
  it('lets a child that stops end only its own siblings, not the parent siblings', () => {
    const tree = parseRoute({
      defaultContactId: 'ops-desk',
      policies: [
        {
          id: 'p1',
          matchers: [{ label: 'team', op: 'eq', value: 'ops' }],
          continue: true,
          contactId: 'p1-contact',
          children: [{ id: 'c', matchers: [{ label: 'env', op: 'eq', value: 'test' }], continue: false, contactId: 'c-contact' }],
        },
        { id: 'p2', matchers: [{ label: 'team', op: 'eq', value: 'ops' }], continue: false, contactId: 'pager' },
      ],
    });
    expect(resolveRoute(tree, labels).policyIds).toEqual(['p1', 'c', 'p2']);
    expect(resolveRoute(tree, labels).contacts).toContain('pager');
  });

  it('gives an inheriting child its parent timing, not the root timing', () => {
    const parentTiming = { groupBy: ['team'], groupWaitSeconds: 30, groupIntervalSeconds: 60, repeatSeconds: 3600, flapSeconds: 15 };
    const tree = parseRoute({
      defaultContactId: 'ops-desk',
      policies: [
        {
          id: 'parent',
          matchers: [{ label: 'team', op: 'eq', value: 'ops' }],
          continue: false,
          inheritTiming: false,
          ...parentTiming,
          children: [{ id: 'child', matchers: [{ label: 'env', op: 'eq', value: 'test' }], continue: false }],
        },
      ],
    });
    const hit = resolveRoute(tree, labels);
    expect(hit.policyIds).toEqual(['parent', 'child']);
    expect(hit.timing.groupWaitSeconds).toBe(30);
    expect(timingReady(hit.timing)).toBe(true);
  });
});

describe('alert channel target', () => {
  it('refuses private, loopback and metadata addresses outside dev and test', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(refusedAddress(ip, false)).toBe(true);
    }
    expect(refusedAddress('93.184.216.34', false)).toBe(false);
    expect(refusedAddress('127.0.0.1', true)).toBe(false);
    expect(refusedAddress('10.0.0.5', true)).toBe(true);
    expect(() => assertChannelTarget(new URL('http://169.254.169.254/latest/meta-data/'), false)).toThrow(
      expect.objectContaining({ code: OPS_CHANNEL_TARGET_UNSET }),
    );
    expect(() => assertChannelTarget(new URL('https://svc-ledger.internal/'), false)).toThrow(
      expect.objectContaining({ code: OPS_CHANNEL_TARGET_UNSET }),
    );
    expect(() => assertChannelTarget(new URL('https://[fd00::1]/hook'), false)).toThrow(
      expect.objectContaining({ code: OPS_CHANNEL_TARGET_UNSET }),
    );
    expect(() => assertChannelTarget(new URL('https://hooks.example.com/x'), false)).not.toThrow();
  });
});

describe('alert desk idempotency (review fixes)', () => {
  const at = '2026-10-23T00:00:00.000Z';
  const who = { actor: 'operator-1', reason: 'review fix', at };

  it('refuses a key another desk action already used with a typed conflict', async () => {
    const store = createMemoryNotify();
    await store.saveContact({
      id: 'desk',
      name: 'Desk',
      integrations: [{ id: 'mail', kind: 'email', address: 'ops@example.test' }],
      key: 'shared-key-01',
      ...who,
    });
    await expect(
      store.createSilence({
        id: 'quiet',
        matchers: [{ label: 'team', op: 'eq', value: 'ops' }],
        endsAt: '2026-10-24T00:00:00.000Z',
        key: 'shared-key-01',
        ...who,
      }),
    ).rejects.toMatchObject({ code: OPS_IDEMPOTENCY_CONFLICT });
    expect(await store.getSilence('quiet')).toBeNull();
  });

  it('replays a grouped send under its key after a silence starts', async () => {
    const store = createMemoryNotify();
    await store.saveContact({
      id: 'desk',
      name: 'Desk',
      integrations: [{ id: 'mail', kind: 'email', address: 'ops@example.test' }],
      key: 'contact-key-02',
      ...who,
    });
    await store.saveRoute({
      defaultContactId: 'desk',
      groupBy: ['team'],
      groupWaitSeconds: 30,
      groupIntervalSeconds: 60,
      repeatSeconds: 120,
      flapSeconds: 15,
      active: { days: [23], months: [10], years: [2026], start: '00:00', end: '23:59', location: 'UTC' },
      mute: { days: [1], months: [1], years: [2026], start: '00:00', end: '01:00', location: 'UTC' },
      policies: [],
      key: 'route-key-0002',
      ...who,
    });
    const input = { ruleId: 'rule-1', labels, key: 'group-key-0002', ...who };
    const first = await store.groupingSend(input);
    expect(first).toMatchObject({ code: VENDOR_EMAIL, suppressed: null });
    await store.createSilence({
      id: 'quiet',
      matchers: [{ label: 'team', op: 'eq', value: 'ops' }],
      endsAt: '2026-10-24T00:00:00.000Z',
      key: 'silence-key-02',
      ...who,
    });
    expect(await store.groupingSend(input)).toEqual(first);
  });

  it('refuses a blank channel key with its own code, not as a failed delivery', async () => {
    const previous = process.env.OPS_ALERT_CHANNEL_KEY;
    process.env.OPS_ALERT_CHANNEL_KEY = 'notify-test-key';
    const store = createMemoryNotify();
    try {
      await store.saveContact({
        id: 'hook-desk',
        name: 'Hook',
        integrations: [{ id: 'hook', kind: 'webhook', url: 'http://127.0.0.1:9/hook', secret: 'signing-secret' }],
        key: 'contact-key-03',
        ...who,
      });
      delete process.env.OPS_ALERT_CHANNEL_KEY;
      const input = { contactId: 'hook-desk', integrationId: 'hook', key: 'test-key-0003', ...who };
      await expect(store.testChannel(input)).rejects.toMatchObject({ code: OPS_ALERT_CHANNEL_KEY_UNSET });
      expect(await store.attempts('hook-desk', 10)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.OPS_ALERT_CHANNEL_KEY;
      else process.env.OPS_ALERT_CHANNEL_KEY = previous;
    }
  });
});
