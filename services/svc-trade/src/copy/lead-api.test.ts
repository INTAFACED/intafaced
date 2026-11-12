import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { LEAD_CHECK_PATH, isApprovedLead, leadOrderGate, registerLeadCheck, type LeadListingRead } from './lead-api.js';

const LEAD = '0b9c5f8e-4a3d-4c2b-9e1f-7a6b5c4d3e2f';
const principal = (userId: string) => ({ userId, scopes: ['trade:write', 'copy:lead'] }) as unknown as Principal;
const listings: Record<string, { state: string; assets: string[] }> = {
  [LEAD]: { state: 'listed', assets: ['BTC/USDT'] },
  suspended: { state: 'suspended', assets: ['BTC/USDT'] },
};
const read: LeadListingRead = async (userId) => listings[userId] ?? null;

describe('the lead API', () => {
  it('an approved lead is a listing in the listed state; suspended, delisted or none is not', async () => {
    expect(await isApprovedLead(read, LEAD)).toBe(true);
    expect(await isApprovedLead(read, 'suspended')).toBe(false);
    expect(await isApprovedLead(read, 'nobody')).toBe(false);
  });

  it('a listed lead on a listed instrument takes the ordinary path', async () => {
    expect(await leadOrderGate(read)(principal(LEAD), 'BTC/USDT')).toBeNull();
  });

  it('an instrument not on the listing is refused by name', async () => {
    const refusal = await leadOrderGate(read)(principal(LEAD), 'ETH/USDT');
    expect(refusal).toMatchObject({ status: 400, body: { intafacedCode: 'trade.copy_lead_instrument_unlisted' } });
    expect(refusal?.body.message).toContain('ETH/USDT is not on your lead listing');
    expect(await leadOrderGate(read)(principal(LEAD), undefined)).toMatchObject({ status: 400 });
  });

  it('an account that is no longer a listed lead is refused, whatever its key holds', async () => {
    for (const userId of ['suspended', 'nobody']) {
      expect(await leadOrderGate(read)(principal(userId), 'BTC/USDT')).toMatchObject({
        status: 403,
        body: { intafacedCode: 'trade.copy_lead_not_listed' },
      });
    }
  });

  it('the lead check refuses a caller without service credentials, and answers 503 rather than "not a lead" on a failed read', async () => {
    const app = Fastify();
    registerLeadCheck(app, { read, secret: 'x'.repeat(40) });
    const res = await app.inject({ method: 'POST', url: LEAD_CHECK_PATH, payload: { userId: LEAD } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
