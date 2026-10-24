import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, postgresAvailable } from '@intafaced/db/testing';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { createPgAlertDesk } from './desk-store.js';
import { createPgNotify } from './notify-store.js';
import { OPS_IDEMPOTENCY_CONFLICT } from '../codes.js';
import { AlertEvaluator } from './runner.js';
import { createPgAlertRuleStore } from './rule-store.js';
import { AlertRules, fingerprintOf } from './rules.js';
import { createPgAlertState } from './state-store.js';
import {
  OPS_ACTIVE_TIME_UNSET,
  OPS_ALERT_DEFAULT_CONTACT_UNSET,
  OPS_CHANNEL_AUTH_CONFLICT,
  OPS_CONTACT_POINT_IN_USE,
  OPS_FLAP_SUPPRESSION_UNSET,
  OPS_GROUP_TIMING_UNSET,
  OPS_MUTE_TIMING_UNSET,
  OPS_SILENCE_END_UNSET,
  VENDOR_EMAIL,
} from '@intafaced/contracts';

const SECRET = 'a-ops-notify-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-23T00:00:00.000Z';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

function principal(): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

async function signed() {
  const raw = encodePrincipal(principal());
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-notify',
  });
}

const ruleDraft = {
  name: 'Ledger postings stalled',
  folder: 'ledger',
  group: 'every-minute',
  signal: 'ledger.postings.count',
  condition: { operator: 'gt' as const, threshold: '1' },
  intervalSeconds: 60,
  pendingSeconds: 0,
  labels: { team: 'ops' },
  reason: 'watch postings',
};

const available = await postgresAvailable();

