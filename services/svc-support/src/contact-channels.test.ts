import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryContactBook, contactFingerprint } from './contact-channels.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

const authConfig = {
  secret: 'a-support-contact-channels-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-contact' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-contact' };
}

async function desk() {
  const contact = new MemoryContactBook();
  const support = new SupportService(undefined, undefined, undefined, new MemoryStaffBook());
  const router = createSupportRouter(support, undefined, undefined, support, contact);
  const as = async (userId: string | null, scopes = ['support:ops', 'support:read', 'support:write']) =>
    router.createCaller(await ctx(userId, scopes));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-1' });
  return { contact, as, lead };
}

const set = { reason: 'Owner published the support email' };

describe('contact channels', () => {
  it('reads every channel as null before the owner sets one, signed out, and invents nothing', async () => {
    const { as } = await desk();
    const visitor = await as(null);
    expect(await visitor.contactChannels()).toEqual({ email: null, phone: null, chatHours: null, revision: 0, updatedAt: null });
  });

  it('a lead sets a channel and a visitor reads it back', async () => {
    const { as, lead } = await desk();
    const after = await lead.setContactChannels({ ...set, expectedRevision: 0, email: ' help@example.test ' });
    expect(after).toMatchObject({ email: 'help@example.test', phone: null, chatHours: null, revision: 1 });
    expect(Number.isFinite(Date.parse(after.updatedAt as string))).toBe(true);
    expect(await (await as(null)).contactChannels()).toEqual(after);
  });

  it('a field left out is unchanged and null clears one', async () => {
    const { lead } = await desk();
    await lead.setContactChannels({ ...set, expectedRevision: 0, email: 'help@example.test', phone: '+1 555 010 0199' });
    const second = await lead.setContactChannels({ ...set, expectedRevision: 1, chatHours: 'Mon to Fri, 09:00 to 17:00 UTC' });
    expect(second).toMatchObject({
      email: 'help@example.test',
      phone: '+1 555 010 0199',
      chatHours: 'Mon to Fri, 09:00 to 17:00 UTC',
      revision: 2,
    });
    const cleared = await lead.setContactChannels({ ...set, expectedRevision: 2, phone: null });
    expect(cleared).toMatchObject({ email: 'help@example.test', phone: null, revision: 3 });
  });

  it('refuses a malformed value before anything is stored', async () => {
    const { contact, lead } = await desk();
    await expect(lead.setContactChannels({ ...set, expectedRevision: 0, email: 'not an address' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(lead.setContactChannels({ ...set, expectedRevision: 0 } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await contact.get()).toMatchObject({ email: null, revision: 0 });
  });

  it('only a staff lead on a support session may set a channel', async () => {
    const { contact, as } = await desk();
    const input = { ...set, expectedRevision: 0, email: 'help@example.test' };
    await expect((await as(AGENT)).setContactChannels(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(CUSTOMER)).setContactChannels(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(LEAD, ['support:read'])).setContactChannels(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(null)).setContactChannels(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await contact.get()).toMatchObject({ email: null, revision: 0 });
  });

  it('a change from a stale revision is refused, and a lost reply replayed is the first answer', async () => {
    const { contact, lead } = await desk();
    const first = await lead.setContactChannels({ ...set, expectedRevision: 0, email: 'help@example.test' });
    // The reply was lost and the operator sends the same change again from the revision they read.
    expect(await lead.setContactChannels({ ...set, expectedRevision: 0, email: 'help@example.test' })).toEqual(first);
    expect(contact.log).toHaveLength(1);
    // A different change from the same stale revision must not overwrite.
    await expect(lead.setContactChannels({ ...set, expectedRevision: 0, email: 'other@example.test' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.contact_revision_stale',
    });
    expect(await contact.get()).toMatchObject({ email: 'help@example.test', revision: 1 });
  });

  it('writes one log row per real change, under the business key, and none for a no-op', async () => {
    const { contact, lead } = await desk();
    await lead.setContactChannels({ ...set, expectedRevision: 0, email: 'help@example.test' });
    await lead.setContactChannels({ ...set, expectedRevision: 1, email: 'help@example.test' });
    expect(contact.log).toHaveLength(1);
    expect(contact.log[0]).toMatchObject({ key: 'support.contact:r0', by: LEAD, reason: set.reason });
    expect(contact.log[0]!.before.email).toBeNull();
    expect(contact.log[0]!.after.email).toBe('help@example.test');
  });

  it('fingerprints the fields and the reason, not the actor or the time', () => {
    expect(contactFingerprint({ email: 'a@b.test' }, 'r')).toBe(contactFingerprint({ email: 'a@b.test' }, 'r'));
    expect(contactFingerprint({ email: 'a@b.test' }, 'r')).not.toBe(contactFingerprint({ phone: 'a@b.test' }, 'r'));
    expect(contactFingerprint({ email: null }, 'r')).not.toBe(contactFingerprint({}, 'r'));
  });
});
