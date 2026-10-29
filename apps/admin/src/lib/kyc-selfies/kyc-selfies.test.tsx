import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { identityActionPayloadHash } from '../../../../../services/svc-identity/src/auth/privileged-dual-control';
import { KycSelfieDecide } from '@/components/kyc-selfie-decide';
import { confirmPhrase, readDeskRequest, requestReason } from '@/lib/desk/approval-packet';
import { payloadHashFor, proposeInputFor } from '@/lib/desk/approval-hash';
import { stepGate } from '@/lib/desk/desk-model';
import type { Row } from '@/lib/ops-desk/types';
import { kycSelfieDecideExecute } from './decide';
import { readSelfie } from './selfie';

const SELFIE = '6f4a5b6c-7d8e-4f90-81a2-b3c4d5e6f708';
const DOC = '3c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5';
const USER = '4d2e3f4a-5b6c-4d7e-8f80-91a2b3c4d5e6';
const IDS = { approvalId: 'appr-1', operationId: 'op-1' };
const answer = (over: Record<string, unknown> = {}) => ({
  id: SELFIE,
  status: 'accepted',
  via: 'handoff',
  createdAt: '2026-10-28T10:00:00.000Z',
  documentId: DOC,
  captureCheck: 'not_checked',
  decidedAt: '2026-10-29T10:00:00.000Z',
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

describe('the selfie decision request', () => {
  const accept = { kind: 'identity.kyc_selfie.decide' as const, selfieId: SELFIE, decision: 'accepted' as const };
  const reject = { ...accept, decision: 'rejected' as const };

  it('is bound to the selfie and the decision exactly as identity consumes it', () => {
    expect(payloadHashFor(accept)).toBe(identityActionPayloadHash('kyc.selfie.decide', { selfieId: SELFIE, decision: 'accepted' }));
    expect(payloadHashFor(reject)).toBe(identityActionPayloadHash('kyc.selfie.decide', { selfieId: SELFIE, decision: 'rejected' }));
    expect(payloadHashFor(accept)).not.toBe(payloadHashFor(reject));
    expect(proposeInputFor(accept)).toMatchObject({
      actionType: 'kyc.selfie.decide',
      targetService: 'svc-identity',
      targetId: 'kyc.selfie.decide',
      expectedVersion: '1',
    });
    const router = readFileSync(fileURLToPath(new URL('../../../../../services/svc-identity/src/router.ts', import.meta.url)), 'utf8');
    expect(router).toMatch(
      /consumePrivileged\(ctx\.principal\.userId, input, 'kyc\.selfie\.decide', \{\s+selfieId: input\.selfieId,\s+decision: input\.decision,\s+\}\)/,
    );
    expect(confirmPhrase(accept)).toBe('ACCEPT SELFIE 6f4a5b6c');
    expect(confirmPhrase(reject)).toBe('REJECT SELFIE 6f4a5b6c');
    expect(requestReason(accept)).toBeNull();
  });

  it('reads only the exact shape', () => {
    expect(readDeskRequest(accept)).toEqual(accept);
    expect(readDeskRequest(reject)).toEqual(reject);
    expect(readDeskRequest({ ...accept, reason: 'looks the same' })).toBeNull();
    expect(readDeskRequest({ ...accept, decision: 'provided' })).toBeNull();
    expect(readDeskRequest({ ...accept, selfieId: 'not-a-uuid' })).toBeNull();
    expect(readDeskRequest({ ...accept, selfieId: SELFIE.toUpperCase() })).toBeNull();
  });

  it('either founder may run an approved decision; identity checks neither is the person', () => {
    const packet = { request: accept, ...IDS, expiresAt: '2030-01-01T00:00:00.000Z', requesterId: ctx.session.userId };
    const gate = (userId: string) =>
      stepGate({
        step: 'execute',
        packet,
        userId,
        confirm: 'ACCEPT SELFIE 6f4a5b6c',
        blockedReason: null,
        busy: false,
        now: new Date('2026-10-29T10:00:00Z'),
      });
    expect(gate(ctx.session.userId)).toEqual({ ok: true });
    expect(gate('22222222-2222-4222-8222-222222222222')).toEqual({ ok: true });
  });
});

describe('a selfie answer', () => {
  it('reads only a well-formed selfie', () => {
    expect(readSelfie(answer())).toEqual({ id: SELFIE, status: 'accepted', documentId: DOC, decidedAt: '2026-10-29T10:00:00.000Z' });
    expect(readSelfie(answer({ status: 'provided', decidedAt: null }))).toMatchObject({ status: 'provided', decidedAt: null });
    expect(readSelfie(answer({ status: 'approved' }))).toBeNull();
    expect(readSelfie(answer({ id: 'x' }))).toBeNull();
    expect(readSelfie(answer({ documentId: null }))).toBeNull();
    expect(readSelfie(answer({ decidedAt: 'yesterday' }))).toBeNull();
    expect(readSelfie([answer()])).toBeNull();
  });
});

describe('running an approved decision', () => {
  const request = { kind: 'identity.kyc_selfie.decide' as const, selfieId: SELFIE, decision: 'accepted' as const };

  it('decides the selfie at identity with the approval', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ result: { data: answer() } }));
    vi.stubGlobal('fetch', fn);
    const reply = await kycSelfieDecideExecute(ctx)(request, IDS);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/kyc.selfie.decide');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({ selfieId: SELFIE, decision: 'accepted', ...IDS });
    expect(reply).toMatchObject({ ok: true, detail: expect.stringContaining(`selfie ${SELFIE} as accepted`) });
  });

  it('refuses an answer for another selfie or another decision, and an identity refusal keeps its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: answer({ status: 'rejected' }) } })),
    );
    expect(await kycSelfieDecideExecute(ctx)(request, IDS)).toMatchObject({ ok: false, refusal: { code: 'admin.ops_invalid_response' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: answer({ id: '7a5b6c7d-8e9f-4a01-92b3-c4d5e6f70819' }) } })),
    );
    expect(await kycSelfieDecideExecute(ctx)(request, IDS)).toMatchObject({ ok: false, refusal: { code: 'admin.ops_invalid_response' } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'That selfie was already decided [kyc.selfie_decided]',
              code: -32603,
              data: { code: 'CONFLICT', httpStatus: 409 },
            },
          },
          { status: 409 },
        ),
      ),
    );
    expect(await kycSelfieDecideExecute(ctx)(request, IDS)).toMatchObject({
      ok: false,
      refusal: { code: 'kyc.selfie_decided', title: 'This selfie was already decided' },
    });
  });

  it('refuses any other request kind without calling identity', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const other = { kind: 'identity.kyc_document.open' as const, documentId: DOC };
    expect(await kycSelfieDecideExecute(ctx)(other, IDS)).toMatchObject({ ok: false, refusal: { code: 'admin.request_invalid' } });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('the decide control on a selfie row', () => {
  const row = (status: string): Row => ({
    id: SELFIE,
    cells: [
      { key: 'id', label: 'Selfie id', kind: 'text', detail: true, value: SELFIE },
      { key: 'status', label: 'Status', kind: 'text', detail: false, value: status },
    ],
  });

  it('offers a decision only on a selfie that waits', () => {
    const waiting = renderToStaticMarkup(<KycSelfieDecide row={row('provided')} userId={USER} onChanged={() => undefined} />);
    expect(waiting).toContain('data-testid="kyc-selfie-decide"');
    expect(waiting).toContain('Accept this selfie');
    const decided = renderToStaticMarkup(<KycSelfieDecide row={row('accepted')} userId={USER} onChanged={() => undefined} />);
    expect(decided).toContain('data-testid="kyc-selfie-no-decide"');
    expect(decided).toContain('This one is accepted');
  });
});
