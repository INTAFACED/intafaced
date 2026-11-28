import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from '../router.js';
import type { SupportService } from '../support-service.js';

/** Test-only: the support router's caller for one signed-in person with these scopes, as the edge forwards them. */
const authConfig = {
  secret: 'a-support-router-caller-fixture-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

export async function callerAs(support: SupportService, userId: string, scopes: string[]) {
  const { token } = await issueAccessToken(
    { userId, sessionId: '66666666-6666-4666-8666-666666666666', scopes, tier: 'none', mfa: true },
    authConfig,
  );
  const ctx: Context = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-fixture' };
  return createSupportRouter(support).createCaller(ctx);
}
