import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { MemorySupportStore } from './store.js';

/**
 * SP-help-centre-02: per-segment visibility. A blank segment cap refuses support.kb_segment_cap_unset; a set cap still
 * refuses support.kb_segment_membership_unwired, because membership is svc-identity's answer through a contract that
 * does not exist yet. Either way the article is untouched.
 */

const authConfig = {
  secret: 'a-support-kb-segment-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-visitor' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-kb-segment' };
}

async function desk(cap: number | null) {
  const store = new MemorySupportStore();
  const support = new SupportService(store);
  const router = createSupportRouter(
    support,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    cap,
  );
  const staff = router.createCaller(await ctx(AGENT, ['support:ops', 'support:read', 'support:write']));
  const customer = router.createCaller(await ctx(CUSTOMER, ['support:read', 'support:write']));
  const visitor = router.createCaller(await ctx(null, []));
  const article = await staff.publishKb({
    id: 'zz-seg',
    titleKey: 'support.kb.zz-seg.title',
    bodyKey: 'support.kb.zz-seg.body',
    baseRevision: 0,
  });
  return { store, staff, customer, visitor, article };
}

describe('help article segments (SP-help-centre-02)', () => {
  it('with the segment cap blank, restricting an article refuses support.kb_segment_cap_unset and stores nothing', async () => {
    const { store, staff, article } = await desk(null);
    await expect(staff.setKbSegment({ id: 'zz-seg', segment: 'TEST vip' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.kb_segment_cap_unset',
    });
    const after = await staff.getKb({ id: 'zz-seg' });
    expect(after?.revision).toBe(article.revision);
    expect(after?.audience ?? 'public').toBe('public');
    expect(await store.listKbAudienceChanges('zz-seg')).toEqual([]);
  });

  it('with a cap set it refuses support.kb_segment_membership_unwired and the article is unchanged', async () => {
    const { staff, article } = await desk(3);
    await expect(staff.setKbSegment({ id: 'zz-seg', segment: 'TEST vip' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.kb_segment_membership_unwired',
    });
    expect(await staff.getKb({ id: 'zz-seg' })).toMatchObject({ revision: article.revision });
  });

  it('needs support:ops and a segment name', async () => {
    const { staff, customer, visitor } = await desk(null);
    await expect(customer.setKbSegment({ id: 'zz-seg', segment: 'TEST vip' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(visitor.setKbSegment({ id: 'zz-seg', segment: 'TEST vip' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(staff.setKbSegment({ id: 'zz-seg', segment: '  ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
