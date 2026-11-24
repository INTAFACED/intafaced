import { afterEach, describe, expect, it } from 'vitest';
import { consumeApproval, TradeOpsError } from './common.js';
import { identityApprovalBook } from './identity-approval.js';

const SECRET = 'test-internal-service-secret-32-chars';
const realFetch = globalThis.fetch;
const input = {
  approvalId: '11111111-1111-4111-8111-111111111111',
  actionType: 'trade.risk_set',
  targetId: 'market-1',
  expectedVersion: '1',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  operationId: '22222222-2222-4222-8222-222222222222',
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('identityApprovalBook.consume when identity does not answer', () => {
  it('says identity did not answer, not that the approval does not match (#8686)', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;
    const book = identityApprovalBook('http://identity.test', SECRET);
    await expect(book.consume(input)).resolves.toEqual({ ok: false, code: 'approval_unavailable' });
    const refused = await consumeApproval(book, input).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TradeOpsError);
    expect((refused as TradeOpsError).code).toBe('approval_unavailable');
    expect((refused as TradeOpsError).message).toBe('the approval service did not answer; nothing was written');
  });

  it('still calls an answer it cannot read a mismatch', async () => {
    globalThis.fetch = (async () =>
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await expect(identityApprovalBook('http://identity.test', SECRET).consume(input)).resolves.toEqual({
      ok: false,
      code: 'approval_mismatch',
    });
  });
});
