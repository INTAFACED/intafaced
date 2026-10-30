import { randomUUID } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { sandboxFundRequestId, sandboxResetRequestId } from '@intafaced/contracts/developer-sandboxes';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { createSandboxFundsRouter } from './router.js';
import { loadSandboxFundSettings } from './settings.js';

const principalOf = (scopes: Principal['scopes']): Principal => {
  const userId = randomUUID();
  return { userId, sub: userId, sid: randomUUID(), scopes, mfa: true, tier: 'none', expiresAt: new Date(Date.now() + 600_000) };
};
const ctxOf = (principal: Principal, service: Context['service'] = null): Context => ({
  principal,
  service,
  region: 'DE',
  requestId: randomUUID(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});
/** Blank settings refuse before the store is asked anything. */
const untouchable = (() => {
  throw new Error('database was called');
}) as unknown as Sql;
const blank = { fundAmount: null, resetsPerDay: null };

describe('sandboxFunds while the owner settings are blank (DV-sandbox-02)', () => {
  it('Fund refuses pay.sandbox_funds_unset before any database call, with the code as the cause', async () => {
    const principal = principalOf(['trade:write']);
    const sandboxId = randomUUID();
    const caller = createSandboxFundsRouter({ sql: untouchable, settings: blank }).createCaller(ctxOf(principal));
    const error = await caller.sandboxFunds
      .fund({ sandboxId, requestId: sandboxFundRequestId(principal.userId, sandboxId, 0) })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('[pay.sandbox_funds_unset]'),
      cause: { code: 'pay.sandbox_funds_unset' },
    });
  });

  it('Reset refuses pay.sandbox_reset_cap_unset before any database call', async () => {
    const principal = principalOf(['trade:write']);
    const sandboxId = randomUUID();
    const caller = createSandboxFundsRouter({ sql: untouchable, settings: blank }).createCaller(ctxOf(principal));
    await expect(
      caller.sandboxFunds.reset({ sandboxId, requestId: sandboxResetRequestId(principal.userId, sandboxId, 0) }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'pay.sandbox_reset_cap_unset' } });
  });

  it('refuses a session without trade:write, and an acting service, before the door answers', async () => {
    const sandboxId = randomUUID();
    const reader = principalOf(['trade:read']);
    await expect(
      createSandboxFundsRouter({ sql: untouchable, settings: blank })
        .createCaller(ctxOf(reader))
        .sandboxFunds.fund({ sandboxId, requestId: sandboxFundRequestId(reader.userId, sandboxId, 0) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const writer = principalOf(['trade:write']);
    await expect(
      createSandboxFundsRouter({ sql: untouchable, settings: blank })
        .createCaller(ctxOf(writer, 'svc-trade'))
        .sandboxFunds.fund({ sandboxId, requestId: sandboxFundRequestId(writer.userId, sandboxId, 0) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a malformed sandbox id at the schema', async () => {
    const caller = createSandboxFundsRouter({ sql: untouchable, settings: blank }).createCaller(ctxOf(principalOf(['trade:write'])));
    await expect(caller.sandboxFunds.fund({ sandboxId: 'nope', requestId: 'sandbox-fund:x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('loadSandboxFundSettings', () => {
  it('keeps both settings blank when unset, with no default', () => {
    expect(loadSandboxFundSettings({})).toEqual({ fundAmount: null, resetsPerDay: null });
    expect(loadSandboxFundSettings({ PAY_SANDBOX_FUND_AMOUNT: ' ', PAY_SANDBOX_RESETS_PER_DAY: '' })).toEqual(blank);
  });

  it('reads set values as written', () => {
    expect(loadSandboxFundSettings({ PAY_SANDBOX_FUND_AMOUNT: '1000.5', PAY_SANDBOX_RESETS_PER_DAY: '3' })).toEqual({
      fundAmount: '1000.5',
      resetsPerDay: 3,
    });
  });

  it.each([
    ['PAY_SANDBOX_FUND_AMOUNT', '0'],
    ['PAY_SANDBOX_FUND_AMOUNT', '-5'],
    ['PAY_SANDBOX_FUND_AMOUNT', '1e6'],
    ['PAY_SANDBOX_FUND_AMOUNT', '1.1234567'],
    ['PAY_SANDBOX_RESETS_PER_DAY', '0'],
    ['PAY_SANDBOX_RESETS_PER_DAY', '2.5'],
  ])('stops at boot on a malformed %s=%s rather than reading it as blank', (name, value) => {
    expect(() => loadSandboxFundSettings({ [name]: value })).toThrow(name);
  });
});
