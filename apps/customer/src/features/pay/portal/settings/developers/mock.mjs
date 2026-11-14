// TEST DATA ONLY. Nothing here is a real key, address, secret or event.
import { createHmac } from 'node:crypto';
import { NOT_MINE, DAY, iso, ok, page, refuse } from '../../mock/shared.mjs';

const WEBHOOK_ROLES = new Set(['owner', 'admin', 'developer']);
const EVENT_TYPES = ['payment.authorized', 'payment.captured', 'payment.refunded', 'payment.failed'];
const VECTOR = {
  secret: 'whsec_TEST_stand_in_example',
  timestamp: '1767225600',
  body: '{"id":"payment.captured:TEST-payment-1","type":"payment.captured"}',
};
const sign = (secret, ts, body) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

/** API keys, request signing, webhook endpoints and their deliveries. Identity procedures have no `merchantOps.` prefix. */
export function createDevelopersMock(ctx) {
  const { scenario, now, state } = ctx;
  const quiet = scenario === 'quiet' || scenario === 'new';
  const dev = (state.dev = {
    keys: quiet
      ? []
      : [
          {
            id: 'TEST-key-1',
            name: 'TEST Checkout system',
            prefix: 'test_ab12',
            scopes: ['pay:read', 'pay:write'],
            lastUsedAt: iso(now - 3600_000),
            revoked: false,
            mode: 'sandbox',
            requireSignature: true,
            requireNonEmptyIpAllowlist: true,
            ipAllowlist: ['203.0.113.10'],
          },
          {
            id: 'TEST-key-2',
            name: 'TEST Reporting',
            prefix: 'test_cd34',
            scopes: ['pay:read'],
            lastUsedAt: null,
            revoked: false,
            mode: 'sandbox',
            requireSignature: false,
            requireNonEmptyIpAllowlist: false,
            ipAllowlist: [],
          },
          {
            id: 'TEST-key-3',
            name: 'TEST Old script',
            prefix: 'test_ef56',
            scopes: ['pay:read'],
            lastUsedAt: iso(now - 40 * DAY),
            revoked: true,
            mode: 'sandbox',
            requireSignature: false,
            requireNonEmptyIpAllowlist: false,
            ipAllowlist: [],
          },
        ],
    ips: new Map(),
    signing: new Map(),
    endpoints: quiet
      ? []
      : [
          {
            id: 'TEST-endpoint-1',
            url: 'https://receiver.example/events?token=TEST-secret-in-URL',
            status: 'active',
            disabledReason: null,
            consecutiveFailures: 0,
            eventTypes: ['payment.captured', 'payment.refunded'],
            createdAt: iso(now - 30 * DAY),
            updatedAt: iso(now - 2 * DAY),
          },
          {
            id: 'TEST-endpoint-2',
            url: 'https://old-receiver.example/hook',
            status: 'disabled',
            disabledReason: 'disabled_by_merchant',
            consecutiveFailures: 5,
            createdAt: iso(now - 60 * DAY),
            updatedAt: iso(now - 20 * DAY),
          },
          {
            id: 'TEST-endpoint-3',
            url: 'https://flaky.example/in',
            status: 'active',
            disabledReason: null,
            consecutiveFailures: 3,
            createdAt: iso(now - 10 * DAY),
            updatedAt: iso(now - 1 * DAY),
          },
        ],
    deliveries: quiet
      ? []
      : Array.from({ length: 30 }, (_, i) => {
          const status = i % 7 === 3 ? 'failed' : i % 11 === 5 ? 'dead' : i % 5 === 0 ? 'pending' : 'delivered';
          const createdAt = iso(now - i * 3600_000 * 5);
          return {
            id: `TEST-delivery-${i + 1}`,
            endpointId: i % 3 === 2 ? 'TEST-endpoint-3' : 'TEST-endpoint-1',
            eventType: ['payment.captured', 'payment.refunded', 'settlement.paid_out'][i % 3],
            status,
            attempts: status === 'delivered' ? 1 : status === 'pending' ? 0 : 3,
            lastStatusCode: status === 'delivered' ? 200 : status === 'pending' ? null : 500,
            latencyMs: status === 'delivered' ? 120 + i : null,
            createdAt,
            deliveredAt: status === 'delivered' ? createdAt : null,
          };
        }),
  });
  const canManage = () => WEBHOOK_ROLES.has(ctx.role);
  const secret = (n) => `TEST-secret-${n}-${'x'.repeat(24)}`;

  return {
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'apiKeys.list':
          return ok(
            route,
            dev.keys.map((k) => ({
              requireSignature: false,
              requireNonEmptyIpAllowlist: false,
              ipAllowlist: [],
              ...k,
              ...(dev.signing.get(k.id) ?? {}),
              ipAllowlist: dev.ips.get(k.id) ?? k.ipAllowlist ?? [],
            })),
          );
        case 'apiKeys.create': {
          const id = `TEST-key-${dev.keys.length + 1}`;
          // The list shows the start of the very key that was handed out, as the real service does.
          const handedOut = ['test', `TEST-NOT-A-REAL-KEY-${id}`].join('_');
          const prefix = handedOut.slice(0, 9);
          dev.keys.unshift({
            id,
            name: input.name,
            prefix,
            scopes: input.scopes,
            lastUsedAt: null,
            revoked: false,
            mode: 'sandbox',
            requireSignature: false,
            requireNonEmptyIpAllowlist: false,
            ipAllowlist: [],
          });
          return ok(route, { id, key: handedOut, prefix, mode: 'sandbox' });
        }
        case 'apiKeys.revoke': {
          const key = dev.keys.find((k) => k.id === input.keyId);
          if (!key) return refuse(route, 404, 'auth.not_found');
          key.revoked = true;
          return ok(route, { revoked: true });
        }
        case 'setApiKeyRequestSigning': {
          if (!dev.keys.some((k) => k.id === input.keyId)) return refuse(route, 404, 'auth.not_found');
          const first = input.requireSignature && !dev.signing.get(input.keyId)?.requireSignature;
          dev.signing.set(input.keyId, {
            requireSignature: input.requireSignature,
            requireNonEmptyIpAllowlist: input.requireNonEmptyIpAllowlist,
          });
          return ok(route, { id: input.keyId, ...dev.signing.get(input.keyId), signingSecret: first ? 'ifs_TEST-signing-secret' : null });
        }
        case 'rotateSigningSecret':
          if (!dev.signing.get(input.keyId)?.requireSignature) return refuse(route, 412, 'auth.signature_not_required');
          return ok(route, { id: input.keyId, signingSecret: 'ifs_TEST-rotated-secret' });
        case 'bindApiKeyIpAllowlist':
          dev.ips.set(input.keyId, input.ips);
          return ok(route, { id: input.keyId, ipAllowlist: input.ips });
        case 'unbindApiKeyIpAllowlist': {
          const next = (dev.ips.get(input.keyId) ?? []).filter((ip) => ip !== input.ip);
          dev.ips.set(input.keyId, next);
          return ok(route, { id: input.keyId, ipAllowlist: next });
        }
        case 'merchantOps.webhooks.list': {
          const rows = dev.endpoints.filter(
            (e) =>
              (!input.status || e.status === input.status) && (!input.search || e.id === input.search || e.url.startsWith(input.search)),
          );
          return ok(route, page(rows, input));
        }
        case 'merchantOps.webhooks.create': {
          if (!canManage()) return refuse(route, 403, 'pay.team_role_forbidden');
          if (!input.url.startsWith('https://')) return refuse(route, 400, 'pay.webhook_url_https_required');
          if (!input.eventTypes?.length) return refuse(route, 400, 'pay.webhook_event_types_required');
          const endpoint = {
            id: `TEST-endpoint-${dev.endpoints.length + 1}`,
            url: input.url,
            status: 'active',
            disabledReason: null,
            consecutiveFailures: 0,
            eventTypes: input.eventTypes,
            createdAt: iso(Date.now()),
            updatedAt: iso(Date.now()),
          };
          dev.endpoints.unshift(endpoint);
          return ok(route, { endpoint, secret: secret(endpoint.id) });
        }
        case 'merchantOps.webhooks.update': {
          const e = dev.endpoints.find((x) => x.id === input.endpointId);
          if (!e) return refuse(route, 404, 'pay.webhook_endpoint_not_found');
          if (!canManage()) return refuse(route, 403, 'pay.team_role_forbidden');
          Object.assign(e, { url: input.url, updatedAt: iso(Date.now()) });
          return ok(route, e);
        }
        case 'merchantOps.webhooks.disable': {
          const e = dev.endpoints.find((x) => x.id === input.endpointId);
          if (!e) return refuse(route, 404, 'pay.webhook_endpoint_not_found');
          Object.assign(e, { status: 'disabled', disabledReason: 'disabled_by_merchant', updatedAt: iso(Date.now()) });
          return ok(route, e);
        }
        case 'merchantOps.webhooks.rotateSecret': {
          const e = dev.endpoints.find((x) => x.id === input.endpointId);
          if (!e) return refuse(route, 404, 'pay.webhook_endpoint_not_found');
          dev.rotations ??= new Set();
          const again = dev.rotations.has(input.requestId);
          dev.rotations.add(input.requestId);
          if (!again && input.overlapSeconds > 0) e.previousSecretUntil = iso(Date.now() + input.overlapSeconds * 1000);
          return ok(route, { endpoint: e, secret: again ? null : secret(`${e.id}-new`), rotated: !again });
        }
        case 'merchantOps.webhooks.deliveries.list': {
          const rows = dev.deliveries.filter(
            (d) =>
              (!input.endpointId || d.endpointId === input.endpointId) &&
              (!input.status || d.status === input.status) &&
              (!input.from || d.createdAt >= input.from) &&
              (!input.to || d.createdAt < input.to),
          );
          return ok(route, page(rows, input));
        }
        case 'merchantOps.webhooks.deliveries.retry': {
          const d = dev.deliveries.find((x) => x.id === input.deliveryId);
          if (!d) return refuse(route, 404, 'pay.webhook_delivery_not_found');
          if (d.status === 'pending') return refuse(route, 409, 'pay.webhook_resend_already_queued');
          Object.assign(d, { status: 'pending', lastStatusCode: null });
          return ok(route, { retried: true, delivery: d });
        }
        case 'merchantOps.webhooks.deliveries.attempts': {
          const d = dev.deliveries.find((x) => x.id === input.deliveryId);
          if (!d) return refuse(route, 404, 'pay.webhook_delivery_not_found');
          return ok(route, {
            deliveryId: d.id,
            attempts: Array.from({ length: d.attempts }, (_, i) => {
              const last = i === d.attempts - 1;
              const good = last && d.status === 'delivered';
              return {
                attemptNo: i + 1,
                at: iso(Date.parse(d.createdAt) + i * 60_000),
                outcome: good ? 'delivered' : 'failed',
                statusCode: good ? 200 : 500,
                error: null,
                durationMs: 100 + i,
                resend: false,
              };
            }),
          });
        }
        case 'merchantOps.webhooks.deliveries.recover': {
          if (!canManage()) return refuse(route, 403, 'pay.team_role_forbidden');
          dev.recoveries ??= new Map();
          if (dev.recoveries.has(input.requestId)) return ok(route, { recovered: false, queued: dev.recoveries.get(input.requestId) });
          const due = dev.deliveries.filter(
            (d) => d.endpointId === input.endpointId && (d.status === 'failed' || d.status === 'dead') && d.createdAt >= input.since,
          );
          for (const d of due) Object.assign(d, { status: 'pending', lastStatusCode: null });
          dev.recoveries.set(input.requestId, due.length);
          return ok(route, { recovered: true, queued: due.length });
        }
        case 'merchantOps.webhooks.policy':
          return ok(route, {
            endpointCap: 10,
            overlapMaxSeconds: 600,
            resendWindowSeconds: 7 * 86_400,
            retryScheduleSeconds: [5, 10, 20],
            resendRate: { maxPerWindow: 20, windowMs: 3_600_000 },
          });
        case 'merchantOps.webhooks.catalogue':
          return ok(route, {
            events: EVENT_TYPES.map((type) => ({ type, summary: `TEST ${type}`, payloadSchema: { type: 'object' } })),
            ordering: 'TEST: order by createdAt.',
            duplicates: 'TEST: drop repeats by id.',
          });
        case 'merchantOps.webhooks.guide':
          return ok(route, {
            headers: { timestamp: 'X-Intafaced-Timestamp', signature: 'X-Intafaced-Signature', eventId: 'X-Intafaced-Event-Id' },
            algorithm: 'TEST: HMAC-SHA256 over timestamp.body.',
            toleranceSeconds: 300,
            senderIps: ['203.0.113.50'],
            vector: { ...VECTOR, signature: sign(VECTOR.secret, VECTOR.timestamp, VECTOR.body) },
          });
        case 'merchantOps.webhooks.health': {
          const count = (id, status) => dev.deliveries.filter((d) => d.endpointId === id && d.status === status).length;
          return ok(route, {
            asOf: iso(Date.now()),
            endpoints: dev.endpoints.map((e) => ({
              endpointId: e.id,
              status: e.status,
              consecutiveFailures: e.consecutiveFailures,
              deliveries: {
                pending: count(e.id, 'pending'),
                delivered: count(e.id, 'delivered'),
                failed: count(e.id, 'failed'),
                dead: count(e.id, 'dead'),
                unknown: count(e.id, 'unknown'),
              },
              lastDeliveredAt: dev.deliveries.find((d) => d.endpointId === e.id && d.deliveredAt)?.deliveredAt ?? null,
            })),
          });
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
