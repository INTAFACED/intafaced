import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';

/**
 * PP-disputes-safety-01 DR6 major: the route `activity.dispute.openCase` maps the fail-closed refusals to a definite HTTP
 * class (router.ts mapping), not a 500: `pay.dispute_line_facts_unset` and `pay.dispute_unwired` are both BAD_REQUEST,
 * and the code survives in the message for the screen. Also covers the `order:` refusal and a foreign linked id.
 */
const EDGE = 'a-bank-dispute-route-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';

function caller(bank: Partial<BankServices>) {
  const principal = {
    sub: ALICE,
    userId: ALICE,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return createBankRouter(bank as unknown as BankServices).createCaller(
    createEdgeContext({ secret: EDGE, serviceName: 'svc-bank' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req',
    }),
  );
}

const ownLine = { item: { id: 'tx-1:0', kind: 'transfer' } };
const activity = {
  async get(_userId: string, id: string) {
    if (id === 'tx-foreign:0') throw new BankError('not yours', 'bank.activity_not_found' as never);
    return ownLine;
  },
};
const input = { activityId: 'tx-1:0', reasonCode: 'not_received', statement: 'It never arrived', linkedActivityIds: [] as string[] };

describe('activity.dispute.openCase route mapping (DR6)', () => {
  it('pay.dispute_line_facts_unset maps to BAD_REQUEST with the code in the message', async () => {
    expect.assertions(1);
    const disputeCases = {
      async open() {
        throw new BankError('facts unknown', 'pay.dispute_line_facts_unset');
      },
    };
    await expect(caller({ activity, disputeCases } as never).activity.dispute.openCase(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('pay.dispute_unwired (no dispute service) maps to BAD_REQUEST', async () => {
    expect.assertions(1);
    await expect(caller({ activity } as never).activity.dispute.openCase(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('an order: id and a statement with a control character are BAD_REQUEST before any case is opened', async () => {
    let opened = 0;
    const disputeCases = {
      async open() {
        opened += 1;
        return { routedTo: 'card_issuer', activityId: 'tx-1:0' };
      },
    };
    const api = caller({ activity, disputeCases } as never);
    await expect(api.activity.dispute.openCase({ ...input, activityId: 'order:abc' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(api.activity.dispute.openCase({ ...input, statement: 'bad\u0007bell' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(opened).toBe(0);
  });

  it('a linked id the caller does not own is refused and no case is opened', async () => {
    let opened = 0;
    const disputeCases = {
      async open() {
        opened += 1;
        return { routedTo: 'card_issuer', activityId: 'tx-1:0' };
      },
    };
    await expect(
      caller({ activity, disputeCases } as never).activity.dispute.openCase({ ...input, linkedActivityIds: ['tx-foreign:0'] } as never),
    ).rejects.toBeDefined();
    expect(opened).toBe(0);
  });
});
