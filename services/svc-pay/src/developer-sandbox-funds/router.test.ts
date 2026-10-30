import { randomUUID } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { sandboxFundRequestId } from '@intafaced/contracts/developer-sandboxes';
import { describe, expect, it } from 'vitest';
import { createSandboxFundsRouter } from './router.js';

const principalOf = (scopes: Principal['scopes']): Principal => {
  const userId = randomUUID();
  return { userId, sub: userId, sid: randomUUID(), scopes, mfa: true, tier: 'none', expiresAt: new Date(Date.now() + 600_000) };
};
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: randomUUID(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

describe('sandboxFunds.fund (DV-sandbox-02)', () => {
  it('refuses pay.sandbox_funds_unset for a signed-in person on any tier, with the code as the cause', async () => {
    const principal = principalOf(['trade:write']);
    const sandboxId = randomUUID();
    const caller = createSandboxFundsRouter().createCaller(ctxOf(principal));
    const error = await caller.sandboxFunds
      .fund({ sandboxId, requestId: sandboxFundRequestId(principal.userId, sandboxId, null) })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('[pay.sandbox_funds_unset]'),
      cause: { code: 'pay.sandbox_funds_unset' },
    });
  });

  it('refuses a session without trade:write before the door answers', async () => {
    const principal = principalOf(['trade:read']);
    const sandboxId = randomUUID();
    const caller = createSandboxFundsRouter().createCaller(ctxOf(principal));
    await expect(
      caller.sandboxFunds.fund({ sandboxId, requestId: sandboxFundRequestId(principal.userId, sandboxId, null) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a malformed sandbox id at the schema', async () => {
    const caller = createSandboxFundsRouter().createCaller(ctxOf(principalOf(['trade:write'])));
    await expect(caller.sandboxFunds.fund({ sandboxId: 'nope', requestId: 'sandbox-fund:x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
