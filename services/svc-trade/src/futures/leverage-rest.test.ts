import { PositionService } from '../controls/test-admission.js';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { FuturesError } from './position-service.js';
import { memoryMarkBook } from './mark-source.js';

const SECRET = 'futures-leverage-rest-edge-secret-long-enough';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function headers(): Record<string, string> {
  const principal = {
    sub: USER_ID,
    userId: USER_ID,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const encoded = encodePrincipal(principal);
  return {
    'x-intafaced-principal': encoded,
    'x-intafaced-principal-sig': signPrincipalHeader(encoded, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

describe('POST /api/v1/futures/leverage', () => {
  it('returns the typed unset-cap refusal without inventing 10x', async () => {
    const setLeverage = vi.fn(async () => {
      throw new FuturesError('listing leverage cap is unset', 'trade.leverage_cap_unset', 503);
    });
    const app = Fastify();
    registerPrivateRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      setLeverage,
    } as unknown as PrivateRestDeps);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/futures/leverage',
      headers: headers(),
      payload: { symbol: 'BTC/USDT-PERP', leverage: '4.25', marginMode: 'isolated' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'trade.leverage_cap_unset' });
    expect(setLeverage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      expect.objectContaining({ symbol: 'BTC/USDT-PERP', leverage: '4.25' }),
    );

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/futures/leverage',
      headers: headers(),
      payload: { symbol: 'BTC/USDT-PERP', leverage: 10, marginMode: 'isolated' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ intafacedCode: 'trade.leverage_required' });
    expect(setLeverage).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('an unset owner/listing cap refuses before SQL or ledger mutation', async () => {
    const sql = vi.fn(() => {
      throw new Error('SQL must not be reached');
    });
    const ledger = {
      post: vi.fn(async () => {
        throw new Error('ledger must not be reached');
      }),
      balance: vi.fn(async () => 0n),
    };
    const marks = memoryMarkBook();
    const positions = new PositionService(sql as never, ledger as never, {
      marks: marks.source(),
      profitSource: null,
      maxLeverage: null,
    });

    await expect(positions.setLeverage({ userId: USER_ID, symbol: 'BTC/USDT-PERP', leverage: parseAmount('4.25') })).rejects.toMatchObject({
      code: 'trade.leverage_cap_unset',
    });
    expect(sql).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
    expect(ledger.balance).not.toHaveBeenCalled();
  });
});
