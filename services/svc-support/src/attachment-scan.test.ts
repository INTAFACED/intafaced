import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryAttachmentStore, type MalwareScanner, type ScanVerdict } from './attachments.js';
import { MemoryAttachmentSettingsBook } from './attachment-settings.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportError, SupportService } from './support-service.js';

/**
 * SP-tickets-02 — scan state and download. A file is on record as `scanning` first, becomes `clean` or `blocked` on the
 * scanner's answer, is served only when clean, and a file the scanner could not judge is held and scanned again.
 */

const authConfig = {
  secret: 'a-support-attachment-scan-test-secret-long-enough',
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

const attach = (support: SupportService, ticketId: string, n: number, bodyBase64 = BODY) =>
  support.attach({ userId: CUSTOMER, ticketId, clientRequestId: `attach-${n}`, contentType: 'text/plain', bodyBase64 });

async function refusal(run: Promise<unknown>): Promise<SupportError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof SupportError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('a clean file', () => {
  it('is on record clean, and its owner downloads it as a fixed-type attachment', async () => {
    const { support, customer, ticketId } = await desk();
    const saved = await attach(support, ticketId, 1);
    expect(saved.scanState).toBe('clean');
    const meta = await customer.attachment({ attachmentId: saved.id });
    expect(meta).toMatchObject({ id: saved.id, scanState: 'clean', byteLength: 5, contentType: 'text/plain' });
    expect(meta).not.toHaveProperty('storeKey');
    const download = await customer.attachmentDownload({ attachmentId: saved.id });
    expect(download).toEqual({
      id: saved.id,
      contentType: 'application/octet-stream',
      disposition: 'attachment',
      byteLength: 5,
      bodyBase64: BODY,
    });
  });

  it('a replay of a lost reply is answered from the stored file and is not scanned a second time', async () => {
    const { support, scanner, files, ticketId } = await desk();
    const first = await attach(support, ticketId, 1);
    expect(await attach(support, ticketId, 1)).toEqual(first);
    expect(scanner.calls).toBe(1);
    expect(files.puts).toBe(1);
  });

  it('another customer’s file answers as not found, and so does an operator who is not assigned', async () => {
    const { support, as, ticketId } = await desk();
    const saved = await attach(support, ticketId, 1);
    await expect((await as(OTHER, ['support:read'])).attachmentDownload({ attachmentId: saved.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect((await as(OP, ['support:ops'])).attachmentDownloadOps({ attachmentId: saved.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('an operator assigned to the ticket downloads it, an owner-only caller cannot use the operator call', async () => {
    const { support, as, ticketId } = await desk();
    const saved = await attach(support, ticketId, 1);
    await support.claimForOperator({ operatorId: OP, ticketId });
    const ops = await as(OP, ['support:ops']);
    expect((await ops.attachmentDownloadOps({ attachmentId: saved.id })).bodyBase64).toBe(BODY);
    await expect((await as(CUSTOMER, ['support:read'])).attachmentDownloadOps({ attachmentId: saved.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('an infected file', () => {
  it('is refused, recorded blocked, never stored and never served, and a retry stays refused', async () => {
    const { support, customer, files, scanner, ticketId } = await desk('infected');
    expect((await refusal(attach(support, ticketId, 1))).code).toBe('support.attachment_scan_refused');
    expect(files.puts).toBe(0);
    const [row] = await support['store'].listScanningAttachments(10);
    expect(row).toBeUndefined();
    scanner.verdict = 'clean';
    // The owner's retry under the same request id does not turn a blocked file clean.
    expect((await refusal(attach(support, ticketId, 1))).code).toBe('support.attachment_scan_refused');
    expect(files.puts).toBe(0);
    const id = await blockedId(support, ticketId);
    expect((await customer.attachment({ attachmentId: id })).scanState).toBe('blocked');
    await expect(customer.attachmentDownload({ attachmentId: id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('does not use up a place on the request', async () => {
    const { support, scanner, ticketId } = await desk('infected', 1);
    await refusal(attach(support, ticketId, 1));
    scanner.verdict = 'clean';
    expect((await attach(support, ticketId, 2)).scanState).toBe('clean');
  });
});

async function blockedId(support: SupportService, _ticketId: string): Promise<string> {
  const receipt = (await support['store'].readReceipt('support.attach', CUSTOMER, 'attach-1')) as { attachment: { id: string } } | null;
  expect(receipt).not.toBeNull();
  return receipt!.attachment.id;
}

describe('a file the scanner could not judge', () => {
  it('is held with its bytes, refused as unknown, never served, and scanned again by a later pass', async () => {
    const { support, customer, files, scanner, ticketId } = await desk('unknown');
    expect((await refusal(attach(support, ticketId, 1))).code).toBe('support.attachment_scan_unknown');
    expect(files.puts).toBe(1);
    const [held] = await support['store'].listScanningAttachments(10);
    expect(held).toMatchObject({ scanState: 'scanning', byteLength: 5 });
    expect((await customer.attachment({ attachmentId: held!.id })).scanState).toBe('scanning');
    await expect(customer.attachmentDownload({ attachmentId: held!.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(await support.rescanHeldAttachments(10)).toEqual({ clean: 0, blocked: 0, held: 1 });
    scanner.verdict = 'clean';
    expect(await support.rescanHeldAttachments(10)).toEqual({ clean: 1, blocked: 0, held: 0 });
    expect((await customer.attachmentDownload({ attachmentId: held!.id })).bodyBase64).toBe(BODY);
    expect(await support.rescanHeldAttachments(10)).toEqual({ clean: 0, blocked: 0, held: 0 });
  });

  it('a scanner that fails is the same as one that cannot say, and a pass that finds it infected blocks it', async () => {
    const { support, customer, scanner, ticketId } = await desk('throw');
    expect((await refusal(attach(support, ticketId, 1))).code).toBe('support.attachment_scan_unknown');
    scanner.verdict = 'infected';
    expect(await support.rescanHeldAttachments(10)).toEqual({ clean: 0, blocked: 1, held: 0 });
    const [none] = await support['store'].listScanningAttachments(10);
    expect(none).toBeUndefined();
    const replay = await refusal(attach(support, ticketId, 1));
    expect(replay.code).toBe('support.attachment_scan_refused');
    expect(await customer.attachmentLimits()).toMatchObject({ missing: null });
  });

  it('a held file whose bytes never reached the store stays held, and the owner’s retry completes it', async () => {
    const { support, files, scanner, store, ticketId } = await desk('clean');
    // The crash came after the row was written and before the bytes were: only the row exists.
    await store.recordAttachment({
      id: '88888888-8888-4888-8888-888888888888',
      userId: CUSTOMER,
      ticketId,
      clientRequestId: 'attach-1',
      storeKey: `${ticketId}/88888888-8888-4888-8888-888888888888`,
      contentType: 'text/plain',
      byteLength: 5,
      maxCount: 5,
    });
    expect(await support.rescanHeldAttachments(10)).toEqual({ clean: 0, blocked: 0, held: 1 });
    expect(scanner.calls).toBe(0);
    const done = await attach(support, ticketId, 1);
    expect(done).toMatchObject({ id: '88888888-8888-4888-8888-888888888888', scanState: 'clean' });
    expect(files.puts).toBe(1);
  });

  it('a retry under the same request id with a different body is refused, not scanned as the first', async () => {
    const { support, scanner, ticketId } = await desk('unknown');
    await refusal(attach(support, ticketId, 1));
    scanner.verdict = 'clean';
    expect((await refusal(attach(support, ticketId, 1, Buffer.from('a longer body').toString('base64')))).code).toBe(
      'support.attachment_body_invalid',
    );
  });

  it('a late answer cannot turn a blocked file clean', async () => {
    const { support, ticketId } = await desk('infected');
    await refusal(attach(support, ticketId, 1));
    const store = support['store'];
    const id = await blockedId(support, ticketId);
    expect(await store.setAttachmentScanState({ attachmentId: id, state: 'clean' })).toMatchObject({ scanState: 'blocked' });
  });
});
