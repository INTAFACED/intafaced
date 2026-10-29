import { describe, expect, it } from 'vitest';
import { createHttpTeamMembershipPort } from './membership.js';

const USER = '22222222-2222-4222-8222-222222222222';
const BUSINESS = '33333333-3333-4333-8333-333333333333';
const team = { ok: true, businessId: BUSINESS, role: 'owner', members: [{ userId: USER, role: 'owner', label: null }] };

function portAnswering(answer: () => Promise<Response>, seen: Array<{ url: string; init: RequestInit }> = []) {
  return createHttpTeamMembershipPort({
    payUrl: 'http://pay.test/',
    internalSecret: 'internal-secret-for-agents-team-port-test',
    fetchImpl: (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return answer();
    }) as unknown as typeof fetch,
  });
}

describe('svc-pay team read', () => {
  it("posts the person's id, signed as svc-agents, and returns svc-pay's answer", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const port = portAnswering(async () => Response.json(team), seen);
    expect(await port.read(USER)).toEqual(team);
    expect(seen[0]?.url).toBe('http://pay.test/internal/agents/team-membership');
    expect(seen[0]?.init.body).toBe(JSON.stringify({ userId: USER }));
    expect(JSON.stringify(seen[0]?.init.headers)).toContain('svc-agents');
  });

  it('refuses membership_unavailable on a network failure, a non-200 and an off-contract body, never an empty team', async () => {
    for (const answer of [
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      async () => new Response('{}', { status: 503 }),
      async () => Response.json({ ok: true, businessId: BUSINESS, role: 'owner', members: [] }),
    ]) {
      await expect(portAnswering(answer).read(USER)).rejects.toMatchObject({ code: 'agents.membership_unavailable' });
    }
  });
});
