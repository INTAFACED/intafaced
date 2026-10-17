/**
 * Dump the merchant Payments OpenAPI document from the live public REST mount.
 * Used by the SDK generator. Does not start a server.
 */
import Fastify from 'fastify';
import { registerPublicPayRest } from '../src/public-rest.ts';
import { MemoryMerchantWebhookStore, MerchantWebhookService } from '../src/merchant-webhooks.ts';
import type { PayService } from '../src/payment-service.ts';

const noop = async () => {
  throw new Error('openapi dump does not call pay');
};

const trees = {
  assertHolds: noop,
  grantPermission: noop,
  revokePermission: noop,
  listPermissions: noop,
  permissionHistory: noop,
};

const app = Fastify({ logger: false });
await registerPublicPayRest(app, {
  edgeSecret: 'openapi-dump-edge-secret-32-characters',
  serviceName: 'svc-pay',
  pay: {} as PayService,
  webhooks: new MerchantWebhookService(new MemoryMerchantWebhookStore()),
  trees,
});
await app.ready();
const spec = app.swagger();
await app.close();
process.stdout.write(`${JSON.stringify(spec)}\n`);
