import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';

/** RC-portfolio-02 over the router: `bank.activity.taxEffectMap` returns the five rows and the unmapped code. */

const EDGE = 'a-bank-tax-effect-map-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const edge = createEdgeContext({ secret: EDGE, serviceName: 'svc-bank' });

function caller(scopes: string[]) {
  const principal = {
    sub: ALICE,
    userId: ALICE,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return createBankRouter({} as unknown as BankServices).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req',
    }),
  );
}

describe('bank.activity.taxEffectMap', () => {
  it('returns the five rows with their source events, mining blocked, and the unmapped code', async () => {
    const out = await caller(['bank:read']).activity.taxEffectMap({});
    expect(out.unmappedCode).toBe('portfolio.tax_effect_unmapped');
    expect(out.rows.map((row) => [row.type, row.effect, row.sourceEvent])).toEqual([
      ['p2p_sale', 'disposal', 'p2p/p2p.escrow.release'],
      ['p2p_purchase', 'acquisition', 'p2p/p2p.escrow.release'],
      ['card_spend', 'disposal', 'ledger/withdraw.held'],
      ['mining_payout', 'income', null],
      ['staking_reward', 'income', 'token/token.yield.distributed'],
    ]);
    expect(out.rows.find((row) => row.type === 'mining_payout')?.blocker).not.toBeNull();
  });

  it('refuses a caller without bank:read', async () => {
    await expect(caller(['trade:read']).activity.taxEffectMap({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a smuggled owner field instead of reading another user', async () => {
    await expect(caller(['bank:read']).activity.taxEffectMap({ userId: 'someone-else' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
