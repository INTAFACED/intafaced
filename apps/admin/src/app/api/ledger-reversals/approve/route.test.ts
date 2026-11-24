import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsLedgerReversal } from '@intafaced/contracts/ops-ledger-reversals';
import { proposeInputFor } from '@/lib/desk/approval-hash';
import { confirmPhrase, decodePacket, type DeskRequest } from '@/lib/desk/approval-packet';
import { FOUNDER, founderCtx, treasuryToken } from '@/testing/recon-alert-fixtures.test-util';
import { POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: vi.fn(async () => null), adminBffSession: gate.session }));

const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVERSING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const T = '2026-11-24T08:00:00.000Z';
const reverse: DeskRequest = {
  kind: 'ops.ledger.reverse',
  requestNo: '1',
  originalTxId: ORIGINAL,
  reason: 'LOCAL TEST posted to the wrong account',
  caseRef: 'CASE-7',
};
const PHRASE = confirmPhrase(reverse);
const row = (over: Partial<OpsLedgerReversal>): OpsLedgerReversal => ({
  requestNo: '1',
  originalTxId: ORIGINAL,
  ordinal: '1',
  reason: 'LOCAL TEST posted to the wrong account',
  caseRef: 'CASE-7',
  state: 'posting',
  requestedBy: FOUNDER,
  requestedAt: T,
  approverId: APPROVER,
  approvedAt: T,
  ledgerKey: `ops:reversal:${ORIGINAL}:1`,
  reversingTxId: null,
  code: null,
  reversedBy: null,
  attempts: 1,
  lastAttemptAt: T,
  settledAt: null,
  ...over,
});
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/ledger-reversals/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const run = () => post({ step: 'execute', request: reverse, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
const approvalRow = {
  approvalId: 'appr_1',
  operationId: 'op_1',
  ...proposeInputFor(reverse),
  requesterId: FOUNDER,
  approverId: null,
  createdAt: T,
  expiresAt: T,
  status: 'PENDING',
};

const original = { ...process.env };
beforeEach(() => {
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = treasuryToken(FOUNDER);
  gate.session.mockResolvedValue(founderCtx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...original };
  gate.session.mockReset();
});

describe('a reversal request: the two-founder steps', () => {
  it('propose binds the governed approval to svc-ops and the request, as the founder, and hands back a packet', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ result: { data: approvalRow } }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'propose', request: reverse, confirm: PHRASE });
    expect(res.status).toBe(200);
    const read = decodePacket((await res.json()).packet);
    expect(read.ok && read.packet.request).toEqual(reverse);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/identity/trpc/actionApproval.propose');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      actionType: 'ops.ledger.reverse',
      targetService: 'svc-ops',
      targetId: 'reversal:1',
    });
  });

  it('identity refusing the requester as approver keeps its code: action_approval.same_person', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'the requester cannot approve their own action [action_approval.same_person]',
              code: -32603,
              data: { code: 'FORBIDDEN', httpStatus: 403 },
            },
          },
          { status: 403 },
        ),
      ),
    );
    const res = await post({ step: 'approve', request: reverse, confirm: PHRASE, approvalId: 'appr_1' });
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'action_approval.same_person', changed: 'no' } });
  });

  it('run sends the approval on the treasury transport; posted names the reversing transaction', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ result: { data: row({ state: 'posted', reversingTxId: REVERSING, settledAt: T }) } }),
    );
    vi.stubGlobal('fetch', fn);
    const res = await run();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.detail).toContain(`transaction ${REVERSING} reverses ${ORIGINAL}`);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/api/ops/trpc/ledgerReversals.execute');
    expect(JSON.parse(init!.body as string)).toEqual({ requestNo: '1', approvalId: 'appr_1', operationId: 'op_1' });
  });

  it('a lost ledger reply is never a success or a failure: outcome unknown, run again sends the same request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: row({ state: 'pending_retry', code: 'ledger.reply_lost' }) } })),
    );
    const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'ledger.reply_lost', changed: 'unknown' } });
  });

  it('a ledger refusal stored on the row is shown by its code; an answer for another request is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: row({ state: 'refused', code: 'ledger.insufficient_funds', settledAt: T }) } })),
    );
    expect(await (await run()).json()).toMatchObject({ ok: false, refusal: { code: 'ledger.insufficient_funds', changed: 'no' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ result: { data: row({ requestNo: '2', ledgerKey: `ops:reversal:${ORIGINAL}:2`, ordinal: '2' }) } }),
      ),
    );
    expect(await (await run()).json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('a founder who does not hold the treasury credential proposes and runs nothing, but can approve', async () => {
    process.env.ADMIN_TREASURY_TOKEN = treasuryToken(APPROVER);
    const fn = vi.fn(async () => Response.json({ result: { data: { ...approvalRow, status: 'APPROVED', approverId: FOUNDER } } }));
    vi.stubGlobal('fetch', fn);
    for (const step of ['propose', 'execute']) {
      const res = await post({ step, request: reverse, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ refusal: { code: 'admin.treasury_holder_mismatch' } });
    }
    expect(fn).not.toHaveBeenCalled();
    expect((await post({ step: 'approve', request: reverse, confirm: PHRASE, approvalId: 'appr_1' })).status).toBe(200);
  });
});
