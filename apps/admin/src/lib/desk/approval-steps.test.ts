import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePacket, type DeskRequest } from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';
import { approvalMatchesRequest, auditLine, parseStepBody, runStep, type ExecuteFn, type StepBody } from './approval-steps';
import type { FounderCallContext } from './founder-call';

const ctx: FounderCallContext = {
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
const kill: DeskRequest = { kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident' };

const row = (request: DeskRequest, over: Record<string, unknown> = {}) => {
  const p = proposeInputFor(request);
  return {
    approvalId: 'appr_1',
    operationId: 'op_1',
    actionType: p.actionType,
    targetService: p.targetService,
    targetId: p.targetId,
    expectedVersion: p.expectedVersion,
    payloadHash: p.payloadHash,
    requesterId: ctx.session.userId,
    approverId: null,
    policyVersion: 'v1',
    createdAt: '2026-10-17T03:00:00.000Z',
    expiresAt: '2026-10-17T03:10:00.000Z',
    status: 'PENDING',
    ...over,
  };
};
const trpcOk = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string, trpcCode = 'FORBIDDEN') =>
  Response.json({ error: { message, code: -32603, data: { code: trpcCode, httpStatus: status } } }, { status });

afterEach(() => vi.unstubAllGlobals());
const stub = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const fn = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
};
const neverExecute: ExecuteFn = async () => {
  throw new Error('execute must not be called');
};
const body = (over: Partial<StepBody>): StepBody => ({
  step: 'propose',
  request: kill,
  confirm: 'KILL trade',
  approvalId: null,
  operationId: null,
  ...over,
});

describe('parseStepBody', () => {
  const ok = { step: 'propose', request: { ...kill }, confirm: 'KILL trade' };
  it('accepts a well-formed propose and trims the reason before it is hashed', () => {
    const r = parseStepBody({ ...ok, request: { ...kill, reason: '  market integrity incident  ' } });
    expect(r).toMatchObject({ ok: true, body: { step: 'propose', request: { reason: 'market integrity incident' } } });
  });
  it('refuses a missing or wrong typed phrase on propose, approve and execute', () => {
    for (const step of ['propose', 'approve', 'execute']) {
      for (const confirm of ['', 'kill trade', 'KILL pay', 'KILL trade ']) {
        const r = parseStepBody({ step, request: kill, confirm, approvalId: 'appr_1', operationId: 'op_1' });
        expect(r.ok).toBe(false);
      }
    }
  });
  it('needs no phrase to reject or withdraw, only the approval id', () => {
    expect(parseStepBody({ step: 'reject', approvalId: 'appr_1' })).toMatchObject({ ok: true });
    expect(parseStepBody({ step: 'revoke', approvalId: 'appr_1' })).toMatchObject({ ok: true });
    expect(parseStepBody({ step: 'reject' }).ok).toBe(false);
  });
  it('takes a step-up code only on execute, and only as six digits', () => {
    const exec = { step: 'execute', request: kill, confirm: 'KILL trade', approvalId: 'appr_1', operationId: 'op_1' };
    expect(parseStepBody({ ...exec, stepUpCode: '123456' })).toMatchObject({ ok: true, body: { stepUpCode: '123456' } });
    for (const bad of ['12345', '1234567', 'abcdef', 123456]) expect(parseStepBody({ ...exec, stepUpCode: bad }).ok).toBe(false);
    expect(parseStepBody({ step: 'approve', request: kill, confirm: 'KILL trade', approvalId: 'appr_1', stepUpCode: '123456' }).ok).toBe(
      false,
    );
  });
  it('execute needs both ids; approve needs the approval id', () => {
    expect(parseStepBody({ step: 'execute', request: kill, confirm: 'KILL trade', approvalId: 'appr_1' }).ok).toBe(false);
    expect(parseStepBody({ step: 'approve', request: kill, confirm: 'KILL trade' }).ok).toBe(false);
  });
  it('refuses unknown steps, non-objects, bad ids and reasons that are too short', () => {
    for (const raw of [
      null,
      [],
      'x',
      { step: 'flip' },
      { ...ok, request: { ...kill, reason: 'short' } },
      { step: 'reject', approvalId: 'has space' },
    ]) {
      expect(parseStepBody(raw).ok).toBe(false);
    }
  });
});

describe('propose', () => {
  it('asks identity for an approval bound to exactly this request, as the founder, and returns a packet for it', async () => {
    const fn = stub(() => trpcOk(row(kill)));
    const reply = await runStep(ctx, body({}), neverExecute);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/identity/trpc/actionApproval.propose');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(JSON.parse(init.body as string)).toEqual(proposeInputFor(kill));
    expect(reply.ok).toBe(true);
    if (reply.ok && reply.step === 'propose') {
      const read = decodePacket(reply.packet ?? '');
      expect(read.ok && read.packet.request).toEqual(kill);
      expect(read.ok && read.packet.approvalId).toBe('appr_1');
      expect(read.ok && read.packet.requesterId).toBe(ctx.session.userId);
    }
  });
  it('hands out NO packet when identity stored something other than what was asked', async () => {
    stub(() => trpcOk(row(kill, { targetId: 'kill:ledger' })));
    const reply = await runStep(ctx, body({}), neverExecute);
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.refusal.changed).toBe('unknown');
  });
  it('maps identity refusals to plain words and says nothing changed', async () => {
    stub(() => trpcErr(403, 'this action type is an operator action [action_approval.operator_only]'));
    const reply = await runStep(ctx, body({}), neverExecute);
    expect(!reply.ok && reply.refusal).toMatchObject({ code: 'action_approval.operator_only', changed: 'no' });
  });
  it('a dropped connection on a write is "not known", not a failure', async () => {
    stub(() => {
      throw new Error('socket hang up');
    });
    const reply = await runStep(ctx, body({}), neverExecute);
    expect(!reply.ok && reply.refusal.changed).toBe('unknown');
  });
});

