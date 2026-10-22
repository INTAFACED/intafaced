import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import type { ApprovedRetryInput } from './schedule-retry-approval.js';

/**
 * BK-xfer-10 DR6 M3: `ops.retryScheduleRun` through the router: the `admin:write` scope, the acting operator taken
 * from the signed principal (never the input), and the HTTP class of each refusal.
 */
const EDGE = 'a-bank-retry-route-edge-secret-long-enough';
const OPERATOR = '55555555-5555-4555-8555-555555555555';
const SCHEDULE = '66666666-6666-4666-8666-666666666666';

function caller(desk: Partial<BankServices['scheduleRetryDesk']> | undefined, scopes: string[] = ['admin:write']) {
  const principal = {
    sub: OPERATOR,
    userId: OPERATOR,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return createBankRouter({ scheduleRetryDesk: desk } as unknown as BankServices).createCaller(
    createEdgeContext({ secret: EDGE, serviceName: 'svc-bank' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req',
    }),
  );
}
const input = { scheduleId: SCHEDULE, occurrence: 0, reason: 'customer topped up', approvalId: 'ap-1', operationId: 'op-1' };
const refusing = (code: string) => ({
  async retry(): Promise<never> {
    throw new BankError('refused', code as never);
  },
});

describe('ops.retryScheduleRun route (DR6 M3)', () => {
  it('passes the operator from the signed principal as actorId, with the approval and reason from the input', async () => {
    const seen: ApprovedRetryInput[] = [];
    const desk = {
      async retry(i: ApprovedRetryInput) {
        seen.push(i);
        return { status: 'settled' as const, ledgerTxId: 'tx-1', adopted: false };
      },
    };
    expect(await caller(desk as never).ops.retryScheduleRun(input)).toEqual({ status: 'settled', ledgerTxId: 'tx-1', adopted: false });
    expect(seen).toEqual([{ ...input, actorId: OPERATOR }]);
  });

  it('refuses a caller without admin:write (bank:write is not enough) before the desk is called', async () => {
    let called = 0;
    const desk = {
      async retry() {
        called += 1;
        return { status: 'settled' as const, ledgerTxId: 'tx-1', adopted: false };
      },
    };
    await expect(caller(desk as never, ['bank:read', 'bank:write']).ops.retryScheduleRun(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(called).toBe(0);
  });

  it('an actorId in the input is refused (strict input), so the operator cannot be chosen by the caller', async () => {
    await expect(
      caller(refusing('bank.schedule_not_found') as never).ops.retryScheduleRun({ ...input, actorId: 'someone' } as never),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it.each([
    ['bank.schedule_retry_approval_refused', 'FORBIDDEN'],
    ['bank.schedule_retry_approval_unwired', 'PRECONDITION_FAILED'],
    ['bank.schedule_retry_approval_stale', 'CONFLICT'],
    ['bank.schedule_paused', 'CONFLICT'],
    ['bank.schedule_inactive', 'CONFLICT'],
  ])('%s maps to %s', async (code, http) => {
    await expect(caller(refusing(code) as never).ops.retryScheduleRun(input)).rejects.toMatchObject({ code: http });
  });

  it('an unwired desk refuses as unwired (PRECONDITION_FAILED), never a 500', async () => {
    await expect(caller(undefined).ops.retryScheduleRun(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
