import { describe, expect, it } from 'vitest';
import { createHttpTeamMembershipPort } from './membership.js';

const USER = '22222222-2222-4222-8222-222222222222';
const BUSINESS = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const team = { ok: true, businessId: BUSINESS, role: 'admin', members: [{ userId: USER, role: 'admin' }] };

function portAnswering(answer: () => Promise<Response>, seen: Array<{ url: string; init: RequestInit }> = []) {
  return createHttpTeamMembershipPort({
    bankUrl: 'http://bank.test/',
    internalSecret: 'internal-secret-for-agents-team-port-test',
    fetchImpl: (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return answer();
    }) as unknown as typeof fetch,
  });
}

describe('svc-bank team read', () => {
  it("posts the person's id and the business, signed as svc-agents, and returns svc-bank's answer", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const port = portAnswering(async () => Response.json(team), seen);
    expect(await port.read(USER, BUSINESS)).toEqual(team);
    expect(seen[0]?.url).toBe('http://bank.test/internal/agents/team-membership');
    expect(seen[0]?.init.body).toBe(JSON.stringify({ userId: USER, businessId: BUSINESS }));
    expect(JSON.stringify(seen[0]?.init.headers)).toContain('svc-agents');
  });

  it('passes not_member and business_closed through as svc-bank said them', async () => {
    for (const reason of ['not_member', 'business_closed'] as const) {
      expect(await portAnswering(async () => Response.json({ ok: false, reason })).read(USER, BUSINESS)).toEqual({ ok: false, reason });
    }
  });

  it('refuses membership_unavailable on a network failure, a non-200, an off-contract body or another business, never an empty team', async () => {
    for (const answer of [
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      async () => new Response('{}', { status: 503 }),
      async () => Response.json({ ok: true, businessId: BUSINESS, role: 'admin', members: [] }),
      async () => Response.json({ ...team, businessId: OTHER }),
    ]) {
      await expect(portAnswering(answer).read(USER, BUSINESS)).rejects.toMatchObject({ code: 'agents.membership_unavailable' });
    }
  });
});
