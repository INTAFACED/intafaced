import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';
import {
  attachClosePosition,
  CLOSE_OUTCOME_UNKNOWN_MESSAGE,
  CLOSE_SETTLEMENT_PENDING_MESSAGE,
  CLOSE_SETTLEMENT_REFUSED,
  CLOSE_SETTLEMENT_REFUSED_MESSAGE,
  SPOT_CLOSE_POSITION_PATH,
} from './close-position.js';
import { SETTLEMENT_PENDING } from '../ledger-public-code.js';

/**
 * A close's ledger posts all come after the engine printed the flatten (the row is kept recovery_required), so the
 * close exists whatever the ledger said. The posting freeze and an outcome nobody knows are 503
 * `trade.settlement_pending`; a refusal the ledger's engine named is its own typed code; any other error is an unknown
 * outcome. Never `posting_frozen`, never a bare 500, and never the ledger's own message.
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
    ['an outcome nobody knows', new LedgerError('TEST upstream timed out', 'ledger.timeout')],
    // Raised before the key lookup: a retry of a post that committed can be refused this way, so it proves nothing.
    ['a refusal raised before the key lookup', new LedgerError('TEST key rotated', 'ledger.unauthenticated')],
  ])('%s is settlement pending (503), never posting_frozen or a 500', async (_name, error) => {
    const res = await closeThatThrows(error);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toEqual({ error: SETTLEMENT_PENDING, message: CLOSE_SETTLEMENT_PENDING_MESSAGE });
    expect(res.body).not.toContain('posting_frozen');
    // The posting freeze's free-text reason (TEST here) is an operator note, never published.
    expect(res.body).not.toContain('TEST');
  });

  it.each([
    ['insufficient funds', new InsufficientFundsError('TEST-account', 'USDT', '1', '0')],
    ['an entry the ledger refused', new LedgerError('TEST entry refused', 'ledger.invalid_entry')],
  ])('a named ledger refusal (%s) is its own typed code, not settlement pending, and never the ledger text', async (_name, error) => {
    const res = await closeThatThrows(error);
    expect(res.statusCode, res.body).toBe(500);
    expect(res.json()).toEqual({ error: CLOSE_SETTLEMENT_REFUSED, message: CLOSE_SETTLEMENT_REFUSED_MESSAGE });
    expect(res.body).not.toContain(SETTLEMENT_PENDING);
    expect(res.body).not.toContain('TEST');
  });

  it.each([
    ['a ledger reply without a code', new Error('svc-ledger /post failed (502): TEST raw ledger reply')],
    ['a transport deadline', new Error('TEST ledger deadline passed')],
  ])('an untyped error (%s) is an unknown outcome (503) in fixed words, never a bare 500 with its text', async (_name, error) => {
    const res = await closeThatThrows(error);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toEqual({ error: SETTLEMENT_PENDING, message: CLOSE_OUTCOME_UNKNOWN_MESSAGE });
    expect(res.body).not.toContain('TEST');
    expect(res.body).not.toContain('svc-ledger');
  });
});
