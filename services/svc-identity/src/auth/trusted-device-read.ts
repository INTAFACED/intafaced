/**
 * The trusted-device read for other services (`GET /internal/trusted-devices/:userId/:deviceId`, `trustedDeviceStateSchema`).
 * An access token's `dev` claim names the device it was minted on and says nothing about whether that device is still
 * trusted, so a service that lets one device approve another's request (svc-bank, a new withdrawal address approved
 * from a second device; J-wallet-04 #5) asks here at the moment it acts. Only the services listed may ask.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TRUSTED_DEVICE_READ_PATH, type ServiceBodyBindMode, type TrustedDeviceState } from '@intafaced/contracts';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';

/** The services allowed to read a customer's trusted devices. */
export const TRUSTED_DEVICE_READERS: ReadonlySet<string> = new Set(['svc-bank']);

const paramsSchema = z.object({ userId: z.string().guid(), deviceId: z.string().guid() }).strict();

export function registerTrustedDeviceReadRoute(
  app: FastifyInstance,
  opts: {
    read: (userId: string, deviceId: string) => Promise<TrustedDeviceState>;
    internalSecret: string | undefined;
    bodyBind?: ServiceBodyBindMode;
    s2s?: IdentityS2s;
  },
): void {
  app.get(TRUSTED_DEVICE_READ_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (!TRUSTED_DEVICE_READERS.has(service)) {
      return reply.code(403).send({ error: 'this service may not read trusted devices', code: 'identity.device_reader_refused' });
    }
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid account or device id', code: 'identity.device_read_invalid' });
    }
    return opts.read(parsed.data.userId, parsed.data.deviceId);
  });
}
