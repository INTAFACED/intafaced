import Fastify from 'fastify';
import { serviceAuthHeadersForBody, type AgentsTeamMembershipResponse } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { registerAgentsTeamMembershipRoute } from './team-membership-route.js';

const SECRET = 'internal-secret-for-agents-team-membership-test';
const USER = '22222222-2222-4222-8222-222222222222';
const BUSINESS = '33333333-3333-4333-8333-333333333333';

async function appFor(answer: AgentsTeamMembershipResponse | Error, seen: string[] = []) {
  const app = Fastify();
  registerAgentsTeamMembershipRoute(app, {
    internalSecret: SECRET,
    read: async (userId) => {
      seen.push(userId);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  await app.ready();
  return app;
}

function post(body: unknown, service = 'svc-agents') {
  const payload = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: '/internal/agents/team-membership',
    payload,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
  };
}

describe('POST /internal/agents/team-membership', () => {
  it("answers the asking person's business team, and no_business for a person on none", async () => {
    const team: AgentsTeamMembershipResponse = {
      ok: true,
      businessId: BUSINESS,
      role: 'owner',
      members: [{ userId: USER, role: 'owner', label: null }],
    };
    for (const answer of [team, { ok: false, reason: 'no_business' } as const, { ok: false, reason: 'business_shut' } as const]) {
      const seen: string[] = [];
      const app = await appFor(answer, seen);
      const res = await app.inject(post({ userId: USER }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(answer);
      expect(seen).toEqual([USER]);
      await app.close();
    }
  });

  it('refuses an unsigned caller, another service, a bad userId and extra fields, without reading', async () => {
    const seen: string[] = [];
    const app = await appFor({ ok: false, reason: 'no_business' }, seen);
    const open = await app.inject({ method: 'POST', url: '/internal/agents/team-membership', payload: { userId: USER } });
    expect(open.statusCode).toBe(401);
    expect(open.json().error).toBe('pay.unauthenticated');
    const other = await app.inject(post({ userId: USER }, 'svc-identity'));
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe('pay.team_membership_service_forbidden');
    for (const body of [{ userId: 'not-a-user' }, {}, { userId: USER, businessId: BUSINESS }]) {
      const bad = await app.inject(post(body));
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('pay.team_membership_invalid');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('answers 503 with a typed code, never the error text, when the read fails or breaks the contract', async () => {
    const broken = { ok: true, businessId: BUSINESS, role: 'owner', members: [] } as unknown as AgentsTeamMembershipResponse;
    for (const answer of [new Error('connect ECONNREFUSED 10.0.0.9:5432'), broken]) {
      const app = await appFor(answer);
      const res = await app.inject(post({ userId: USER }));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'pay.team_membership_unavailable', message: 'business team could not be read' });
      await app.close();
    }
  });
});
