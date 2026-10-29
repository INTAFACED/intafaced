import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { RailRecordError, railRecorder } from './rail-records.js';

const fresh = () => path.join(mkdtempSync(path.join(tmpdir(), 'bank-rail-records-')), 'test-rail-records');
const lines = (dir: string) =>
  readFileSync(path.join(dir, 'payout-sim.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const paid = { key: 'cash-out:c1:paid', direction: 'out' as const, assetId: 'USDT', amount: parseAmount('20') };

describe("the payout stand-in's own TEST records", () => {
  it('writes one TEST line per business key in the stack format, in a private folder and file', async () => {
    const dir = fresh();
    const record = railRecorder(dir, 'payout-sim');
    await record(paid);
    await record({ ...paid });
    await record({ key: 'cash-out:c1:returned', direction: 'in', assetId: 'USDT', amount: parseAmount('5.5') });
    expect(lines(dir)).toEqual([
      {
        label: 'TEST',
        rail: 'payout-sim',
        key: 'cash-out:c1:paid',
        direction: 'out',
        assetId: 'USDT',
        amount: '20',
        at: expect.any(String),
      },
      {
        label: 'TEST',
        rail: 'payout-sim',
        key: 'cash-out:c1:returned',
        direction: 'in',
        assetId: 'USDT',
        amount: '5.5',
        at: expect.any(String),
      },
    ]);
    expect(Number.isNaN(Date.parse(lines(dir)[0].at))).toBe(false);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'payout-sim.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('refuses the same key with other facts, and a movement of nothing, writing nothing', async () => {
    const dir = fresh();
    const record = railRecorder(dir, 'payout-sim');
    await record(paid);
    await expect(record({ ...paid, amount: parseAmount('21') })).rejects.toThrow(RailRecordError);
    await expect(record({ ...paid, direction: 'in' })).rejects.toThrow(/already recorded as "out USDT 20"/);
    await expect(record({ ...paid, key: 'cash-out:c2:paid', amount: 0n })).rejects.toThrow(RailRecordError);
    expect(lines(dir)).toHaveLength(1);
  });

  it('cuts a line torn by a crash before appending, and reads a key on a complete line only', async () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'payout-sim.jsonl');
    writeFileSync(file, '');
    const record = railRecorder(dir, 'payout-sim');
    await record(paid);
    appendFileSync(file, '{"label":"TEST","rail":"payout-sim","key":"cash-out:c2:paid","dir');
    await record({ ...paid, key: 'cash-out:c2:paid', amount: parseAmount('3') });
    expect(lines(dir).map((line) => [line.key, line.amount])).toEqual([
      ['cash-out:c1:paid', '20'],
      ['cash-out:c2:paid', '3'],
    ]);
  });

  it("waits for another writer's lock, and refuses by name when it is never let go", async () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.lock'), { recursive: true });
    await expect(railRecorder(dir, 'payout-sim', 50)(paid)).rejects.toThrow(/\.lock is held/);
    setTimeout(() => rmdirSync(path.join(dir, '.lock')), 40);
    await railRecorder(dir, 'payout-sim', 2_000)(paid);
    expect(lines(dir)).toHaveLength(1);
    expect(() => statSync(path.join(dir, '.lock'))).toThrow();
  });
});
