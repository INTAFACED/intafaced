import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

const authConfig = {
  secret: 'a-support-staff-availability-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const OUTSIDER = '77777777-7777-4777-8777-777777777777';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-availability' };
}

async function desk(heartbeatWindowSeconds: number | null) {
  let nowMs = Date.parse('2026-10-20T08:00:00.000Z');
  const staff = new MemoryStaffBook();
  const support = new SupportService(undefined, undefined, undefined, staff, undefined, heartbeatWindowSeconds, () => new Date(nowMs));
  const router = createSupportRouter(support);
  const as = async (userId: string) => router.createCaller(await ctx(userId, ['support:ops']));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-1' });
  await lead.staffAppoint({ userId: OTHER, role: 'agent', idempotencyKey: 'appoint-other-1' });
  return { staff, as, lead, advance: (seconds: number) => (nowMs += seconds * 1000) };
}

describe('staff availability (SP-agents-01)', () => {
  it('starts everyone offline, and an agent toggling busy shows busy in the directory', async () => {
    const { as, lead } = await desk(null);
    expect((await lead.staffList()).map((m) => m.availability)).toEqual(['offline', 'offline', 'offline']);
    const agent = await as(AGENT);
    await agent.staffSetAvailability({ availability: 'busy' });
    const row = (await lead.staffList()).find((m) => m.userId === AGENT);
    expect(row).toMatchObject({ availability: 'busy', availabilitySetAt: '2026-10-20T08:00:00.000Z' });
  });

  it('lets a lead set anyone with a logged reason, and refuses an agent setting someone else', async () => {
    const { as, lead, staff } = await desk(null);
    await lead.staffSetAvailability({ userId: AGENT, availability: 'online', reason: 'covering the morning shift' });
    expect(staff.availabilityLog).toEqual([
      { userId: AGENT, availability: 'online', by: LEAD, reason: 'covering the morning shift', at: '2026-10-20T08:00:00.000Z' },
    ]);
    const agent = await as(AGENT);
    await expect(agent.staffSetAvailability({ userId: OTHER, availability: 'busy' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await lead.staffList()).find((m) => m.userId === OTHER)?.availability).toBe('offline');
  });

  it('refuses a value that is not online, busy or offline, and a caller who is not staff', async () => {
    const { as } = await desk(null);
    const agent = await as(AGENT);
    await expect(agent.staffSetAvailability({ availability: 'away' })).rejects.toMatchObject({
      message: expect.stringContaining('support.availability_invalid'),
    });
    const outsider = await as(OUTSIDER);
    await expect(outsider.staffSetAvailability({ availability: 'online' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('writes nothing when the value is unchanged', async () => {
    const { as, staff } = await desk(null);
    const agent = await as(AGENT);
    await agent.staffSetAvailability({ availability: 'online' });
    await agent.staffSetAvailability({ availability: 'online' });
    expect(staff.availabilityLog).toHaveLength(1);
  });

  it('shows an agent offline once the heartbeat window has passed, and back online after a heartbeat', async () => {
    const { as, lead, advance } = await desk(60);
    const agent = await as(AGENT);
    await agent.staffSetAvailability({ availability: 'online' });
    advance(59);
    expect((await lead.staffList()).find((m) => m.userId === AGENT)?.availability).toBe('online');
    advance(2);
    expect((await lead.staffList()).find((m) => m.userId === AGENT)?.availability).toBe('offline');
    await agent.staffHeartbeat();
    expect((await lead.staffList()).find((m) => m.userId === AGENT)?.availability).toBe('online');
  });

  it('with the window blank, availability stays as last set and the heartbeat refuses with a typed state', async () => {
    const { as, lead, advance } = await desk(null);
    const agent = await as(AGENT);
    await agent.staffSetAvailability({ availability: 'online' });
    advance(24 * 3600);
    expect((await lead.staffList()).find((m) => m.userId === AGENT)?.availability).toBe('online');
    expect(await lead.staffAvailabilityPolicy()).toEqual({ automaticOffline: 'not_set', heartbeatWindowSeconds: null });
    await expect(agent.staffHeartbeat()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('reports the window when the owner has set one', async () => {
    const { lead } = await desk(120);
    expect(await lead.staffAvailabilityPolicy()).toEqual({ automaticOffline: 'set', heartbeatWindowSeconds: 120 });
  });

  it('refuses every call without support:ops', async () => {
    const support = new SupportService();
    const router = createSupportRouter(support);
    const plain = router.createCaller(await ctx(AGENT, ['support:read']));
    await expect(plain.staffSetAvailability({ availability: 'online' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(plain.staffAvailabilityPolicy()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
