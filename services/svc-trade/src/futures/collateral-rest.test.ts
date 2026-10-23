import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { registerCollateralRest, type CollateralFigures, type CollateralRestDeps } from './collateral-rest.js';

const EDGE_SECRET = 'collateral-rest-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const A = parseAmount;

function headers(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

const SET: CollateralFigures = {
  free: A('980'),
  posted: A('1000'),
  committed: A('20'),
  haircutBps: 1000,
  credit: A('900'),
  buyingPower: A('880'),
};

function appWith(over: Partial<CollateralRestDeps> = {}) {
  const app = Fastify();
  const asked: string[] = [];
  registerCollateralRest(app, {
    edgeSecret: EDGE_SECRET,
    serviceName: 'svc-trade',
    settleAssets: async () => ['fixture-settlement', 'fixture-settlement'],
    figures: async (userId, asset) => {
      asked.push(`${userId}:${asset}`);
      return SET;
    },
    ...over,
  });
  return { app, asked };
}

describe('GET /api/v1/futures/collateral', () => {
  it('shows cash in each settle asset with the haircut and the buying power it leaves, for the caller only', async () => {
    const { app, asked } = appWith();
    const res = await app.inject({ method: 'GET', url: '/api/v1/futures/collateral', headers: headers() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().assets).toEqual([
      {
        asset: 'fixture-settlement',
        collateralClass: 'cash',
        counts: true,
        haircutBps: 1000,
        haircutReason: null,
        free: '980',
        posted: '1000',
        committed: '20',
        credit: '900',
        buyingPower: '880',
        buyingPowerReason: null,
      },
    ]);
    expect(asked).toEqual([`${USER}:fixture-settlement`]);
    await app.close();
  });

  it('a blank haircut reads "not set" with its code, and buying power says so; nothing is guessed', async () => {
    const { app } = appWith({ figures: async () => ({ ...SET, haircutBps: null, credit: null, buyingPower: null }) });
    const [row] = (await app.inject({ method: 'GET', url: '/api/v1/futures/collateral', headers: headers() })).json().assets;
    expect(row).toMatchObject({
      haircutBps: null,
      haircutReason: 'trade.haircut_unset',
      credit: null,
      buyingPower: null,
      buyingPowerReason: 'trade.haircut_unset',
      free: '980',
    });
    await app.close();
  });

  it('lists yield-bearing, staked and lending balances as refused, with their code', async () => {
    const { app } = appWith();
    const body = (await app.inject({ method: 'GET', url: '/api/v1/futures/collateral', headers: headers() })).json();
    expect(
      body.refusedClasses.map((r: { collateralClass: string; counts: boolean; code: string }) => [r.collateralClass, r.counts, r.code]),
    ).toEqual([
      ['yield_bearing', false, 'trade.unsupported_collateral_class'],
      ['staked', false, 'trade.unsupported_collateral_class'],
      ['lending_idle', false, 'trade.unsupported_collateral_class'],
    ]);
    await app.close();
  });

  it('refuses a signed-out caller', async () => {
    const { app, asked } = appWith();
    expect((await app.inject({ method: 'GET', url: '/api/v1/futures/collateral' })).statusCode).toBe(401);
    expect(asked).toEqual([]);
    await app.close();
  });
});
