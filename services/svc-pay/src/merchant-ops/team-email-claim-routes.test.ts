import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MerchantOpsError } from './errors.js';
import { registerMerchantEmailInviteRoutes } from './team-email-claim-routes.js';

const SECRET = 'team-email-claim-test-secret-0123456789ab';

function headers(service: string, payload: string): Record<string, string> {
  return { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) };
}

async function mount(claim: ReturnType<typeof vi.fn>) {
  const app = Fastify({ logger: false });
  registerMerchantEmailInviteRoutes(app, { internalSecret: SECRET, claim: claim as never });
  await app.ready();
  return app;
}

describe('claim-email-invites route', () => {
  it('refuses a caller without service credentials and does not claim', async () => {
    const claim = vi.fn();
    const app = await mount(claim);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/merchant-team/claim-email-invites',
      headers: { 'content-type': 'application/json' },
      payload: { userId: '11111111-1111-4111-8111-111111111111', email: 'ada@example.com' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('pay.unauthenticated');
    expect(claim).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a signed service that is not identity', async () => {
    const claim = vi.fn();
    const app = await mount(claim);
    const payload = JSON.stringify({ userId: '11111111-1111-4111-8111-111111111111', email: 'ada@example.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/merchant-team/claim-email-invites',
      headers: headers('svc-pay', payload),
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('pay.team_email_claim_forbidden');
    expect(claim).not.toHaveBeenCalled();
    await app.close();
  });

  it('claims for identity and returns only counts', async () => {
    const claim = vi.fn(async () => ({ claimed: 1, accepted: 1 }));
    const app = await mount(claim);
    const payload = JSON.stringify({ userId: '11111111-1111-4111-8111-111111111111', email: 'Ada@Example.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/merchant-team/claim-email-invites',
      headers: headers('svc-identity', payload),
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ claimed: 1, accepted: 1 });
    expect(JSON.stringify(res.json())).not.toContain('Ada');
    expect(claim).toHaveBeenCalledWith({ userId: '11111111-1111-4111-8111-111111111111', email: 'Ada@Example.com' });
    await app.close();
  });

  it('maps an invalid mailbox to the typed refusal and does not echo it', async () => {
    const claim = vi.fn(async () => {
      throw new MerchantOpsError('pay.team_email_invalid', 'bad_request');
    });
    const app = await mount(claim);
    const payload = JSON.stringify({ userId: 'not-a-user', email: 'ada@example.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/merchant-team/claim-email-invites',
      headers: headers('svc-identity', payload),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pay.team_email_invalid' });
    await app.close();
  });
});
