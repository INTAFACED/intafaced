import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { payloadHashFor, proposeInputFor } from '@/lib/desk/approval-hash';
import { confirmPhrase, readDeskRequest, requestReason, type DeskRequest } from '@/lib/desk/approval-packet';
import { treasuryToken } from '@/lib/recon-alerts/fixtures.test-util';
import { readStampAnswer, restoreExecute } from './execute';

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
const ids = { approvalId: 'appr_1', operationId: 'op_1' };
const ok = (data: unknown) => Response.json({ result: { data } });
const err = (status: number, message: string, code: string) =>
  Response.json({ error: { message, code: -32603, data: { code: 'X', httpStatus: status, cause: { code } } } }, { status });
const stamp: DeskRequest = { kind: 'ops.restore.record', service: 'ledger', stampKind: 'ledger_tx.seq', watermark: '4711' };
const finalize: DeskRequest = { kind: 'ops.restore.finalize', restoreNo: 'R-1', cutOff: '2026-10-30T12:00:00.000Z' };
/** svc-ops' `approvalPayloadHash`: `{ actionType, ...fields }` in the order the service builds the fields. */
const opsHash = (actionType: string, fields: Record<string, string>) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType, ...fields }))
    .digest('hex')}`;

const original = { ...process.env };
beforeEach(() => {
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = treasuryToken(ctx.session.userId);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...original };
});

describe('restore requests in the approval packet', () => {
  it('reads exactly the stamp and finalize shapes, and nothing looser', () => {
    expect(readDeskRequest({ ...stamp })).toEqual(stamp);
    expect(readDeskRequest({ ...finalize })).toEqual(finalize);
    expect(readDeskRequest({ ...stamp, service: 'trade' })).toBeNull();
    expect(readDeskRequest({ ...stamp, stampKind: 'Ledger seq' })).toBeNull();
    expect(readDeskRequest({ ...stamp, watermark: ' 4711' })).toBeNull();
    expect(readDeskRequest({ ...stamp, watermark: '' })).toBeNull();
    expect(readDeskRequest({ ...stamp, watermark: '12 34' })).toBeNull();
    expect(readDeskRequest({ ...stamp, watermark: '9'.repeat(257) })).toBeNull();
    expect(readDeskRequest({ ...stamp, reason: 'TEST extra field here' })).toBeNull();
    // svc-ops signs the cut-off exactly as it stored it (`toISOString`); another spelling of the same instant is a different request.
    expect(readDeskRequest({ ...finalize, cutOff: '2026-10-30T12:00:00Z' })).toBeNull();
    expect(readDeskRequest({ ...finalize, cutOff: 'now' })).toBeNull();
    expect(readDeskRequest({ ...finalize, restoreNo: ' R-1' })).toBeNull();
  });

  it('signs what svc-ops consumes: action, target and the field order of its own hash', () => {
    expect(proposeInputFor(stamp)).toEqual({
      actionType: 'ops.restore.record',
      targetService: 'svc-ops',
      targetId: 'watermark:ledger:ledger_tx.seq',
      expectedVersion: '1',
      payloadHash: opsHash('ops.restore.record', { service: 'ledger', kind: 'ledger_tx.seq', watermark: '4711' }),
      policyVersion: 'v1',
    });
    expect(proposeInputFor(finalize)).toEqual({
      actionType: 'ops.restore.finalize',
      targetService: 'svc-ops',
      targetId: 'restore:R-1',
      expectedVersion: '1',
      payloadHash: opsHash('ops.restore.finalize', { restoreNo: 'R-1', cutOff: '2026-10-30T12:00:00.000Z' }),
      policyVersion: 'v1',
    });
    expect(payloadHashFor({ ...stamp, watermark: '4712' } as DeskRequest)).not.toBe(payloadHashFor(stamp));
  });

  it('asks for a typed phrase and carries no reason', () => {
    expect(confirmPhrase(stamp)).toBe('STAMP LEDGER 4711');
    expect(confirmPhrase(finalize)).toBe('FINALIZE RESTORE R-1');
    expect(requestReason(stamp)).toBeNull();
    expect(requestReason(finalize)).toBeNull();
  });
});

describe('running a restore request', () => {
  it('records a stamp under a key tied to the approval, through the edge on the treasury credential', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) =>
      ok({ service: 'ledger', kind: 'ledger_tx.seq', watermark: '4711', recordedAt: '2026-10-30T12:01:00.000Z', restored: false }),
    );
    vi.stubGlobal('fetch', fn);
    expect(await restoreExecute(ctx)(stamp, ids)).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/ops/trpc/restore.record');
    expect(JSON.parse(String(init!.body))).toEqual({
      service: 'ledger',
      kind: 'ledger_tx.seq',
      watermark: '4711',
      idempotencyKey: 'restore:stamp:appr_1',
      ...ids,
    });
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${process.env.ADMIN_TREASURY_TOKEN}`);
  });

  it('counts a stamp as done only when the stored one is the one asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ service: 'ledger', kind: 'ledger_tx.seq', watermark: '9', recordedAt: '2026-10-30T12:01:00.000Z' })),
    );
    expect(await restoreExecute(ctx)(stamp, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    expect(readStampAnswer({ service: 'ledger' })).toBeNull();
  });

  it('finalizes under the run key and says restored only when svc-ops does', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ run: { restoreNo: 'R-1' }, steps: [], restored: true, next: null }));
    vi.stubGlobal('fetch', fn);
    const reply = await restoreExecute(ctx)(finalize, ids);
    expect(reply).toMatchObject({ ok: true, detail: expect.stringContaining('is restored') });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/ops/trpc/restore.finalize');
    expect(JSON.parse(String(init!.body))).toEqual({ restoreNo: 'R-1', idempotencyKey: 'restore:finalize:R-1', ...ids });
  });

  it('a disagreeing joint watermark is refused in the room’s words, with svc-ops’ code and nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(409, 'Nothing was restored: identity: position_differs.', 'ops.restore_watermarks_disagree')),
    );
    expect(await restoreExecute(ctx)(finalize, ids)).toMatchObject({
      ok: false,
      refusal: { code: 'ops.restore_watermarks_disagree', changed: 'no', title: expect.stringContaining('do not agree') },
    });
  });

  it('a dropped connection is unknown, never a failure to retry blindly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket hang up'))),
    );
    expect(await restoreExecute(ctx)(stamp, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('sends nothing while the treasury credential belongs to another founder', async () => {
    process.env.ADMIN_TREASURY_TOKEN = treasuryToken('22222222-2222-4222-8222-222222222222');
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect(await restoreExecute(ctx)(finalize, ids)).toMatchObject({
      ok: false,
      refusal: { code: 'admin.treasury_holder_mismatch', changed: 'no' },
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends nothing while this console holds no treasury credential', async () => {
    delete process.env.ADMIN_TREASURY_TOKEN;
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect(await restoreExecute(ctx)(stamp, ids)).toMatchObject({ ok: false, refusal: { changed: 'no' } });
    expect(fn).not.toHaveBeenCalled();
  });
});
