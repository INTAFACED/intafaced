import Fastify from 'fastify';
import { serviceAuthHeadersForBody, type RestoreWatermarkRead } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { registerRestoreWatermarkRoute } from './restore-watermark.js';

const SECRET = 'internal-secret-for-restore-watermark-test';
const READ: RestoreWatermarkRead = {
  service: 'pay',
  kind: 'pay.rows',
  position: '12',
  integrity: 'abc',
  lastWriteAt: '2026-10-20T11:00:00.000Z',
  readAt: '2026-10-20T12:00:00.000Z',
};

async function appFor(asked: { n: number }) {
  const app = Fastify();
  registerRestoreWatermarkRoute(app, {
    internalSecret: SECRET,
    read: async () => {
      asked.n += 1;
      return READ;
    },
  });
  await app.ready();
  return app;
}

const signed = (service: 'svc-ops' | 'svc-identity') => {
  const payload = '{}';
  return {
    method: 'POST' as const,
    url: '/internal/restore/watermark',
    payload,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
  };
};

describe('POST /internal/restore/watermark', () => {
  it('answers svc-ops with the position', async () => {
    const asked = { n: 0 };
    const app = await appFor(asked);
    const res = await app.inject(signed('svc-ops'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(READ);
    expect(asked.n).toBe(1);
    await app.close();
  });

  it('refuses no credentials with 401 and another signed service with 403, reading nothing', async () => {
    const asked = { n: 0 };
    const app = await appFor(asked);
    expect((await app.inject({ method: 'POST', url: '/internal/restore/watermark', payload: {} })).statusCode).toBe(401);
    expect((await app.inject(signed('svc-identity'))).statusCode).toBe(403);
    expect(asked.n).toBe(0);
    await app.close();
  });
});
