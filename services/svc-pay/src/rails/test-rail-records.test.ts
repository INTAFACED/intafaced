import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { RailRecordError, railRecorder } from './test-rail-records.js';

const fresh = () => path.join(mkdtempSync(path.join(tmpdir(), 'pay-rail-records-')), 'test-rail-records');
const lines = (dir: string) =>
  readFileSync(path.join(dir, 'payout-sim.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const paid = { key: 'cash-out:c1:paid', direction: 'out' as const, assetId: 'USDT', amount: parseAmount('20') };

describe("the payout stand-in's own TEST records", () => {
  it('writes one TEST line per business key in the stack format, in a private folder and file', async () => {
    const dir = fresh();
    const { record } = railRecorder(dir, 'payout-sim');
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
    const { record } = railRecorder(dir, 'payout-sim');
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
    const { record } = railRecorder(dir, 'payout-sim');
    await record(paid);
    appendFileSync(file, '{"label":"TEST","rail":"payout-sim","key":"cash-out:c2:paid","dir');
    await record({ ...paid, key: 'cash-out:c2:paid', amount: parseAmount('3') });
    expect(lines(dir).map((line) => [line.key, line.amount])).toEqual([
      ['cash-out:c1:paid', '20'],
      ['cash-out:c2:paid', '3'],
    ]);
  });

  it('refuses to add to a file holding a line the stack reader would refuse, and never writes one itself', async () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const recorder = railRecorder(dir, 'payout-sim');
    await expect(recorder.record({ ...paid, assetId: 'usdt' })).rejects.toThrow(/is not a TEST rail record/);
    await expect(recorder.record({ ...paid, key: 'k'.repeat(513) })).rejects.toThrow(/is not a TEST rail record/);
    const at = new Date().toISOString();
    for (const bad of [
      { label: 'LIVE', rail: 'payout-sim', key: 'k', direction: 'out', assetId: 'USDT', amount: '1', at },
      { label: 'TEST', rail: 'crypto-native', key: 'k', direction: 'out', assetId: 'USDT', amount: '1', at },
      { label: 'TEST', rail: 'payout-sim', key: 'k', direction: 'out', assetId: 'USDT', amount: '1.0000000000000000001', at },
    ]) {
      writeFileSync(path.join(dir, 'payout-sim.jsonl'), `${JSON.stringify(bad)}\n`);
      await expect(recorder.record({ ...paid, key: 'cash-out:c9:paid' })).rejects.toThrow(RailRecordError);
      await expect(recorder.has('k')).rejects.toThrow(RailRecordError);
    }
  });

  it('a retry whose own line was torn by a crash writes it once, and says it has it', async () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'payout-sim.jsonl'), '{"label":"TEST","rail":"payout-sim","key":"cash-out:c1:paid","direction":"o');
    const recorder = railRecorder(dir, 'payout-sim');
    expect(await recorder.has(paid.key)).toBe(false);
    await recorder.record(paid);
    expect(await recorder.has(paid.key)).toBe(true);
    expect(lines(dir).map((line) => line.key)).toEqual([paid.key]);
  });

  it("waits for another writer's lock, and refuses by name when it is never let go", async () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.lock'), { recursive: true });
    await expect(railRecorder(dir, 'payout-sim', 50).record(paid)).rejects.toThrow(/\.lock is held/);
    setTimeout(() => rmdirSync(path.join(dir, '.lock')), 40);
    await railRecorder(dir, 'payout-sim', 2_000).record(paid);
    expect(lines(dir)).toHaveLength(1);
    expect(() => statSync(path.join(dir, '.lock'))).toThrow();
  });
});
