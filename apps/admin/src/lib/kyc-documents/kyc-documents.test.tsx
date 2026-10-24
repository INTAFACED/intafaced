import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { identityActionPayloadHash } from '../../../../../services/svc-identity/src/auth/privileged-dual-control';
import { DOCUMENT_CLOSED_REPLY, StepReplyView } from '@/components/approval-workbench';
import { confirmPhrase, readDeskRequest } from '@/lib/desk/approval-packet';
import { payloadHashFor, proposeInputFor } from '@/lib/desk/approval-hash';
import { readStepReply } from '@/lib/desk/approval-types';
import { stepGate } from '@/lib/desk/desk-model';
import { readOpenedDocument, savedName, viewableImage, type OpenedDocument } from './document';
import { kycDocumentOpenExecute } from './open';

const DOC = '3c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5';
const USER = '4d2e3f4a-5b6c-4d7e-8f80-91a2b3c4d5e6';
const IDS = { approvalId: 'appr-1', operationId: 'op-1' };
const bytes = Buffer.from('TEST image bytes');
const opened = (over: Partial<OpenedDocument> = {}): OpenedDocument => ({
  id: DOC,
  userId: USER,
  contentType: 'image/png',
  byteLength: bytes.length,
  storedBy: 'op',
  createdAt: '2026-10-24T10:00:00.000Z',
  bytesBase64: bytes.toString('base64'),
  ...over,
});

const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};

afterEach(() => vi.unstubAllGlobals());

describe('the open-document request', () => {
  const request = { kind: 'identity.kyc_document.open' as const, documentId: DOC };

  it('is bound to the document exactly as identity consumes it', () => {
    expect(payloadHashFor(request)).toBe(identityActionPayloadHash('kyc.doc.get', { documentId: DOC }));
    expect(proposeInputFor(request)).toMatchObject({
      actionType: 'kyc.doc.get',
      targetService: 'svc-identity',
      targetId: 'kyc.doc.get',
      expectedVersion: '1',
    });
    const router = readFileSync(fileURLToPath(new URL('../../../../../services/svc-identity/src/router.ts', import.meta.url)), 'utf8');
    expect(router).toContain("consumePrivileged(reader, input, 'kyc.doc.get', { documentId: input.documentId })");
    expect(confirmPhrase(request)).toBe('OPEN DOCUMENT 3c1d2e3f');
  });

  it('reads only the exact shape', () => {
    expect(readDeskRequest(request)).toEqual(request);
    expect(readDeskRequest({ ...request, reason: 'look at it please' })).toBeNull();
    expect(readDeskRequest({ ...request, documentId: 'not-a-uuid' })).toBeNull();
    expect(readDeskRequest({ ...request, documentId: DOC.toUpperCase() })).toBeNull();
  });
});

describe('who runs an open', () => {
  const REQUESTER = '11111111-1111-4111-8111-111111111111';
  const packet = {
    request: { kind: 'identity.kyc_document.open' as const, documentId: DOC },
    approvalId: 'appr-1',
    operationId: 'op-1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    requesterId: REQUESTER,
  };
  const gate = (userId: string) =>
    stepGate({
      step: 'execute',
      packet,
      userId,
      confirm: 'OPEN DOCUMENT 3c1d2e3f',
      blockedReason: null,
      busy: false,
      now: new Date('2026-10-24T10:00:00Z'),
    });

  it('only the founder who asked runs it; the approver cannot', () => {
    expect(gate(REQUESTER)).toEqual({ ok: true });
    expect(gate('22222222-2222-4222-8222-222222222222')).toEqual({
      ok: false,
      why: 'Only the founder who asked to open this document can open it.',
    });
    // Other requests keep their rule: either founder runs an approved kill.
    const kill = { ...packet, request: { kind: 'ledger.unfreeze' as const, version: '3' } };
    expect(
      stepGate({
        step: 'execute',
        packet: kill,
        userId: '22222222-2222-4222-8222-222222222222',
        confirm: 'UNFREEZE LEDGER',
        blockedReason: null,
        busy: false,
        now: new Date('2026-10-24T10:00:00Z'),
      }),
    ).toEqual({ ok: true });
  });
});

