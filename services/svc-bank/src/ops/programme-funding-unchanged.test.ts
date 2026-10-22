import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';

/**
 * BK-cops-04 (DR3): a set to the model already in force spends no approval and records nothing. It refuses
 * `bank.funding_model_unchanged` before identity is asked, and get still reports changedAt/changedBy as null (never
 * changed). Through the real svc-bank router. TEST values only.
 */
const SECRET = 'c'.repeat(32);
const OPERATOR = '77777777-7777-4777-8777-777777777777';

function countingIdentity() {
  const seen: ActionApprovalConsumeInput[] = [];
  return {
    seen,
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      seen.push(input);
      throw new Error('identity must not be asked for a no-change set');
    },
  };
}

function caller(scopes: string[], approvals: ReturnType<typeof countingIdentity>) {
  const raw = encodePrincipal({
    sub: OPERATOR,
    userId: OPERATOR,
    sid: randomUUID(),
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter({} as BankServices, { approvals }).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

describe('ops.programmeFundingModelSet to the current model (BK-cops-04, DR3)', () => {
  it('refuses bank.funding_model_unchanged before any approval is consumed; get still says never changed', async () => {
    const identity = countingIdentity();
    const op = caller(['admin:treasury', 'admin:read'], identity);
    await expect(
      op.ops.programmeFundingModelSet({ model: 'jit', reason: 'TEST set the model in force', approvalId: 'appr-1', operationId: 'op-1' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/bank\.funding_model_unchanged/) });
    expect(identity.seen).toHaveLength(0);
    expect(await op.ops.programmeFundingModelGet()).toMatchObject({ current: 'jit', changedAt: null, changedBy: null });
  });
});
