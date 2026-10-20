/**
 * SAGATEST for svc-pay's user withdrawal: `withdraw` claims the row, posts `withdrawHold`, asks the rail, then posts
 * `withdrawSettle` (or `withdrawReverse` when the rail refuses). `describeMoneyDoor` replays it as a duplicate request,
 * a lost acknowledgement on each post, and a crash after each post, and requires the book of one clean run every time.
 * The same `clientRef` is the business key on every call. Postgres survives a crash, as it would for real.
 */
import { afterAll, beforeAll, vi } from 'vitest';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createLedgerClient } from './ledger-client.js';
import { PayError } from './payment-service.js';
import { railFailure } from './rails/rail-adapter.js';
import { UserMoneyService } from './user-money-service.js';
import { overHarness, pinPayIds, resetPay, SAGA_SECRET, sagaPayDatabase, sagaRails } from './saga-fixture-test.js';

// Each replay boots a database and runs the door several times; the 5s default is too tight on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000 });

const USER = '11111111-1111-4111-8111-111111111111';
const CLIENT_REF = 'saga-withdraw-1';
const DESTINATION = { kind: 'bank', ref: 'DE89370400440532013000' };

const pg = sagaPayDatabase();
beforeAll(() => pg.open(), 120_000);
afterAll(() => pg.close(), 30_000);

let rails = sagaRails();

const serviceOver = (ledger: ConstructorParameters<typeof UserMoneyService>[1]) =>
  new UserMoneyService(pg.database().sql, ledger, rails.registry, { operatorCreditRails: ['card-sandbox'] });

function withdrawScenario(name: string, refused: boolean): MoneyDoorScenario {
  return {
    name,
    secret: SAGA_SECRET,
    verify: verifyServiceHeaders,
    async setup(ledger) {
      await resetPay(pg.database());
      await pinPayIds(pg.database());
      rails = sagaRails();
      if (refused) {
        rails.card.payout = async (s) =>
          railFailure({
            railRef: '',
            amount: s.amount,
            assetId: s.assetId,
            failureCode: 'rail.refused',
            failureReason: 'REFUSED BY THE TEST RAIL',
          });
      }
      await ledger.post(
        recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'saga-withdraw-fund' }),
      );
    },
    run: (fetchImpl) =>
      overHarness(fetchImpl, async () => {
        const money = serviceOver(createLedgerClient('http://ledger.test', SAGA_SECRET));
        // A refused attempt is finished (`failed`, one reverse booked). Asking again with the same ref opens the NEXT
        // attempt on purpose, so only an unfinished withdrawal is resumed, the way a retry after a lost reply would.
        if (refused) {
          const [row] = await pg.database().sql`SELECT status FROM pay.withdrawals WHERE user_id = ${USER} AND client_ref = ${CLIENT_REF}`;
          if (row?.status === 'failed') return undefined;
        }
        try {
          return await money.withdraw({
            userId: USER,
            assetId: 'USDT',
            amount: amt('40'),
            rail: 'card-sandbox',
            destination: DESTINATION,
            clientRef: CLIENT_REF,
          });
        } catch (error) {
          if (refused && error instanceof PayError && error.code === 'pay.rail_failed') return undefined;
          throw error;
        }
      }),
    async invariant(ledger) {
      const held = (await ledger.balances('user', USER)).filter((b) => b.account.kind === 'hold').reduce((acc, b) => acc + b.amount, 0n);
      if (held !== 0n) throw new Error(`a withdrawal hold of ${formatAmount(held)} is stranded`);
      const rows = await pg.database().sql`SELECT status FROM pay.withdrawals WHERE user_id = ${USER} AND client_ref = ${CLIENT_REF}`;
      const want = refused ? 'failed' : 'sent';
      if (rows.length !== 1 || rows[0]!.status !== want) throw new Error(`withdrawal rows ${JSON.stringify(rows)}, wanted one ${want}`);
    },
  };
}

describeMoneyDoor(withdrawScenario('svc-pay user withdrawal (hold, rail, settle)', false), () => new MemoryLedger());
describeMoneyDoor(withdrawScenario('svc-pay user withdrawal refused by the rail (hold, reverse)', true), () => new MemoryLedger());
