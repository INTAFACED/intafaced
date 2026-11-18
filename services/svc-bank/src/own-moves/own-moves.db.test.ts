/**
 * Moves from a person's own spending money to their trading account (J-derivatives-25 #2 #3, BK-ownmove-01), on the
 * TEST partner bank: the partner moves the amount out of the main balance and sends it to the person's own wallet, each
 * once under the move's key, after a fresh second factor; the wallet's own deposit to the venue is recorded once. The
 * ledger posts nothing. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { testPartner as testPartnerBank } from '../partner/test-partner.js';
import { payinSim } from '../ramps/payin-sim.js';
import { memorySanctions } from '../ramps/sanctions-list.js';
import { createBankRouter } from '../router.js';
import type { StepUpGate, StepUpRequest } from '../step-up/step-up-gate.js';
import { ownMoveKey, ownMoveMessage, partnerChainOutAccount } from './own-move-service.js';

const SECRET = 'bank-own-moves-edge-secret-long-enough';
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
// Well-known public development keys (the first two accounts of common local EVM chains). They hold nothing; TEST only.
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const STRANGER_KEY = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

/** What a wallet's `personal_sign` returns: the EIP-191 digest signed, as `r || s || v` with v 27/28. */
function personalSign(message: string, keyHex: string): string {
  const encoder = new TextEncoder();
  const body = encoder.encode(message);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  const recovered = secp256k1.sign(keccak_256(joined), Buffer.from(keyHex, 'hex'), { prehash: false, format: 'recovered' });
  const out = new Uint8Array(65);
  out.set(recovered.subarray(1), 0);
  out[64] = recovered[0]! + 27;
  return `0x${Buffer.from(out).toString('hex')}`;
}

