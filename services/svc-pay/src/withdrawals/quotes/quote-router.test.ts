import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createPayRouter } from '../../router.js';
import type { PayService } from '../../payment-service.js';
import { CardSandboxAdapter } from '../../rails/card-sandbox.js';
import { RailRegistry } from '../../rails/registry.js';
import type { UserMoneyService } from '../../user-money-service.js';
import { WithdrawalQuoteError } from './errors.js';
import type { QuoteView } from './schemas.js';
import type { WithdrawalQuoteService } from './service.js';

/** `withdrawal.quote` through the real router: scope, strict input, the caller's own id, typed refusals. */
const SECRET = 'a-pay-quote-test-edge-secret-long-enough-x';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });
const rails = new RailRegistry([
  new CardSandboxAdapter({ secret: 'pay-quote-test-rail-secret-at-least-32-chars', toleranceSeconds: 300 }),
]);

function signed(scopes: string[]) {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-quote',
  });
}

const api = (svc: Partial<WithdrawalQuoteService> | null, scopes = ['trade:write']) =>
  createPayRouter(
    {} as PayService,
    rails,
    {} as UserMoneyService,
    null,
    undefined,
    undefined,
    null,
    undefined,
    null,
    null,
    svc as WithdrawalQuoteService | null,
  ).createCaller(signed(scopes));

const body = { quoteRef: 'q-1', assetId: 'USDT', networkId: 'tron-test', amount: '100' };
const view: QuoteView = {
  quoteRef: 'q-1',
  assetId: 'USDT',
  networkId: 'tron-test',
  amount: '100',
  feeMode: 'on_top',
  fees: [{ kind: 'network', amount: '2.5' }],
  feeTotal: '2.5',
  netAmount: '100',
  totalDebit: '102.5',
  feeSource: 'fixed',
  quotedAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-20T10:05:00.000Z',
  expired: false,
  acceptedBy: null,
};

describe('withdrawal.quote', () => {
  it('quotes for the signed-in user only', async () => {
    const asked: unknown[] = [];
    const caller = api({
      quote: async (userId, input) => {
        asked.push([userId, input]);
        return view;
      },
    });
    await expect(caller.withdrawal.quote(body)).resolves.toEqual(view);
    expect(asked).toEqual([[USER, body]]);
    await expect(caller.withdrawal.quote({ ...body, userId: 'someone-else' } as never)).rejects.toBeDefined();
    await expect(caller.withdrawal.quote({ ...body, amount: 100 } as never)).rejects.toBeDefined();
    await expect(caller.withdrawal.quote({ ...body, quoteRef: '' })).rejects.toBeDefined();
  });

  it('needs the write scope', async () => {
    await expect(api({ quote: async () => view }, ['trade:read']).withdrawal.quote(body)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('carries the typed refusal code to the client', async () => {
    const caller = api({
      quote: async () => {
        throw new WithdrawalQuoteError('pay.fee_unset', 'the withdrawal fee is not set');
      },
    });
    await expect(caller.withdrawal.quote(body)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('pay.fee_unset'),
    });
  });

  it('answers withdrawal_quote.unwired when no quote store is connected', async () => {
    await expect(api(null).withdrawal.quote(body)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('withdrawal_quote.unwired'),
    });
  });
});
