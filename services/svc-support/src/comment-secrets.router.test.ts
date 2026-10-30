import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryAttachmentStore, type MalwareScanner } from './attachments.js';
import { MemoryAttachmentSettingsBook } from './attachment-settings.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';

/**
 * J-support-public-20 #5: a reply or a staff-only note that holds a card number or a recovery phrase is refused by its
 * code through the router, from the customer and from the desk, and no comment is stored.
 */

const authConfig = {
  secret: 'a-support-comment-secrets-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const BODY = Buffer.from('hello').toString('base64');
const CUSTOMER_SCOPES = ['support:read', 'support:write'];
const AGENT_SCOPES = ['support:ops', 'support:read', 'support:write'];

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-comment-secrets' };
}

const clean: MalwareScanner = { scan: async () => 'clean' };

async function desk() {
  const store = new MemorySupportStore();
  const lifecycle = new MemoryLifecycleBook();
  const settings = new MemoryAttachmentSettingsBook();
  await settings.set({
    changes: { maxBytes: 100, allowedTypes: ['text/plain'], maxCount: 5 },
    expectedRevision: 0,
    by: 'lead-1',
    reason: 'test',
    at: '2026-10-29T14:00:00.000Z',
  });
  const support = new SupportService(
    store,
    undefined,
    { store: new MemoryAttachmentStore(), scanner: clean, maxBytes: null, allowedTypes: null, maxCount: null },
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    undefined,
    [],
    undefined,
    lifecycle,
    undefined,
    settings,
    null,
    undefined,
    5,
  );
  const router = createSupportRouter(support, undefined, undefined, support, undefined, settings);
  const as = async (userId: string, scopes: string[]) => router.createCaller(await ctx(userId, scopes));
  const customer = await as(CUSTOMER, CUSTOMER_SCOPES);
  const agent = await as(AGENT, AGENT_SCOPES);
  const ticket = await customer.create({ category: 'account', subject: 'TEST cannot pay', body: 'TEST my card was declined' });
  return { store, lifecycle, support, router, as, customer, agent, ticketId: ticket.id };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { message?: string; code?: string }) => err.message?.split(' ')[0] ?? err.code,
  );

const CARD = 'TEST my card is 4111 1111 1111 1111';
const PHRASE = 'TEST abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('a comment holding a secret is refused and nothing is stored', () => {
  it('refuses the customer, the desk reply and the desk note by code, and keeps the thread as it was', async () => {
    const { customer, agent, store, ticketId } = await desk();
    await agent.claim({ ticketId });
    for (const body of [CARD, PHRASE]) {
      expect(await code(customer.comment({ ticketId, body, clientRequestId: `c:${body.length}` }))).toBe('support.comment_secret_refused');
      expect(await code(agent.comment({ ticketId, body }))).toBe('support.comment_secret_refused');
      expect(await code(agent.addInternalNote({ ticketId, body, clientRequestId: `n:${body.length}` }))).toBe(
        'support.comment_secret_refused',
      );
    }
    expect(await store.listComments(ticketId)).toHaveLength(0);
    // A plain reply still goes through.
    expect(await code(customer.comment({ ticketId, body: 'TEST my card was declined again', clientRequestId: 'c:plain' }))).toBe('ok');
    expect(await store.listComments(ticketId)).toHaveLength(1);
  });

  it('refuses a new request whose subject or body holds one, and opens none', async () => {
    const { customer } = await desk();
    const before = (await customer.listMine({ limit: 50 })).length;
    for (const [subject, body] of [
      ['TEST card', CARD],
      [PHRASE, 'TEST my wallet'],
    ])
      expect(await code(customer.create({ category: 'account', subject, body, clientRequestId: `create:${subject}` }))).toBe(
        'support.comment_secret_refused',
      );
    expect(await customer.listMine({ limit: 50 })).toHaveLength(before);
  });
});