describe('own moves: spending to trading (J-derivatives-25 #2 #3)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.own_moves`;
    ledger = new MemoryLedger();
  });

  /** The TEST partner holding ADA's money, and a partner send to a wallet that counts every send per key. */
  function wired(options: { deliver?: 'ok' | 'fails-once' | 'none'; sanctions?: ReturnType<typeof memorySanctions> } = {}) {
    const tp = testPartnerBank();
    tp.set(ADA, { custody: 'off' });
    tp.set(BOB, { custody: 'off' });
    tp.fund(ADA, { fundId: 'fund-ada-1000', assetId: 'USDC', amount: parseAmount('1000') });
    const sends: { key: string | undefined; to: string; amount: string }[] = [];
    let failNext = options.deliver === 'fails-once';
    const partner = payinSim(
      { label: 'TEST pay-in partner', methods: ['pay_by_bank'] } as never,
      new URL('http://127.0.0.1:9/test/payin-sim/pay/'),
      new URL('http://127.0.0.1:9/bank/ramps/new'),
      options.deliver === 'none'
        ? undefined
        : async (input) => {
            if (failNext) {
              failNext = false;
              throw new Error('the TEST partner did not deliver: 502 payin.send_failed');
            }
            const prior = sends.find((s) => s.key !== undefined && s.key === input.key);
            if (prior) return TX(sends.indexOf(prior) + 1);
            sends.push({ key: input.key, to: input.to, amount: input.amount });
            return TX(sends.length);
          },
    );
    const sanctions = options.sanctions ?? memorySanctions([{ network: '*', address: '0x00000000000000000000000000000000005a1c7d' }]);
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { sanctions },
      onrampPartner: partner,
      testPartner: tp,
      postingFreeze: { postingEnabled: async () => true, read: async () => ({ postingEnabled: true, cause: null }) },
    });
    const main = { userId: ADA, assetId: 'USDC', spaceId: null };
    const balance = async () => (await tp.bank.balance(main)).amount;
    return { tp, bank, sends, balance, partner };
  }

  function ask(amount: string, moveId = randomUUID(), key = KEY) {
    const message = ownMoveMessage({ moveId, wallet: WALLET, assetId: 'USDC', amount });
    return { moveId, assetId: 'USDC', amount, wallet: WALLET, walletSignature: personalSign(message, key) };
  }

  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BankError);
    return err as BankError;
  };

  it('sends the amount from the main balance to the wallet once, and the ledger posts nothing', async () => {
    const { bank, sends, balance, tp } = wired();
    const move = await bank.ownMoves.toWallet(ADA, ask('600'));
    expect(move).toMatchObject({
      status: 'sent',
      amount: parseAmount('600'),
      wallet: WALLET,
      partner: 'TEST partner bank',
      deliveryTx: TX(1),
    });
    expect(move.partnerRef).toEqual(expect.any(String));
    expect(sends).toEqual([{ key: ownMoveKey(move.id), to: WALLET, amount: '600' }]);
    // Invariant: the main balance lost exactly the amount, the partner's own chain-out account holds it, nothing posted.
    expect(await balance()).toBe(parseAmount('400'));
    expect((await tp.bank.balance(partnerChainOutAccount('USDC'))).amount).toBe(parseAmount('600'));
    expect(ledger.journal()).toHaveLength(0);
  });

  it('asked again with the same id sends nothing more and answers the first move', async () => {
    const { bank, sends, balance } = wired();
    const input = ask('600');
    const first = await bank.ownMoves.toWallet(ADA, input);
    const [again, third] = await Promise.all([bank.ownMoves.toWallet(ADA, input), bank.ownMoves.toWallet(ADA, input)]);
    expect(again).toEqual(first);
    expect(third).toEqual(first);
    expect(sends).toHaveLength(1);
    expect(await balance()).toBe(parseAmount('400'));
  });

  it('above what the partner reports free, refuses naming its figure: nothing kept, nothing moved, nothing sent', async () => {
    const { bank, sends, balance } = wired();
    const err = await refusal(bank.ownMoves.toWallet(ADA, ask('1000.01')));
    expect(err.code).toBe('bank.own_move_above_free');
    expect(err.message).toBe('TEST partner bank reports 1000 USDC free in your account, so 1000.01 USDC cannot move. Nothing was sent.');
    expect(sends).toHaveLength(0);
    expect(await balance()).toBe(parseAmount('1000'));
    expect(await sql`SELECT 1 FROM bank.own_moves`).toHaveLength(0);
  });

  it('a wallet that did not sign this move, or signed another amount, is refused before anything is kept', async () => {
    const { bank, sends, balance } = wired();
    const stranger = ask('600', randomUUID(), STRANGER_KEY);
    expect((await refusal(bank.ownMoves.toWallet(ADA, stranger))).code).toBe('bank.wallet_delivery_unproven');
    const signedFor100 = ask('100');
    expect((await refusal(bank.ownMoves.toWallet(ADA, { ...signedFor100, amount: '600' }))).code).toBe('bank.wallet_delivery_unproven');
    expect(sends).toHaveLength(0);
    expect(await balance()).toBe(parseAmount('1000'));
    expect(await sql`SELECT 1 FROM bank.own_moves`).toHaveLength(0);
  });

  it('a listed wallet is refused with the list’s code and nothing moves', async () => {
    const listed = wired({ sanctions: memorySanctions([{ network: '*', address: WALLET }]) });
    const err = await refusal(listed.bank.ownMoves.toWallet(ADA, ask('10')));
    expect(err.code).toMatch(/^bank\.(sanction|destination)/);
    expect(listed.sends).toHaveLength(0);
    expect(await listed.balance()).toBe(parseAmount('1000'));
  });

  it('the same id with other terms is a conflict, and another person cannot reuse it', async () => {
    const { bank, sends } = wired();
    const input = ask('600');
    await bank.ownMoves.toWallet(ADA, input);
    const other = { ...ask('500', input.moveId) };
    expect((await refusal(bank.ownMoves.toWallet(ADA, other))).code).toBe('bank.own_move_conflict');
    expect((await refusal(bank.ownMoves.toWallet(BOB, input))).code).toBe('bank.own_move_conflict');
    expect(sends).toHaveLength(1);
  });

  it('a send cut off after the partner moved is finished by asking again: moved once, sent once', async () => {
    const { bank, sends, balance } = wired({ deliver: 'fails-once' });
    const input = ask('600');
    await expect(bank.ownMoves.toWallet(ADA, input)).rejects.toThrow(/did not deliver/);
    // The partner moved it out of the main balance under the key; the row still reads opening, with nothing sent.
    expect(await balance()).toBe(parseAmount('400'));
    expect(await bank.ownMoves.get(ADA, input.moveId)).toMatchObject({ status: 'opening', deliveryTx: null });
    const done = await bank.ownMoves.toWallet(ADA, input);
    expect(done).toMatchObject({ status: 'sent', deliveryTx: TX(1) });
    expect(sends).toHaveLength(1);
    expect(await balance()).toBe(parseAmount('400'));
  });

  it('a move kept before a crash, the partner never asked, is sent once when asked again', async () => {
    const { bank, sends, balance } = wired();
    const input = ask('250');
    await sql`
      INSERT INTO bank.own_moves (id, user_id, direction, asset_id, amount, wallet, status)
      VALUES (${input.moveId}, ${ADA}, 'in', 'USDC', '250', ${WALLET}, 'opening')
    `;
    expect(await bank.ownMoves.toWallet(ADA, input)).toMatchObject({ status: 'sent' });
    expect(sends).toHaveLength(1);
    expect(await balance()).toBe(parseAmount('750'));
  });

  it('with no partner send to a wallet, refuses by name and keeps nothing', async () => {
    const { bank, balance } = wired({ deliver: 'none' });
    expect((await refusal(bank.ownMoves.toWallet(ADA, ask('10')))).code).toBe('bank.own_move_rail_unset');
    expect(await balance()).toBe(parseAmount('1000'));
    expect(await sql`SELECT 1 FROM bank.own_moves`).toHaveLength(0);
  });

  it('records the wallet’s own deposit once; the same again is the same, another is a conflict', async () => {
    const { bank } = wired();
    const move = await bank.ownMoves.toWallet(ADA, ask('600'));
    const deposit = TX(0xd1);
    const first = await bank.ownMoves.recordDeposit(ADA, { moveId: move.id, depositTx: deposit });
    expect(first).toMatchObject({ depositTx: deposit });
    expect(first.depositAt).toBeInstanceOf(Date);
    expect(await bank.ownMoves.recordDeposit(ADA, { moveId: move.id, depositTx: deposit })).toEqual(first);
    expect((await refusal(bank.ownMoves.recordDeposit(ADA, { moveId: move.id, depositTx: TX(0xd2) }))).code).toBe('bank.own_move_conflict');
    expect((await refusal(bank.ownMoves.recordDeposit(BOB, { moveId: move.id, depositTx: deposit }))).code).toBe('bank.own_move_not_found');
    expect(ledger.journal()).toHaveLength(0);
  });

  describe('the door', () => {
    const SID = randomUUID();
    function caller(userId: string, gate: StepUpGate) {
      const { bank, sends, balance } = wired();
      const raw = encodePrincipal({
        sub: userId,
        userId,
        sid: SID,
        scopes: ['bank:read', 'bank:write'],
        tier: 'full',
        mfa: true,
        expiresAt: new Date(Date.now() + 60_000),
      } as Principal);
      const call = createBankRouter(bank, { ownMoveStepUp: gate }).createCaller(
        edgeContext({
          headers: {
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
            'x-intafaced-region': 'DE',
          },
          id: `req-${randomUUID()}`,
        }),
      );
      return { call, sends, balance };
    }

    it('always asks a fresh second factor bound to the move, and without one nothing is sent', async () => {
      const asked: StepUpRequest[] = [];
      const refusing: StepUpGate = {
        mode: 'required',
        async require(req) {
          asked.push(req);
          throw new BankError('This needs a fresh confirmation.', 'bank.step_up_required');
        },
      };
      const { call, sends, balance } = caller(ADA, refusing);
      const input = ask('600');
      await expect(call.ownMoves.toWallet(input)).rejects.toThrow(/fresh confirmation/);
      expect(asked).toEqual([
        {
          userId: ADA,
          sessionId: SID,
          actionType: 'bank.step_up.ownMoves.toWallet',
          fields: { actor: ADA, moveId: input.moveId, assetId: 'USDC', amount: '600', wallet: WALLET },
          operationKey: input.moveId,
          approvalId: undefined,
          replay: true,
        },
      ]);
      expect(sends).toHaveLength(0);
      expect(await balance()).toBe(parseAmount('1000'));
    });

    it('with the approval, sends once and answers the move', async () => {
      const passing: StepUpGate = { mode: 'required', require: async () => undefined };
      const { call, sends } = caller(ADA, passing);
      const move = await call.ownMoves.toWallet({ ...ask('600'), stepUpApprovalId: 'approval-1' });
      expect(move).toMatchObject({ status: 'sent', amount: '600', partnerFee: '0', partner: 'TEST partner bank' });
      expect(sends).toHaveLength(1);
      expect(await call.ownMoves.list({ limit: 10 })).toEqual([move]);
    });
  });
});
