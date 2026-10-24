import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, spendFiguresOf } from '@intafaced/contracts';
import { InsufficientFundsError, parseAmount, type Balance } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { createBankRouter } from './router.js';
import type { BankServices } from './bank-service.js';
import { BankError } from './errors.js';
import { SpendFiguresReader } from './insufficient-funds.js';

/**
 * RC-wallet-09 through the real router: `transfers.create` refused for funds answers
 * `bank.insufficient_funds` with the caller's own figures, and nothing is posted.
 */

const SECRET = 'a-bank-insufficient-funds-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FROM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THEIRS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function signed(userId: string) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-insufficient',
  });
}

const space = (id: string, userId: string) => ({ id, userId, assetId: 'USDT', kind: 'named', name: id, archivedAt: null });

function bal(kind: 'available' | 'hold', amount: string, ownerId = USER): Balance {
  return {
    account: { ownerType: 'user', ownerId, assetId: 'USDT', kind },
    accountId: `${ownerId}:${kind}`,
    amount: parseAmount(amount),
  } as Balance;
}

function build(opts: { transferError: unknown; earnFails?: boolean }) {
  const posted: unknown[] = [];
  const spaces = new Map([FROM, MINE].map((id) => [id, space(id, USER)]));
  spaces.set(THEIRS, space(THEIRS, OTHER));
  const sql = ((_s: TemplateStringsArray, ...values: unknown[]) =>
    opts.earnFails
      ? Promise.reject(new Error('earn read down'))
      : Promise.resolve(values[0] === USER ? [{ principal: '20' }] : [{ principal: '999' }])) as unknown as Sql;
  const ledger = {
    balances: async (_t: string, ownerId: string) =>
      [bal('available', '10'), bal('hold', '5'), bal('available', '777', OTHER)].filter((b) => b.account.ownerId === ownerId),
  };
  const bank = {
    spaces: {
      get: async (id: string) => {
        const s = spaces.get(id);
        if (!s) throw new BankError('no space', 'bank.space_not_found');
        return s;
      },
      find: async (id: string) => spaces.get(id) ?? null,
    },
    transfers: {
      transfer: async (input: unknown) => {
        posted.push(input);
        throw opts.transferError;
      },
    },
    spendFigures: new SpendFiguresReader(sql, ledger),
    // Nobody here is a member of a shared pot (BK-acct-09): both transfer checks let the call through.
    sharedPots: { assertMayTakeOut: async () => undefined, assertMayAddTo: async () => undefined },
  } as unknown as BankServices;
  const router = createBankRouter(bank);
  return { caller: router.createCaller(signed(USER)), posted };
}

const spend = (toSpaceId: string) => ({ transferId: 'rc-wallet-09-spend-1', fromSpaceId: FROM, toSpaceId, amount: '12' });
const refusedForFunds = () => new InsufficientFundsError('acct', 'USDT', '12', '10');

async function causeOf(p: Promise<unknown>): Promise<unknown> {
  const err = await p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  expect((err as { code?: string }).code).toBe('BAD_REQUEST');
  return (err as { cause?: unknown }).cause;
}

describe('RC-wallet-09 transfers.create refused for funds', () => {
  it('answers bank.insufficient_funds with 10 available, 5 on hold, 20 in earn on the wire', async () => {
    const { caller, posted } = build({ transferError: refusedForFunds() });
    const cause = await causeOf(caller.transfers.create(spend(MINE)));
    expect((cause as BankError).code).toBe('bank.insufficient_funds');
    expect(spendFiguresOf(cause)).toEqual({ assetId: 'USDT', available: '10', onHold: '5', inEarn: '20' });
    expect(posted).toHaveLength(1); // the one attempt the ledger refused; nothing else
  });

  it('a spend to somebody else still names only the caller figures', async () => {
    const { caller } = build({ transferError: refusedForFunds() });
    const cause = await causeOf(caller.transfers.create(spend(THEIRS)));
    expect(spendFiguresOf(cause)).toEqual({ assetId: 'USDT', available: '10', onHold: '5', inEarn: '20' });
  });

  it('an earn read failure gives inEarn null, never zero', async () => {
    const { caller } = build({ transferError: refusedForFunds(), earnFails: true });
    const cause = await causeOf(caller.transfers.create(spend(MINE)));
    expect(spendFiguresOf(cause)).toEqual({ assetId: 'USDT', available: '10', onHold: '5', inEarn: null });
  });

  it('other refusals keep their own code', async () => {
    const { caller } = build({ transferError: new BankError('locked', 'bank.space_locked') });
    await expect(caller.transfers.create(spend(MINE))).rejects.toMatchObject({ cause: { code: 'bank.space_locked' } });
  });
});