if (!available) {
  describe.skip('alert notify (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('alert notify on real PostgreSQL', () => {
    it('routes to the default contact, mutes a firing alert, and refuses a blank or an in-use contact', async () => {
      const previous = process.env.OPS_ALERT_CHANNEL_KEY;
      process.env.OPS_ALERT_CHANNEL_KEY = 'notify-test-key';
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
      const seen: { body: string; signature: string | undefined }[] = [];
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          seen.push({ body: Buffer.concat(chunks).toString('utf8'), signature: req.headers['x-intafaced-signature']?.toString() });
          setTimeout(() => {
            res.writeHead(204);
            res.end();
          }, 80);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        await migrateOutreach(sql);
        const desk = createPgAlertDesk(sql);
        const caller = createOpsRouter(new OpsService(), undefined, {
          now: () => AT,
          alertDesk: desk,
          alertRules: new AlertRules(createPgAlertRuleStore(sql), () => AT, undefined, desk),
          alertState: createPgAlertState(sql),
        }).createCaller(await signed());
        await expect(caller.alertRules.routePolicy.save({ idempotencyKey: 'route-key-01', reason: 'no contact' })).rejects.toThrow(
          OPS_ALERT_DEFAULT_CONTACT_UNSET,
        );
        await caller.alertRules.contacts.save({
          id: 'ops-desk',
          name: 'Ops desk',
          integrations: [{ id: 'mail', kind: 'email', address: 'ops@example.com' }],
          reason: 'add mail',
          idempotencyKey: 'contact-key-01',
        });
        const masked = await caller.alertRules.contacts.save({
          id: 'hook-desk',
          name: 'Hook',
          integrations: [{ id: 'hook', kind: 'webhook', url: `http://127.0.0.1:${port}/hook`, secret: 'signing-secret' }],
          reason: 'add hook',
          idempotencyKey: 'contact-key-02',
        });
        expect(JSON.stringify(masked)).not.toContain('signing-secret');
        expect(masked.integrations[0]?.secret).toBe('********');
        const tree = await caller.alertRules.routePolicy.save({
          defaultContactId: 'ops-desk',
          policies: [{ id: 'hooks', matchers: [{ label: 'team', op: 'eq', value: 'hooks' }], continue: false, contactId: 'hook-desk' }],
          reason: 'default ops',
          idempotencyKey: 'route-key-02',
        });
        expect(tree.version).toBe(1);
        const again = await caller.alertRules.routePolicy.save({
          defaultContactId: 'ops-desk',
          policies: [{ id: 'hooks', matchers: [{ label: 'team', op: 'eq', value: 'hooks' }], continue: false, contactId: 'hook-desk' }],
          reason: 'default ops',
          idempotencyKey: 'route-key-02',
        });
        expect(again).toEqual(tree);
        expect((await caller.alertRules.routePolicy.resolve({ labels: { team: 'other' } })).contacts).toEqual(['ops-desk']);
        await expect(
          caller.alertRules.routePolicy.save({
            defaultContactId: 'ops-desk',
            groupWaitSeconds: 0,
            reason: 'zero',
            idempotencyKey: 'route-key-03',
          }),
        ).rejects.toThrow(OPS_GROUP_TIMING_UNSET);
        await expect(
          caller.alertRules.contacts.retire({ id: 'ops-desk', reason: 'remove', idempotencyKey: 'retire-key-01' }),
        ).rejects.toThrow(OPS_CONTACT_POINT_IN_USE);
        const rule = await caller.alertRules.create({ ...ruleDraft, idempotencyKey: 'alert-key-0009' });
        const evaluator = new AlertEvaluator({
          rules: createPgAlertRuleStore(sql),
          state: createPgAlertState(sql),
          signals: { read: async () => ({ status: 'ok', value: '5' }) },
          now: () => AT,
        });
        await evaluator.tick();
        await expect(
          caller.alertRules.silences.create({
            id: 'quiet',
            matchers: [{ label: 'team', op: 'eq', value: 'ops' }],
            reason: 'no end',
            idempotencyKey: 'silence-key-01',
          }),
        ).rejects.toThrow(OPS_SILENCE_END_UNSET);
        await caller.alertRules.silences.create({
          id: 'quiet',
          matchers: [{ label: 'team', op: 'eq', value: 'ops' }],
          endsAt: '2026-10-24T00:00:00.000Z',
          reason: 'mute ops',
          idempotencyKey: 'silence-key-02',
        });
        const preview = await caller.alertRules.silences.preview({ id: 'quiet', limit: 10 });
        expect(preview.active).toBe(true);
        expect(preview.endsAt).toBe('2026-10-24T00:00:00.000Z');
        expect(preview.alerts.map((row) => row.ruleId)).toEqual([rule.id]);
        expect(preview.truncated).toBe(false);
        await expect(
          caller.alertRules.contacts.test({
            contactId: 'ops-desk',
            integrationId: 'mail',
            reason: 'try mail',
            idempotencyKey: 'test-key-0001',
          }),
        ).rejects.toThrow(VENDOR_EMAIL);
        expect(await sql`SELECT code, notification_id FROM ops.alert_channel_attempts`).toEqual([
          expect.objectContaining({ code: VENDOR_EMAIL, notification_id: 'ops:notify:ops-desk:1' }),
        ]);
        await expect(
          caller.alertRules.contacts.test({
            contactId: 'ops-desk',
            integrationId: 'mail',
            reason: 'try mail',
            idempotencyKey: 'test-key-0001',
          }),
        ).rejects.toThrow(VENDOR_EMAIL);
        expect(await sql`SELECT notification_id FROM ops.alert_channel_attempts`).toHaveLength(1);
        await caller.alertRules.contacts.test({
          contactId: 'hook-desk',
          integrationId: 'hook',
          reason: 'try hook',
          idempotencyKey: 'test-key-0002',
        });
        expect(seen).toHaveLength(1);
        const expected = createHmac('sha256', 'signing-secret')
          .update(seen[0]?.body ?? '')
          .digest('hex');
        expect(seen[0]?.signature).toBe(expected);
        await caller.alertRules.contacts.test({
          contactId: 'hook-desk',
          integrationId: 'hook',
          reason: 'try hook',
          idempotencyKey: 'test-key-0002',
        });
        expect(seen).toHaveLength(1);
        await expect(
          caller.alertRules.contacts.save({
            id: 'both',
            name: 'Both',
            integrations: [{ id: 'mix', kind: 'webhook', url: 'http://127.0.0.1/hook', secret: 's', basicPassword: 'p', bearer: 'b' }],
            reason: 'conflict',
            idempotencyKey: 'contact-key-03',
          }),
        ).rejects.toThrow(OPS_CHANNEL_AUTH_CONFLICT);
        await expect(caller.alertRules.grouping.send({ ruleId: rule.id, reason: 'page', idempotencyKey: 'group-key-01' })).rejects.toThrow(
          OPS_GROUP_TIMING_UNSET,
        );
        expect(await sql`SELECT notification_id FROM ops.alert_notifications WHERE idempotency_key = 'group-key-01'`).toHaveLength(0);
        const [audit] = await sql<
          { actor: string; reason: string }[]
        >`SELECT actor, reason FROM ops.alert_notify_audit WHERE action = 'route.saved'`;
        expect(audit).toEqual({ actor: USER, reason: 'default ops' });
        const [event] = await sql<
          { idempotency_key: string }[]
        >`SELECT idempotency_key FROM ops.alert_outbox WHERE event = 'coreOpsAlertPolicyUpdated'`;
        expect(event?.idempotency_key).toBe('ops:alert-policy:1');
        const raced = await Promise.all([
          caller.alertRules.routePolicy.save({
            expectedVersion: 1,
            defaultContactId: 'ops-desk',
            policies: [{ id: 'hooks', matchers: [{ label: 'team', op: 'eq', value: 'hooks' }], continue: false, contactId: 'hook-desk' }],
            reason: 'same edit',
            idempotencyKey: 'route-key-04',
          }),
          caller.alertRules.routePolicy.save({
            expectedVersion: 1,
            defaultContactId: 'ops-desk',
            policies: [{ id: 'hooks', matchers: [{ label: 'team', op: 'eq', value: 'hooks' }], continue: false, contactId: 'hook-desk' }],
            reason: 'same edit',
            idempotencyKey: 'route-key-04',
          }),
        ]);
        expect(raced[0]).toEqual(raced[1]);
        expect(await sql`SELECT version FROM ops.alert_route_policy`).toEqual([{ version: 2 }]);
        const racedSend = await Promise.all([
          caller.alertRules.contacts.test({
            contactId: 'hook-desk',
            integrationId: 'hook',
            reason: 'try hook',
            idempotencyKey: 'test-key-0009',
          }),
          caller.alertRules.contacts.test({
            contactId: 'hook-desk',
            integrationId: 'hook',
            reason: 'try hook',
            idempotencyKey: 'test-key-0009',
          }),
        ]);
        expect(racedSend[0]).toEqual(racedSend[1]);
        expect(seen).toHaveLength(2);
        expect(await sql`SELECT notification_id FROM ops.alert_channel_attempts WHERE idempotency_key = 'test-key-0009'`).toHaveLength(1);
        const recoverKey = 'test-key-0010';
        const recoverFp = fingerprintOf({ op: 'channel.tested', key: recoverKey, contactId: 'hook-desk', integrationId: 'hook' });
        await sql`INSERT INTO ops.alert_notifications (notification_id, contact_id, integration_id, ordinal, idempotency_key)
          VALUES ('ops:notify:hook-desk:3', 'hook-desk', 'hook', 3, ${recoverKey})`;
        await sql`INSERT INTO ops.alert_send_claims (idempotency_key, attempt, notification_id, fingerprint, claimed_at)
          VALUES (${recoverKey}, 1, 'ops:notify:hook-desk:3', ${recoverFp}, ${AT})`;
        await caller.alertRules.contacts.test({
          contactId: 'hook-desk',
          integrationId: 'hook',
          reason: 'finish claim',
          idempotencyKey: recoverKey,
        });
        expect(seen).toHaveLength(3);
        await caller.alertRules.contacts.test({
          contactId: 'hook-desk',
          integrationId: 'hook',
          reason: 'finish claim',
          idempotencyKey: recoverKey,
        });
        expect(seen).toHaveLength(3);
      } finally {
        server.close();
        if (previous === undefined) delete process.env.OPS_ALERT_CHANNEL_KEY;
        else process.env.OPS_ALERT_CHANNEL_KEY = previous;
        await sql.end();
        await database.drop();
      }
    });

    it('suppresses a matching silence, refuses a blank flap or window, and does not hide an older match', async () => {
      const previous = process.env.OPS_ALERT_CHANNEL_KEY;
      process.env.OPS_ALERT_CHANNEL_KEY = 'notify-test-key';
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
      const seen: string[] = [];
      const server = createServer((req, res) => {
        req.on('data', () => undefined);
        req.on('end', () => {
          seen.push('post');
          res.writeHead(204);
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      let clock = AT;
      const muteOff = { days: [1], months: [1], years: [2026], start: '00:00', end: '01:00', location: 'UTC' };
      const muteOn = { days: [23], months: [10], years: [2026], start: '00:00', end: '12:00', location: 'UTC' };
      const activeOn = { days: [23], months: [10], years: [2026], start: '00:00', end: '23:59', location: 'UTC' };
      const timing = { groupBy: ['team'], groupWaitSeconds: 30, groupIntervalSeconds: 60, repeatSeconds: 120, flapSeconds: 15 };
      try {
        await migrateOutreach(sql);
        const desk = createPgAlertDesk(sql);
        const caller = createOpsRouter(new OpsService(), undefined, {
          now: () => clock,
          alertDesk: desk,
          alertRules: new AlertRules(createPgAlertRuleStore(sql), () => clock, undefined, desk),
          alertState: createPgAlertState(sql),
        }).createCaller(await signed());
        await caller.alertRules.contacts.save({
          id: 'hook-desk',
          name: 'Hook',
          integrations: [{ id: 'hook', kind: 'webhook', url: `http://127.0.0.1:${port}/hook`, secret: 'signing-secret' }],
          reason: 'add hook',
          idempotencyKey: 'contact-key-11',
        });
        await caller.alertRules.routePolicy.save({
          defaultContactId: 'hook-desk',
          ...timing,
          mute: muteOff,
          active: activeOn,
          reason: 'timed',
          idempotencyKey: 'route-key-11',
        });
        const ops = await caller.alertRules.create({ ...ruleDraft, labels: { team: 'ops', n: 'old' }, idempotencyKey: 'alert-key-3001' });
        const pay = await caller.alertRules.create({
          ...ruleDraft,
          name: 'Pay stalled',
          labels: { team: 'pay', n: '1' },
          idempotencyKey: 'alert-key-3002',
        });
        const evaluator = new AlertEvaluator({
          rules: createPgAlertRuleStore(sql),
          state: createPgAlertState(sql),
          signals: { read: async () => ({ status: 'ok', value: '5' }) },
          now: () => clock,
        });
        await evaluator.tick();
        await caller.alertRules.silences.create({
          id: 'quiet',
          matchers: [{ label: 'team', op: 'eq', value: 'ops' }],
          endsAt: '2026-10-24T00:00:00.000Z',
          reason: 'mute ops',
          idempotencyKey: 'silence-key-11',
        });
        const muted = await caller.alertRules.grouping.send({ ruleId: ops.id, reason: 'page', idempotencyKey: 'group-key-11' });
        expect(muted).toMatchObject({ sent: false, code: null, suppressed: { kind: 'silence', id: 'quiet' } });
        expect(seen).toHaveLength(0);
        const mutedAgain = await caller.alertRules.grouping.send({ ruleId: ops.id, reason: 'page', idempotencyKey: 'group-key-11' });
        expect(mutedAgain).toEqual(muted);
        expect(seen).toHaveLength(0);
        expect(await sql`SELECT state FROM ops.alert_instances WHERE rule_id = ${ops.id}`).toEqual([{ state: 'firing' }]);
        await caller.alertRules.routePolicy.save({
          expectedVersion: 1,
          defaultContactId: 'hook-desk',
          groupBy: ['team'],
          groupWaitSeconds: 30,
          groupIntervalSeconds: 60,
          repeatSeconds: 120,
          reason: 'no flap',
          idempotencyKey: 'route-key-12',
        });
        await expect(caller.alertRules.grouping.send({ ruleId: pay.id, reason: 'page', idempotencyKey: 'group-key-12' })).rejects.toThrow(
          OPS_FLAP_SUPPRESSION_UNSET,
        );
        await caller.alertRules.routePolicy.save({
          expectedVersion: 2,
          defaultContactId: 'hook-desk',
          ...timing,
          active: activeOn,
          reason: 'no mute',
          idempotencyKey: 'route-key-13',
        });
        await expect(caller.alertRules.grouping.send({ ruleId: pay.id, reason: 'page', idempotencyKey: 'group-key-13' })).rejects.toThrow(
          OPS_MUTE_TIMING_UNSET,
        );
        await caller.alertRules.routePolicy.save({
          expectedVersion: 3,
          defaultContactId: 'hook-desk',
          ...timing,
          mute: muteOff,
          reason: 'no active',
          idempotencyKey: 'route-key-14',
        });
        await expect(caller.alertRules.grouping.send({ ruleId: pay.id, reason: 'page', idempotencyKey: 'group-key-14' })).rejects.toThrow(
          OPS_ACTIVE_TIME_UNSET,
        );
        await caller.alertRules.routePolicy.save({
          expectedVersion: 4,
          defaultContactId: 'hook-desk',
          ...timing,
          mute: muteOn,
          active: activeOn,
          reason: 'muted now',
          idempotencyKey: 'route-key-15',
        });
        const byWindow = await caller.alertRules.grouping.send({ ruleId: pay.id, reason: 'page', idempotencyKey: 'group-key-15' });
        expect(byWindow).toMatchObject({ sent: false, suppressed: { kind: 'mute' } });
        expect(seen).toHaveLength(0);
        await caller.alertRules.routePolicy.save({
          expectedVersion: 5,
          defaultContactId: 'hook-desk',
          ...timing,
          mute: muteOff,
          active: activeOn,
          reason: 'open',
          idempotencyKey: 'route-key-16',
        });
        const sent = await caller.alertRules.grouping.send({ ruleId: pay.id, reason: 'page', idempotencyKey: 'group-key-16' });
        expect(sent.sent).toBe(true);
        expect(seen).toHaveLength(1);
        await caller.alertRules.grouping.send({ ruleId: pay.id, reason: 'page', idempotencyKey: 'group-key-16' });
        expect(seen).toHaveLength(1);
        clock = '2026-10-23T00:00:01.000Z';
        for (let n = 0; n < 10; n += 1) {
          await caller.alertRules.create({
            ...ruleDraft,
            name: `Noise ${n}`,
            labels: { team: 'other', n: String(n) },
            idempotencyKey: `noise-key-${String(n).padStart(2, '0')}`,
          });
        }
        await evaluator.tick();
        const hidden = await caller.alertRules.silences.preview({ id: 'quiet', limit: 10 });
        expect(hidden.truncated).toBe(false);
        expect(hidden.alerts.map((row) => row.ruleId)).toEqual([ops.id]);
        clock = '2026-10-23T00:00:02.000Z';
        for (let n = 0; n < 11; n += 1) {
          await caller.alertRules.create({
            ...ruleDraft,
            name: `More ${n}`,
            labels: { team: 'ops', n: `x${n}` },
            idempotencyKey: `extra-key-${String(n).padStart(2, '0')}`,
          });
        }
        await evaluator.tick();
        const cut = await caller.alertRules.silences.preview({ id: 'quiet', limit: 10 });
        expect(cut.alerts).toHaveLength(10);
        expect(cut.truncated).toBe(true);
        expect(cut.alerts.every((row) => row.labels.team === 'ops')).toBe(true);
      } finally {
        server.close();
        if (previous === undefined) delete process.env.OPS_ALERT_CHANNEL_KEY;
        else process.env.OPS_ALERT_CHANNEL_KEY = previous;
        await sql.end();
        await database.drop();
      }
    });

    it('refuses a key another desk action used with a typed conflict, and replays a sent group after a silence', async () => {
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
      try {
        await migrateOutreach(sql);
        const store = createPgNotify(sql);
        const who = { actor: 'operator-1', reason: 'review fix', at: AT };
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
        const input = { ruleId: 'rule-1', labels: { team: 'ops' }, key: 'group-key-0002', ...who };
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
      } finally {
        await sql.end();
        await database.drop();
      }
    });
  });
}
