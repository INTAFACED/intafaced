import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryAttachmentStore, MemoryMalwareScanner } from './attachments.js';
import { MemoryAttachmentSettingsBook, attachmentFingerprint } from './attachment-settings.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportError, SupportService } from './support-service.js';

/**
 * SP-tickets-02 — owner limits for attachments. A blank limit refuses naming its key, a limit the owner sets is read at
 * attach time, a request holds no more files than the owner allows, and only a staff lead sets the limits.
 */

const authConfig = {
  secret: 'a-support-attachment-settings-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const BODY = Buffer.from('hello').toString('base64');

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-attach' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-attach' };
}

async function desk(deployment: { store?: boolean; scanner?: boolean } = { store: true, scanner: true }) {
  const settings = new MemoryAttachmentSettingsBook();
  const files = new MemoryAttachmentStore();
  const support = new SupportService(
    new MemorySupportStore(),
    undefined,
    {
      store: deployment.store ? files : null,
      scanner: deployment.scanner ? new MemoryMalwareScanner('clean') : null,
      maxBytes: null,
      allowedTypes: null,
      maxCount: null,
    },
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    settings,
  );
  const router = createSupportRouter(support, undefined, undefined, support, undefined, settings);
  const as = async (userId: string | null, scopes = ['support:ops', 'support:read', 'support:write']) =>
    router.createCaller(await ctx(userId, scopes));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-1' });
  const customer = await as(CUSTOMER, ['support:read', 'support:write']);
  const ticket = await customer.create({ category: 'account', subject: 'Cannot sign in', body: 'Need help' });
  return { settings, files, support, as, lead, customer, ticketId: ticket.id };
}

const reason = { reason: 'Owner set the attachment limits' };
const attach = (support: SupportService, ticketId: string, n: number, contentType = 'text/plain', bodyBase64 = BODY) =>
  support.attach({ userId: CUSTOMER, ticketId, clientRequestId: `attach-${n}`, contentType, bodyBase64 });

