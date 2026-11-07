import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { MemoryPayeeWarningBook, PayeeWarnings } from './payee-warnings.js';
import { SupportService } from './support-service.js';

/** The scam warning on a first-time payee (BK-safe-02, J-bank-18 #2): once per person and payee, never for oneself. */

const authConfig = {
  secret: 'a-support-payee-warnings-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const ANN = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAT = '33333333-3333-4333-8333-333333333333';
const SESSION = '66666666-6666-4666-8666-666666666666';
const GUIDE = '/helpdetail?id=kb-security-scam-tactics';

async function caller(warnings: PayeeWarnings, userId: string) {
  const { token } = await issueAccessToken(
    { userId, sessionId: SESSION, scopes: ['support:read', 'support:write'], tier: 'none', mfa: true },
    authConfig,
  );
  const ctx: Context = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-payee' };
  const support = new SupportService();
  const args = new Array(16).fill(undefined) as unknown[];
  args[13] = null; // kbSegmentCap; then checks, safety, and the warnings last
  const router = (createSupportRouter as (...a: unknown[]) => ReturnType<typeof createSupportRouter>)(support, ...args, warnings);
  return router.createCaller(ctx);
}

describe('support.safety.payeeWarning', () => {
  it('shows for a first-time payee with the scam guide, and once read shows no more for that payee only', async () => {
    const warnings = new PayeeWarnings(new MemoryPayeeWarningBook(), () => new Date('2026-11-07T09:00:00.000Z'));
    const ann = await caller(warnings, ANN);
    expect(await ann.safety.payeeWarning({ payeeId: BOB })).toEqual({ payeeId: BOB, show: true, seenAt: null, guideHref: GUIDE });
    const seen = await ann.safety.payeeWarningSeen({ payeeId: BOB });
    expect(seen).toMatchObject({ show: false, seenAt: '2026-11-07T09:00:00.000Z' });
    expect((await ann.safety.payeeWarning({ payeeId: BOB })).show).toBe(false);
    expect((await ann.safety.payeeWarning({ payeeId: CAT })).show).toBe(true);
  });

  it('keeps the first read time when read again', async () => {
    let now = new Date('2026-11-07T09:00:00.000Z');
    const warnings = new PayeeWarnings(new MemoryPayeeWarningBook(), () => now);
    await warnings.seen(ANN, BOB);
    now = new Date('2026-11-08T09:00:00.000Z');
    expect((await warnings.seen(ANN, BOB)).seenAt).toBe('2026-11-07T09:00:00.000Z');
  });

  it('is per person: one person reading it leaves it showing for another paying the same payee', async () => {
    const warnings = new PayeeWarnings(new MemoryPayeeWarningBook());
    await (await caller(warnings, ANN)).safety.payeeWarningSeen({ payeeId: CAT });
    expect((await (await caller(warnings, BOB)).safety.payeeWarning({ payeeId: CAT })).show).toBe(true);
  });

  it('refuses oneself as the payee', async () => {
    const ann = await caller(new PayeeWarnings(new MemoryPayeeWarningBook()), ANN);
    await expect(ann.safety.payeeWarning({ payeeId: ANN })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'support.payee_self' },
    });
  });
});