describe('an opened document', () => {
  it('reads only contents that decode to the length identity states', () => {
    expect(readOpenedDocument(opened())).toEqual(opened());
    expect(readOpenedDocument(opened({ byteLength: bytes.length + 1 }))).toBeNull();
    expect(readOpenedDocument(opened({ bytesBase64: 'not base64!' }))).toBeNull();
    expect(readOpenedDocument(opened({ contentType: 'image/png\r\nx: y' }))).toBeNull();
    // Whatever identity stores is read (it refuses only line breaks and more than 128 characters); only images are drawn.
    expect(readOpenedDocument(opened({ contentType: 'image/jpeg; name=Paß.jpg' }))).not.toBeNull();
    expect(readOpenedDocument(opened({ contentType: 'x'.repeat(129) }))).toBeNull();
    expect(readOpenedDocument({ ...opened(), extra: 1, id: 'x' })).toBeNull();
  });

  it('draws only image types on the page, and names a saved file by id and type', () => {
    expect(viewableImage({ contentType: 'image/PNG; charset=x' })).toBe(true);
    for (const contentType of ['application/pdf', 'image/svg+xml', 'text/html']) expect(viewableImage({ contentType })).toBe(false);
    expect(savedName({ id: DOC, contentType: 'application/pdf' })).toBe(`kyc-document-${DOC}.pdf`);
    expect(savedName({ id: DOC, contentType: 'text/html' })).toBe(`kyc-document-${DOC}.bin`);
  });

  it('shows an image in the viewer, and anything else as a file to save, never drawn', () => {
    const image = renderToStaticMarkup(<StepReplyView reply={{ ok: true, step: 'execute', detail: 'opened', document: opened() }} />);
    expect(image).toContain(`src="data:image/png;base64,${bytes.toString('base64')}"`);
    // Without a holder to drop the contents from, the viewer offers no close that would leave them in the page.
    expect(image).not.toContain('Close the document');
    const closable = renderToStaticMarkup(
      <StepReplyView reply={{ ok: true, step: 'execute', detail: 'opened', document: opened() }} onCloseDocument={() => undefined} />,
    );
    expect(closable).toContain('Close the document');
    const closed = renderToStaticMarkup(<StepReplyView reply={DOCUMENT_CLOSED_REPLY} />);
    expect(closed).not.toContain('base64');
    expect(closed).toContain('Document closed.');
    for (const contentType of ['application/pdf', 'text/html']) {
      const other = renderToStaticMarkup(
        <StepReplyView reply={{ ok: true, step: 'execute', detail: 'opened', document: opened({ contentType }) }} />,
      );
      expect(other).not.toContain('<img');
      expect(other).toContain('Save the file');
    }
  });

  it('a run reply whose document does not read is not shown and is reported as not understood', () => {
    const good = readStepReply({ ok: true, step: 'execute', detail: 'opened', document: opened() });
    expect(good).toMatchObject({ ok: true, document: { id: DOC } });
    const damaged = readStepReply({ ok: true, step: 'execute', detail: 'opened', document: opened({ byteLength: 1 }) });
    expect(damaged).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    expect(readStepReply({ ok: true, step: 'execute', detail: 'done' })).toEqual({ ok: true, step: 'execute', detail: 'done' });
  });
});

describe('running an approved open', () => {
  const request = { kind: 'identity.kyc_document.open' as const, documentId: DOC };

  it('reads the document at identity with the approval and hands it to the page', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ result: { data: opened() } }));
    vi.stubGlobal('fetch', fn);
    const reply = await kycDocumentOpenExecute(ctx)(request, IDS);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/kyc.getDocument');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({ documentId: DOC, ...IDS });
    expect(reply).toMatchObject({ ok: true, document: { id: DOC, contentType: 'image/png' } });
  });

  it('refuses another document than the one approved, and an identity refusal keeps its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: opened({ id: '5e3f4a5b-6c7d-4e8f-9081-a2b3c4d5e6f7' }) } })),
    );
    expect(await kycDocumentOpenExecute(ctx)(request, IDS)).toMatchObject({ ok: false, refusal: { code: 'admin.ops_invalid_response' } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'approval already used [action_approval.consumed]',
              code: -32603,
              data: { code: 'PRECONDITION_FAILED', httpStatus: 412 },
            },
          },
          { status: 412 },
        ),
      ),
    );
    expect(await kycDocumentOpenExecute(ctx)(request, IDS)).toMatchObject({ ok: false, refusal: { code: 'action_approval.consumed' } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'KYC document vault is not configured [kyc_doc.unwired]',
              code: -32603,
              data: { code: 'PRECONDITION_FAILED', httpStatus: 412 },
            },
          },
          { status: 412 },
        ),
      ),
    );
    expect(await kycDocumentOpenExecute(ctx)(request, IDS)).toMatchObject({
      ok: false,
      refusal: { code: 'kyc_doc.unwired', title: 'Identity’s document vault is switched off' },
    });
  });
});
