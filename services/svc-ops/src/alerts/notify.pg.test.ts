import { createHmac } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:http';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, postgresAvailable } from '@intafaced/db/testing';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { createPgAlertDesk } from './desk-store.js';
import { AlertEvaluator } from './runner.js';
import { createPgAlertRuleStore } from './rule-store.js';
import { AlertRules } from './rules.js';
import { createPgAlertState } from './state-store.js';
import {
  OPS_ALERT_DEFAULT_CONTACT_UNSET,
  OPS_CHANNEL_AUTH_CONFLICT,
  OPS_CONTACT_POINT_IN_USE,
  OPS_GROUP_TIMING_UNSET,
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
          res.writeHead(204);
          res.end();
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
      } finally {
        server.close();
        if (previous === undefined) delete process.env.OPS_ALERT_CHANNEL_KEY;
        else process.env.OPS_ALERT_CHANNEL_KEY = previous;
        await sql.end();
        await database.drop();
      }
    });
  });
}