async function refusal(run: Promise<unknown>): Promise<SupportError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof SupportError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('attachment limits', () => {
  it('reads blank limits as null and names the first missing piece, for a signed-in customer', async () => {
    const { customer } = await desk({ store: false, scanner: false });
    expect(await customer.attachmentLimits()).toEqual({
      maxBytes: null,
      allowedTypes: null,
      maxCount: null,
      missing: 'support.attachment_store',
      revision: 0,
      updatedAt: null,
    });
  });

  it('a signed-out visitor cannot read the limits', async () => {
    const { as } = await desk();
    await expect((await as(null)).attachmentLimits()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('a lead sets the limits, a customer reads them, and the missing piece moves on', async () => {
    const { lead, customer } = await desk();
    expect((await customer.attachmentLimits()).missing).toBe('support.attachment_max_bytes');
    await lead.setAttachmentSettings({ ...reason, expectedRevision: 0, maxBytes: 100 });
    expect((await customer.attachmentLimits()).missing).toBe('support.attachment_allowed_types');
    await lead.setAttachmentSettings({ ...reason, expectedRevision: 1, allowedTypes: ['text/plain'] });
    expect((await customer.attachmentLimits()).missing).toBe('support.attachment_max_count');
    const done = await lead.setAttachmentSettings({ ...reason, expectedRevision: 2, maxCount: 2 });
    expect(done).toMatchObject({ maxBytes: 100, allowedTypes: ['text/plain'], maxCount: 2, missing: null, revision: 3 });
  });

  it('shows the five pieces to an operator, deployment pieces as set or not set', async () => {
    const { lead, as } = await desk({ store: true, scanner: false });
    await lead.setAttachmentSettings({ ...reason, expectedRevision: 0, maxBytes: 100 });
    const status = await lead.attachmentStatus();
    expect(status.pieces).toEqual([
      { key: 'support.attachment_store', set: true },
      { key: 'support.malware_scanner', set: false },
      { key: 'support.attachment_max_bytes', set: true },
      { key: 'support.attachment_allowed_types', set: false },
      { key: 'support.attachment_max_count', set: false },
    ]);
    await expect((await as(CUSTOMER, ['support:read'])).attachmentStatus()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('only a staff lead on a support session may set a limit', async () => {
    const { settings, as } = await desk();
    const input = { ...reason, expectedRevision: 0, maxBytes: 100 };
    await expect((await as(AGENT)).setAttachmentSettings(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(CUSTOMER)).setAttachmentSettings(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(LEAD, ['support:read'])).setAttachmentSettings(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(null)).setAttachmentSettings(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await settings.get()).toMatchObject({ maxBytes: null, revision: 0 });
  });

  it('refuses a malformed limit before anything is stored', async () => {
    const { settings, lead } = await desk();
    for (const bad of [{ maxBytes: 0 }, { maxCount: 1.5 }, { allowedTypes: ['image/*'] }, { allowedTypes: [] }, {}]) {
      await expect(lead.setAttachmentSettings({ ...reason, expectedRevision: 0, ...bad } as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(await settings.get()).toMatchObject({ revision: 0 });
  });

  it('a stale revision is refused, a lost reply replayed is the first answer, and a no-op writes no log row', async () => {
    const { settings, lead } = await desk();
    const first = await lead.setAttachmentSettings({ ...reason, expectedRevision: 0, maxBytes: 100 });
    expect(await lead.setAttachmentSettings({ ...reason, expectedRevision: 0, maxBytes: 100 })).toEqual(first);
    await expect(lead.setAttachmentSettings({ ...reason, expectedRevision: 0, maxBytes: 200 })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.attachment_revision_stale',
    });
    await lead.setAttachmentSettings({ ...reason, expectedRevision: 1, maxBytes: 100 });
    expect(settings.log).toHaveLength(1);
    expect(settings.log[0]).toMatchObject({ key: 'support.attachment_settings:r0', by: LEAD, reason: reason.reason });
  });

  it('the change fingerprint ignores the actor and the time', () => {
    expect(attachmentFingerprint({ maxBytes: 5 }, 'why')).toBe(attachmentFingerprint({ maxBytes: 5 }, 'why'));
    expect(attachmentFingerprint({ maxBytes: 5 }, 'why')).not.toBe(attachmentFingerprint({ maxBytes: 6 }, 'why'));
  });
});

describe('attach against the owner limits', () => {
  it('refuses with the blank limit named while the owner has set none, and stores nothing', async () => {
    const { support, files, ticketId } = await desk();
    expect(await refusal(attach(support, ticketId, 1))).toMatchObject({
      code: 'support.attachments_unconfigured',
      missingKey: 'support.attachment_max_bytes',
    });
    expect(files.puts).toBe(0);
  });

  it('a blank count refuses support.attachment_count_unset and stores nothing', async () => {
    const { support, lead, files, ticketId } = await desk();
    await lead.setAttachmentSettings({ ...reason, expectedRevision: 0, maxBytes: 100, allowedTypes: ['text/plain'] });
    expect(await refusal(attach(support, ticketId, 1))).toMatchObject({
      code: 'support.attachment_count_unset',
      missingKey: 'support.attachment_max_count',
    });
    expect(files.puts).toBe(0);
  });

  it('holds a request to the owner’s count, replays a lost reply without a new place, and frees nothing for another request', async () => {
    const { support, lead, customer, files, ticketId } = await desk();
    await lead.setAttachmentSettings({ ...reason, expectedRevision: 0, maxBytes: 100, allowedTypes: ['text/plain'], maxCount: 2 });
    const one = await attach(support, ticketId, 1);
    await attach(support, ticketId, 2);
    expect(await refusal(attach(support, ticketId, 3))).toMatchObject({ code: 'support.attachment_count_reached' });
    expect(files.puts).toBe(2);
    // The reply to the first was lost: the same request id returns the same file and is not refused for the count.
    expect(await attach(support, ticketId, 1)).toEqual(one);
    expect(files.puts).toBe(2);
    // Another request of the same customer has its own places.
    const other = await customer.create({ category: 'account', subject: 'Second', body: 'Another' });
    expect(await attach(support, other.id, 4)).toMatchObject({ ticketId: other.id });
  });

  it('applies the size and type the owner set, and a raised limit takes effect on the next attach', async () => {
    const { support, lead, ticketId } = await desk();
    await lead.setAttachmentSettings({ ...reason, expectedRevision: 0, maxBytes: 3, allowedTypes: ['text/plain'], maxCount: 5 });
    expect(await refusal(attach(support, ticketId, 1))).toMatchObject({ code: 'support.attachment_too_large' });
    expect(await refusal(attach(support, ticketId, 2, 'image/png', Buffer.from('hi').toString('base64')))).toMatchObject({
      code: 'support.attachment_type_refused',
    });
    await lead.setAttachmentSettings({ ...reason, expectedRevision: 1, maxBytes: 5 });
    expect(await attach(support, ticketId, 3)).toMatchObject({ byteLength: 5 });
  });
});
