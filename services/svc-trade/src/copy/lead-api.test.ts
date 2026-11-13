import Fastify, { type FastifyReply } from 'fastify';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  LEAD_CHECK_PATH,
  LEAD_SCOPE_REFUSAL,
  isApprovedLead,
  leadOrderGate,
  refuseLeadOrder,
  registerLeadCheck,
  type LeadListingRead,
} from './lead-api.js';

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

  it('a listed lead whose key or token lacks copy:lead is refused by scope before the listing is read', async () => {
    const sent: Array<{ status: number; body: unknown }> = [];
    const reply = {
      code(status: number) {
        return { send: async (body: unknown) => void sent.push({ status, body }) };
      },
    } as unknown as FastifyReply;
    let reads = 0;
    const counted: LeadListingRead = async (userId) => {
      reads += 1;
      return read(userId);
    };
    const tradeOnly = { userId: LEAD, kid: 'k1', scopes: ['trade:read', 'trade:write'] } as unknown as Principal;
    expect(await refuseLeadOrder(leadOrderGate(counted), tradeOnly, { symbol: 'BTC/USDT' }, reply)).toBe(true);
    expect(sent).toEqual([{ status: 403, body: LEAD_SCOPE_REFUSAL }]);
    expect(reads).toBe(0);
    // With the scope, the same listed lead on a listed instrument goes on to the ordinary path.
    expect(await refuseLeadOrder(leadOrderGate(counted), principal(LEAD), { symbol: 'BTC/USDT' }, reply)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  describe('the lead check door', () => {
    const SECRET = 's'.repeat(40);
    const ask = async (deps: { read: LeadListingRead }, body: unknown, caller?: string) => {
      const app = Fastify();
      retainRawBody(app);
      registerLeadCheck(app, { read: deps.read, secret: SECRET });
      const raw = JSON.stringify(body);
      const res = await app.inject({
        method: 'POST',
        url: LEAD_CHECK_PATH,
        payload: raw,
        headers: { 'content-type': 'application/json', ...(caller ? serviceAuthHeadersForBody(caller, SECRET, raw) : {}) },
      });
      await app.close();
      return res;
    };

    it('refuses a caller without service credentials (401) and any service but svc-identity (403)', async () => {
      expect((await ask({ read }, { userId: LEAD })).statusCode).toBe(401);
      const other = await ask({ read }, { userId: LEAD }, 'svc-p2p');
      expect(other.statusCode).toBe(403);
      expect(other.json()).toMatchObject({ code: 'trade.copy_lead_check_forbidden' });
    });

    it('answers svc-identity whether the account is a listed lead, and refuses a bad user id', async () => {
      expect((await ask({ read }, { userId: LEAD }, 'svc-identity')).json()).toMatchObject({ lead: true });
      expect((await ask({ read }, { userId: '1c9c5f8e-4a3d-4c2b-9e1f-7a6b5c4d3e2f' }, 'svc-identity')).json()).toMatchObject({
        lead: false,
      });
      expect((await ask({ read }, { userId: 'nope' }, 'svc-identity')).statusCode).toBe(400);
    });

    it('a failed read is 503, never "not a lead"', async () => {
      const broken: LeadListingRead = async () => {
        throw new Error('db down');
      };
      const res = await ask({ read: broken }, { userId: LEAD }, 'svc-identity');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'trade.copy_lead_check_unavailable' });
    });
  });
});
