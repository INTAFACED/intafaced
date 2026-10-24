import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serviceAuthHeaders, trustedDeviceReadPath, trustedDeviceStateSchema, type TrustedDeviceState } from '@intafaced/contracts';
import { registerTrustedDeviceReadRoute } from './trusted-device-read.js';

const SECRET = 'd'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const LIVE: TrustedDeviceState = { live: true, trustedBy: 'approval', newDeviceCheck: 'on' };

async function app(read: (userId: string, deviceId: string) => Promise<TrustedDeviceState>) {
  const server = Fastify({ logger: false });
  registerTrustedDeviceReadRoute(server, { read, internalSecret: SECRET });
  await server.ready();
  return server;
}

function get(url: string, service = 'svc-bank') {
  return { method: 'GET' as const, url, headers: serviceAuthHeaders(service, SECRET) };
}

describe('GET /internal/trusted-devices/:userId/:deviceId', () => {
  it('needs service credentials, and only svc-bank may read', async () => {
    const asked: Array<[string, string]> = [];
    const server = await app(async (userId, deviceId) => {
      asked.push([userId, deviceId]);
      return LIVE;
    });
    expect((await server.inject({ method: 'GET', url: trustedDeviceReadPath(USER, DEVICE) })).statusCode).toBe(401);
    const other = await server.inject(get(trustedDeviceReadPath(USER, DEVICE), 'svc-trade'));
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('identity.device_reader_refused');
    expect(asked).toHaveLength(0);

    const ok = await server.inject(get(trustedDeviceReadPath(USER, DEVICE)));
    expect(ok.statusCode).toBe(200);
    expect(trustedDeviceStateSchema.parse(ok.json())).toEqual(LIVE);
    expect(asked).toEqual([[USER, DEVICE]]);
  });

  it('refuses ids that are not UUIDs before anything is read', async () => {
    let calls = 0;
    const server = await app(async () => {
      calls += 1;
      return LIVE;
    });
    for (const url of [trustedDeviceReadPath('not-a-user', DEVICE), trustedDeviceReadPath(USER, 'x')]) {
      const res = await server.inject(get(url));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('identity.device_read_invalid');
    }
    expect(calls).toBe(0);
  });

  it('refuses everything when no service secret is configured', async () => {
    const server = Fastify({ logger: false });
    registerTrustedDeviceReadRoute(server, { read: async () => LIVE, internalSecret: undefined });
    await server.ready();
    expect((await server.inject(get(trustedDeviceReadPath(USER, DEVICE)))).statusCode).toBe(401);
  });
});
