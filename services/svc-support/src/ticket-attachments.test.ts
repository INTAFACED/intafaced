import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryAttachmentStore, type MalwareScanner, type ScanVerdict } from './attachments.js';
import { MemoryAttachmentSettingsBook } from './attachment-settings.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { LIST_ATTACHMENTS_LIMIT_UNSET, SupportError, SupportService, assertListAttachmentsLimit } from './support-service.js';

/**
 * SP-tickets-02 — the files on a ticket. The page size is the caller's and a blank one refuses; an owner reads their own
 * ticket's files with each scan state; someone else's ticket answers as not found; the store key is not on the wire.
 */

const authConfig = {
  secret: 'a-support-ticket-attachments-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OP = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '55555555-5555-4555-8555-555555555555';
const SESSION = '66666666-6666-4666-8666-666666666666';
const HELLO = Buffer.from('hello');
const BODY = HELLO.toString('base64');

class Scanner implements MalwareScanner {
  constructor(public verdict: ScanVerdict | 'throw') {}
  calls = 0;
  async scan(): Promise<ScanVerdict> {
    this.calls += 1;
    if (this.verdict === 'throw') throw new Error('scanner down');
    return this.verdict;
  }
}

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-scan' };
}

async function desk(verdict: ScanVerdict | 'throw' = 'clean', maxCount = 5) {
  const store = new MemorySupportStore();
  const files = new MemoryAttachmentStore();
  const scanner = new Scanner(verdict);
  const settings = new MemoryAttachmentSettingsBook();
  await settings.set({
    changes: { maxBytes: 100, allowedTypes: ['text/plain'], maxCount },
    expectedRevision: 0,
    by: 'lead-1',
    reason: 'test',
    at: '2026-10-20T14:00:00.000Z',
  });
  const staff = new MemoryStaffBook();
  const support = new SupportService(
    store,
    undefined,
    { store: files, scanner, maxBytes: null, allowedTypes: null, maxCount: null },
    staff,
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
  const as = async (userId: string, scopes: string[]) => router.createCaller(await ctx(userId, scopes));
  const customer = await as(CUSTOMER, ['support:read', 'support:write']);
  const ticket = await customer.create({ category: 'account', subject: 'Cannot sign in', body: 'Need help' });
  return { store, files, scanner, support, as, customer, ticketId: ticket.id };
}

const attach = (support: SupportService, ticketId: string, n: number) =>
  support.attach({ userId: CUSTOMER, ticketId, clientRequestId: `attach-${n}`, contentType: 'text/plain', bodyBase64: BODY });

describe('ticketAttachments page size', () => {
  it('refuses a blank, NaN or zero size and never invents one', () => {
    for (const bad of [undefined, Number.NaN, 0, -3]) {
      try {
        assertListAttachmentsLimit(bad);
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(SupportError);
        expect((err as SupportError).code).toBe(LIST_ATTACHMENTS_LIMIT_UNSET);
      }
    }
    expect(assertListAttachmentsLimit(7)).toBe(7);
  });

  it('is required on the wire call', async () => {
    const { customer, ticketId } = await desk();
    await expect(customer.ticketAttachments({ ticketId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: LIST_ATTACHMENTS_LIMIT_UNSET,
    });
  });
});

describe('ticketAttachments', () => {
  it('lists the owner’s files with each scan state and no store key', async () => {
    const { support, scanner, customer, ticketId } = await desk('clean');
    const first = await attach(support, ticketId, 1);
    scanner.verdict = 'infected';
    await expect(attach(support, ticketId, 2)).rejects.toBeInstanceOf(SupportError);
    scanner.verdict = 'unknown';
    await expect(attach(support, ticketId, 3)).rejects.toBeInstanceOf(SupportError);
    const rows = await customer.ticketAttachments({ ticketId, limit: 10 });
    expect(rows.map((r) => r.scanState).sort()).toEqual(['blocked', 'clean', 'scanning']);
    expect(rows.find((r) => r.id === first.id)).toMatchObject({ scanState: 'clean', byteLength: 5, contentType: 'text/plain' });
    for (const row of rows) expect(row).not.toHaveProperty('storeKey');
    expect(await customer.ticketAttachments({ ticketId, limit: 2 })).toHaveLength(2);
  });

  it('answers as not found for someone else’s ticket, and an empty list for a ticket with no files', async () => {
    const { as, customer, ticketId } = await desk();
    await expect((await as(OTHER, ['support:read'])).ticketAttachments({ ticketId, limit: 10 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await customer.ticketAttachments({ ticketId, limit: 10 })).toEqual([]);
  });
});
