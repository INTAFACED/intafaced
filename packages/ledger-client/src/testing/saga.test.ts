import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { parseAmount } from '../money.js';
import { userAvailable, userHold } from '../accounts.js';
import { recipes } from '../recipes/index.js';
import { createHttpLedgerClient } from '../http-client.js';
import type { DoorVerify } from './ledger-door.js';
import { describeMoneyDoor, replayMoneyDoor, type MoneyDoorScenario } from './saga.js';

const SECRET = 'saga-test-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const verify: DoorVerify = () => ({ service: 'svc-test', rejected: null });
const newLedger = () => new MemoryLedger();

const client = (fetchImpl: typeof fetch) =>
  createHttpLedgerClient({ baseUrl: 'http://ledger.test', sign: () => ({}), fetch: fetchImpl, retries: 0 });

const setup = async (ledger: MemoryLedger) => {
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'saga-setup-1' }));
};

/** Two posts under business keys: park the funds, then release them back. Safe to run any number of times. */
const parkThenRelease = (key: (step: string) => string): MoneyDoorScenario => ({
  name: 'park then release',
  secret: SECRET,
  verify,
  setup,
  async run(fetchImpl) {
    const ledger = client(fetchImpl);
    const base = { module: 'test', reason: 'test.park' };
    await ledger.post({
      ...base,
      idempotencyKey: key('park'),
      entries: [
        { account: userAvailable(USER, 'USDT'), direction: 'credit', amount: parseAmount('10') },
        { account: userHold(USER, 'USDT', 'saga'), direction: 'debit', amount: parseAmount('10') },
      ],
    });
    await ledger.post({
      ...base,
      idempotencyKey: key('release'),
      entries: [
        { account: userHold(USER, 'USDT', 'saga'), direction: 'credit', amount: parseAmount('10') },
        { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: parseAmount('10') },
      ],
    });
  },
});

describeMoneyDoor(
  parkThenRelease((step) => `saga:test:${step}`),
  newLedger,
);

describe('replayMoneyDoor catches an unsafe door', () => {
  it('names the replays where a random key books the movement twice', async () => {
    let n = 0;
    const failures = await replayMoneyDoor(
      parkThenRelease((step) => `saga:test:${step}:${(n += 1)}-attempt`),
      newLedger,
    );
    expect(failures.map((f) => f.replay)).toEqual(expect.arrayContaining(['duplicate request', 'lost ack on post 1 of 2, then retry']));
  });

  it('refuses a door that posts nothing', async () => {
    const failures = await replayMoneyDoor({ ...parkThenRelease((s) => `saga:test:${s}`), run: async () => undefined }, newLedger);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('nothing to replay');
  });
});
