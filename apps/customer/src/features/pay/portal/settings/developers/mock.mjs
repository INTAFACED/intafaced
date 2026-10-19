// TEST DATA ONLY. Nothing here is a real key, address, secret or event.
import { NOT_MINE, DAY, iso, ok, page, refuse } from '../../mock/shared.mjs';

const WEBHOOK_ROLES = new Set(['owner', 'admin', 'developer']);

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
          if (!input.url.startsWith('https://')) return refuse(route, 400, 'pay.webhook_url_invalid');
          const endpoint = {
            id: `TEST-endpoint-${dev.endpoints.length + 1}`,
            url: input.url,
            status: 'active',
            disabledReason: null,
            consecutiveFailures: 0,
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
          if (d.status !== 'failed' && d.status !== 'dead') return refuse(route, 409, 'pay.webhook_retry_not_failed');
          Object.assign(d, { status: 'pending', attempts: 0, lastStatusCode: null });
          return ok(route, { retried: true, delivery: d });
        }
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
