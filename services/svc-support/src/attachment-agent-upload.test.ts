import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryAttachmentStore, type MalwareScanner, type ScanVerdict } from './attachments.js';
import { MemoryAttachmentSettingsBook } from './attachment-settings.js';
import { MemoryStaffBook } from './desk-staff.js';
import {
  ATTACHMENT_ADAPTER_REFUSED,
  LOCAL_TEST_EICAR_STRING,
  LocalTestEicarScanner,
  openLocalTestAttachments,
} from './local-test-attachments.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportError, SupportService } from './support-service.js';

/**
 * SP-tickets-02 — the assigned operator adds a file for the owner, a file is stored only after a clean verdict, bytes
 * waiting on a verdict sit under a held key, and a late block purges them. The local test adapters boot only in dev and test.
 */

const authConfig = {
  secret: 'a-support-attachment-agent-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OP = '33333333-3333-4333-8333-333333333333';
const OP2 = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const BODY = Buffer.from('hello').toString('base64');

class Scanner implements MalwareScanner {
  constructor(public verdict: ScanVerdict) {}
  onScan: (() => Promise<void>) | null = null;
  async scan(): Promise<ScanVerdict> {
    await this.onScan?.();
    return this.verdict;
  }
}

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-agent' };
}

async function desk(verdict: ScanVerdict = 'clean') {
  const store = new MemorySupportStore();
  const files = new MemoryAttachmentStore();
  const scanner = new Scanner(verdict);
  const settings = new MemoryAttachmentSettingsBook();
  await settings.set({
    changes: { maxBytes: 100, allowedTypes: ['text/plain'], maxCount: 2 },
    expectedRevision: 0,
    by: 'lead-1',
    reason: 'test',
    at: '2026-10-20T14:00:00.000Z',
  });
  const support = new SupportService(
    store,
    undefined,
    { store: files, scanner, maxBytes: null, allowedTypes: null, maxCount: null },
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
  const as = async (userId: string, scopes: string[]) => router.createCaller(await ctx(userId, scopes));
  const customer = await as(CUSTOMER, ['support:read', 'support:write']);
  const ticket = await customer.create({ category: 'account', subject: 'Cannot sign in', body: 'Need help' });
  return { store, files, scanner, support, as, customer, ticketId: ticket.id };
}

const upload = (support: SupportService, ticketId: string, n: number, operatorId = OP) =>
  support.attachAsOperator({ operatorId, ticketId, clientRequestId: `op-${n}`, contentType: 'text/plain', bodyBase64: BODY });

async function refusal(run: Promise<unknown>): Promise<SupportError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof SupportError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('operator attach', () => {
  it('adds the file for the owner, names the operator, and the owner sees and downloads it', async () => {
    const { support, as, customer, ticketId } = await desk();
    await support.claimForOperator({ operatorId: OP, ticketId });
    const ops = await as(OP, ['support:ops']);
    const saved = await ops.attachOps({ ticketId, clientRequestId: 'op-1', contentType: 'text/plain', bodyBase64: BODY });
    expect(saved).toMatchObject({ ownerId: CUSTOMER, uploadedBy: OP, scanState: 'clean' });
    const listed = await customer.ticketAttachments({ ticketId, limit: 10 });
    expect(listed.map((f) => [f.id, f.uploadedBy])).toEqual([[saved.id, OP]]);
    expect((await customer.attachmentDownload({ attachmentId: saved.id })).bodyBase64).toBe(BODY);
  });

  it('an owner’s own file reads as added by the owner', async () => {
    const { support, customer, ticketId } = await desk();
    const own = await support.attach({ userId: CUSTOMER, ticketId, clientRequestId: 'own-1', contentType: 'text/plain', bodyBase64: BODY });
    expect(own.uploadedBy).toBeNull();
    expect((await customer.ticketAttachments({ ticketId, limit: 10 }))[0]!.uploadedBy).toBeNull();
  });

  it('refuses an operator who is not assigned, an unassigned ticket and a caller without the ops scope', async () => {
    const { support, as, ticketId } = await desk();
    expect((await refusal(upload(support, ticketId, 1))).message).toMatch(/not found/i);
    await support.claimForOperator({ operatorId: OP, ticketId });
    await expect(upload(support, ticketId, 2, OP2)).rejects.toBeInstanceOf(SupportError);
    await expect(
      (await as(CUSTOMER, ['support:read', 'support:write'])).attachOps({
        ticketId,
        clientRequestId: 'x',
        contentType: 'text/plain',
        bodyBase64: BODY,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('replays a lost reply without scanning or counting twice, and shares the request’s file limit', async () => {
    const { support, files, ticketId } = await desk();
    await support.claimForOperator({ operatorId: OP, ticketId });
    const first = await upload(support, ticketId, 1);
    expect(await upload(support, ticketId, 1)).toEqual(first);
    expect(files.puts).toBe(1);
    await upload(support, ticketId, 2);
    expect((await refusal(upload(support, ticketId, 3))).code).toBe('support.attachment_count_reached');
  });

  it('refuses with the missing piece named when the desk has no store', async () => {
    const support = new SupportService();
    const ticket = await support.createTicket({ userId: CUSTOMER, category: 'account', subject: 's', body: 'b' });
    await support.claimForOperator({ operatorId: OP, ticketId: ticket.id });
    const err = await refusal(upload(support, ticket.id, 1));
    expect(err).toMatchObject({ code: 'support.attachments_unconfigured', missingKey: 'support.attachment_store' });
  });
});

describe('store only after the verdict', () => {
  it('infected bytes never reach the store, under any key', async () => {
    const { support, files, ticketId } = await desk('infected');
    await refusal(support.attach({ userId: CUSTOMER, ticketId, clientRequestId: 'a', contentType: 'text/plain', bodyBase64: BODY }));
    expect(files.puts).toBe(0);
    expect(files.objects.size).toBe(0);
  });

  it('bytes the scanner could not judge wait under a held key, and a clean pass moves them to the final key', async () => {
    const { support, scanner, files, ticketId } = await desk('unknown');
    await refusal(support.attach({ userId: CUSTOMER, ticketId, clientRequestId: 'a', contentType: 'text/plain', bodyBase64: BODY }));
    const keys = [...files.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^held\//);
    scanner.verdict = 'clean';
    expect(await support.rescanHeldAttachments(10)).toEqual({ clean: 1, blocked: 0, held: 0 });
    const after = [...files.objects.keys()];
    expect(after).toHaveLength(1);
    expect(after[0]).not.toMatch(/^held\//);
  });

  it('a pass that finds held bytes infected purges them', async () => {
    const { support, scanner, files, ticketId } = await desk('unknown');
    await refusal(support.attach({ userId: CUSTOMER, ticketId, clientRequestId: 'a', contentType: 'text/plain', bodyBase64: BODY }));
    scanner.verdict = 'infected';
    expect(await support.rescanHeldAttachments(10)).toEqual({ clean: 0, blocked: 1, held: 0 });
    expect(files.objects.size).toBe(0);
  });

  it('a block that lands while the scan runs purges the bytes the clean verdict wrote', async () => {
    const { support, scanner, files, store, ticketId } = await desk('clean');
    scanner.onScan = async () => {
      const [row] = await store.listScanningAttachments(10);
      await store.setAttachmentScanState({ attachmentId: row!.id, state: 'blocked' });
    };
    const err = await refusal(
      support.attach({ userId: CUSTOMER, ticketId, clientRequestId: 'a', contentType: 'text/plain', bodyBase64: BODY }),
    );
    expect(err.code).toBe('support.attachment_scan_refused');
    expect(files.objects.size).toBe(0);
  });
});

describe('local test adapters', () => {
  const eicar = new TextEncoder().encode(`prefix ${LOCAL_TEST_EICAR_STRING} suffix`);

  it('install nothing when both settings are blank, in any environment', () => {
    expect(openLocalTestAttachments({ appEnv: 'production', store: undefined, scanner: '' })).toEqual({ store: null, scanner: null });
  });

  it.each(['production', 'staging', 'prod', 'DEV', undefined, ''])('are refused when APP_ENV is %j', (appEnv) => {
    expect(() => openLocalTestAttachments({ appEnv, store: 'local-test-memory', scanner: undefined })).toThrow(ATTACHMENT_ADAPTER_REFUSED);
    expect(() => openLocalTestAttachments({ appEnv, store: undefined, scanner: 'local-test-eicar' })).toThrow(ATTACHMENT_ADAPTER_REFUSED);
  });

  it('refuse a name this build does not have', () => {
    expect(() => openLocalTestAttachments({ appEnv: 'test', store: 's3', scanner: undefined })).toThrow(ATTACHMENT_ADAPTER_REFUSED);
    expect(() => openLocalTestAttachments({ appEnv: 'test', store: undefined, scanner: 'clamav' })).toThrow(ATTACHMENT_ADAPTER_REFUSED);
  });

  it('install in dev and test, and the scanner blocks only the EICAR test string', async () => {
    for (const appEnv of ['dev', 'test']) {
      const { store, scanner } = openLocalTestAttachments({ appEnv, store: 'local-test-memory', scanner: 'local-test-eicar' });
      expect(store).not.toBeNull();
      expect(scanner).toBeInstanceOf(LocalTestEicarScanner);
    }
    const scanner = new LocalTestEicarScanner();
    expect(await scanner.scan(eicar)).toBe('infected');
    expect(await scanner.scan(new TextEncoder().encode('hello'))).toBe('clean');
  });
});
