import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { createListSessionsRouter } from './list-sessions-router.js';

const authConfig = {
  secret: 'an-identity-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SID = '44444444-4444-4444-8444-444444444444';
const sql = (async () => [
  {
    id: SID,
    family_id: SID,
    created_at: new Date(),
    last_used_at: new Date(),
    device: null,
    user_agent: null,
    ip: null,
    country: null,
  },
]) as never;

async function caller() {
  const { token } = await issueAccessToken({ userId: ME, sessionId: SID, scopes: ['identity:read'], tier: 'none', mfa: true }, authConfig);
  const ctx = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'r' };
  return createListSessionsRouter(sql).createCaller(ctx as never);
}
describe('L256', () => {
  it('own seats are listed', async () => {
    expect((await (await caller()).listSessions({ userId: ME, limit: 5 })).sessions).toHaveLength(1);
  });
  it("another user's live seats are refused for an identity:read principal", async () => {
    await expect((await caller()).listSessions({ userId: OTHER, limit: 5 })).rejects.toBeTruthy();
  });
});