describe('approve', () => {
  const approve = (request: DeskRequest = kill) => body({ step: 'approve', request, approvalId: 'appr_1' });
  it('signs off on the payload hash recomputed from the request the approver read', async () => {
    const fn = stub(() => trpcOk(row(kill, { approverId: '22222222-2222-4222-8222-222222222222', status: 'APPROVED' })));
    const reply = await runStep(ctx, approve(), neverExecute);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/identity/trpc/actionApproval.approve');
    expect(JSON.parse(init.body as string)).toEqual({ approvalId: 'appr_1', expectedPayloadHash: payloadHashFor(kill) });
    expect(reply).toMatchObject({ ok: true, step: 'approve', matchesReviewedRequest: true });
  });
  it('flags an approval whose stored request is not the one that was read', async () => {
    stub(() => trpcOk(row({ ...kill, module: 'pay' }, { status: 'APPROVED', approverId: '22222222-2222-4222-8222-222222222222' })));
    const reply = await runStep(ctx, approve(), neverExecute);
    expect(reply).toMatchObject({ ok: true, matchesReviewedRequest: false });
  });
  it('identity refusing a mismatched payload is explained and approves nothing', async () => {
    stub(() =>
      trpcErr(
        412,
        'the approval is for a different payload than the one reviewed [action_approval.payload_mismatch]',
        'PRECONDITION_FAILED',
      ),
    );
    const reply = await runStep(ctx, approve(), neverExecute);
    expect(!reply.ok && reply.refusal).toMatchObject({ code: 'action_approval.payload_mismatch', changed: 'no' });
  });
  it('the requester approving their own request is refused by identity and explained', async () => {
    stub(() => trpcErr(412, 'the requester cannot approve their own action [action_approval.same_person]', 'PRECONDITION_FAILED'));
    const reply = await runStep(ctx, approve(), neverExecute);
    expect(!reply.ok && reply.refusal.title).toContain('different founder');
  });
});

describe('reject and withdraw', () => {
  it('call identity’s reject and revoke with only the approval id', async () => {
    const fn = stub(() => trpcOk(row(kill, { status: 'REJECTED', approverId: '22222222-2222-4222-8222-222222222222' })));
    await runStep(ctx, body({ step: 'reject', request: null, approvalId: 'appr_1', confirm: '' }), neverExecute);
    await runStep(ctx, body({ step: 'revoke', request: null, approvalId: 'appr_1', confirm: '' }), neverExecute);
    expect(fn.mock.calls.map((c) => c[0])).toEqual([
      'http://edge:4000/api/identity/trpc/actionApproval.reject',
      'http://edge:4000/api/identity/trpc/actionApproval.revoke',
    ]);
    for (const c of fn.mock.calls) expect(JSON.parse(c[1].body as string)).toEqual({ approvalId: 'appr_1' });
  });
});

describe('execute', () => {
  it('hands the request and the ids to the owning service’s executor and reports what it said', async () => {
    const execute = vi.fn<ExecuteFn>(async () => ({ ok: true, detail: 'svc-edge answered 200' }));
    const reply = await runStep(ctx, body({ step: 'execute', approvalId: 'appr_1', operationId: 'op_1' }), execute);
    expect(execute).toHaveBeenCalledWith(kill, { approvalId: 'appr_1', operationId: 'op_1' });
    expect(reply).toEqual({ ok: true, step: 'execute', detail: 'svc-edge answered 200' });
  });
  it('hands a step-up code to the executor only when one was sent', async () => {
    const execute = vi.fn<ExecuteFn>(async () => ({ ok: true, detail: 'ok' }));
    await runStep(ctx, body({ step: 'execute', approvalId: 'appr_1', operationId: 'op_1', stepUpCode: '123456' }), execute);
    expect(execute).toHaveBeenCalledWith(kill, { approvalId: 'appr_1', operationId: 'op_1', stepUpCode: '123456' });
  });
  it('passes a refusal through unchanged', async () => {
    const refusal = { title: 't', body: 'b', next: 'n', code: 'action_approval.not_approved', changed: 'no' as const };
    const reply = await runStep(ctx, body({ step: 'execute', approvalId: 'appr_1', operationId: 'op_1' }), async () => ({
      ok: false,
      refusal,
    }));
    expect(reply).toEqual({ ok: false, step: 'execute', refusal });
  });
});

describe('approvalMatchesRequest', () => {
  it('is true only when action, target, version and hash all match', () => {
    const base = row(kill) as never;
    expect(approvalMatchesRequest(base, kill)).toBe(true);
    for (const over of [
      { actionType: 'x' },
      { targetService: 'svc-ledger' },
      { targetId: 'kill:pay' },
      { expectedVersion: '2' },
      { payloadHash: 'sha256:00' },
    ]) {
      expect(approvalMatchesRequest({ ...row(kill), ...over } as never, kill)).toBe(false);
    }
  });
});

describe('audit line', () => {
  it('names the founder, the step and the module, and never the reason or a credential', () => {
    const line = auditLine(ctx, body({ step: 'execute', approvalId: 'appr_1', operationId: 'op_1' }), {
      ok: true,
      step: 'execute',
      detail: 'x',
    });
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      audit: 'admin.desk.step',
      founder: ctx.session.userId,
      step: 'execute',
      module: 'trade',
      approvalId: 'appr_1',
      ok: true,
    });
    expect(line).not.toContain(kill.reason);
    expect(line).not.toContain('founder-access-token');
  });
});
