import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';
import { attachClosePosition, SPOT_CLOSE_POSITION_PATH } from './close-position.js';
import { SETTLEMENT_PENDING } from '../ledger-public-code.js';

/**
 * A close's ledger posts all come after the engine printed the flatten (the row is kept recovery_required), so a
 * ledger error there, the posting freeze included, is an unknown outcome the caller resolves by reading the order:
 * 503 `trade.settlement_pending`, never a refusal and never a bare 500.
 */
const SECRET = 'a-trade-close-ledger-refusal-edge-secret-xxxxxx';
const ALICE = '11111111-1111-4111-8111-111111111111';

function signed(): Record<string, string> {
  const raw = encodePrincipal({
    sub: ALICE,
    userId: ALICE,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

async function closeThatThrows(error: unknown) {
  const app = Fastify();
  attachClosePosition(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    closeSpotPosition: async () => {
      throw error;
    },
  });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: SPOT_CLOSE_POSITION_PATH,
    headers: signed(),
    payload: { clientOrderId: 'close-1', symbol: 'BTC/USDT' },
  });
  await app.close();
  return res;
}

describe('the close door under a ledger refusal after the engine', () => {
  it.each([
    ['the posting freeze', new LedgerError('Ledger posting is frozen: TEST', 'ledger.frozen')],
    ['any other ledger refusal', new InsufficientFundsError('a', 'USDT', '1', '0')],
  ])('%s is settlement pending (503), never posting_frozen or a 500', async (_name, error) => {
    const res = await closeThatThrows(error);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ error: SETTLEMENT_PENDING });
    expect(res.json().message).toMatch(/read the order before sending it again/);
    expect(res.body).not.toContain('posting_frozen');
  });

  it('an error that is not the ledger still reaches the error handler as before', async () => {
    const res = await closeThatThrows(new Error('boom'));
    expect(res.statusCode).toBe(500);
  });
});
