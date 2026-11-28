/**
 * GET /health, /ready, and tRPC health must not sell an env allowlist as a
 * live moderator. Configured is not reachable. This process never probes.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { isModerationConfigured } from './moderation-auth.js';
import { P2P_MODERATION_UNPROBED, P2P_MODERATION_UNREACHABLE, moderationHonesty, moderationOnPublicDoor } from './moderation-honesty.js';

describe('p2p moderation honesty — configured is not reachable', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('empty allowlist is absent + unreachable, never reachable', () => {
    expect(isModerationConfigured([])).toBe(false);
    expect(moderationOnPublicDoor(false)).toEqual({
      moderationConfigured: false,
      moderation: { status: 'absent', code: P2P_MODERATION_UNREACHABLE },
    });
    expect(moderationHonesty(false).status).not.toBe('ok');
  });

  it('named ids are configured + unprobed, never reachable', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(isModerationConfigured([id])).toBe(true);
    expect(moderationOnPublicDoor(true)).toEqual({
      moderationConfigured: true,
      moderation: { status: 'configured', code: P2P_MODERATION_UNPROBED },
    });
  });

  it('GET /health as index.ts mounts does not emit moderationReachable', async () => {
    const app = Fastify({ logger: false });
    const configured = isModerationConfigured(['11111111-1111-4111-8111-111111111111']);
    app.get('/health', async () => ({
      ok: true,
      service: 'svc-p2p',
      ...moderationOnPublicDoor(configured),
    }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('moderationReachable');
    expect(body.moderationConfigured).toBe(true);
    expect(body.moderation).toEqual({ status: 'configured', code: P2P_MODERATION_UNPROBED });
  });
});
