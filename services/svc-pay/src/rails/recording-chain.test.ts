import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { MemoryChain, UnconfiguredChain } from './chain-port.js';
import { CryptoNativeAdapter, RailOutcomeUnknownError } from './crypto-native.js';
import { PAY_TEST_RAIL_RECORDS_DIR_ENV, RecordingChain, TestRailRecordsRefusedError, recordingChainFor } from './recording-chain.js';

const SECRET = 'recording-chain-test-secret-long-enough';
const fresh = () => path.join(mkdtempSync(path.join(tmpdir(), 'pay-rail-records-')), 'test-rail-records');
const lines = (dir: string) =>
  readFileSync(path.join(dir, 'crypto-native.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>);
const dev = (dir: string) => ({ APP_ENV: 'dev', [PAY_TEST_RAIL_RECORDS_DIR_ENV]: dir });
const settlement = { settlementId: 'w-1', merchantId: 'm', amount: parseAmount('12.5'), assetId: 'USDT', window: 'TEST' };

describe("the TEST chain's own records of what it sent (crypto-native)", () => {
  it('unset or blank, the chain is the chain as it is', () => {
    const chain = new MemoryChain();
    expect(recordingChainFor(chain, { APP_ENV: 'dev' })).toBe(chain);
    expect(recordingChainFor(chain, { APP_ENV: 'prod', [PAY_TEST_RAIL_RECORDS_DIR_ENV]: '  ' })).toBe(chain);
  });

  it('refuses to start outside an explicit dev or test process, under NODE_ENV=production, at a relative path or over a chain that is not the sandbox', () => {
    const dir = fresh();
    for (const [chain, env] of [
      [new MemoryChain(), { [PAY_TEST_RAIL_RECORDS_DIR_ENV]: dir }],
      [new MemoryChain(), { APP_ENV: 'staging', [PAY_TEST_RAIL_RECORDS_DIR_ENV]: dir }],
      [new MemoryChain(), { APP_ENV: 'test', NODE_ENV: 'production', [PAY_TEST_RAIL_RECORDS_DIR_ENV]: dir }],
      [new MemoryChain(), { APP_ENV: 'dev', [PAY_TEST_RAIL_RECORDS_DIR_ENV]: 'test-rail-records' }],
      [new UnconfiguredChain(), dev(dir)],
    ] as const) {
      expect(() => recordingChainFor(chain, env)).toThrow(TestRailRecordsRefusedError);
    }
    expect(recordingChainFor(new MemoryChain(), dev(dir))).toBeInstanceOf(RecordingChain);
  });

  it('a payout the chain sent is one out record under its business key, however often it is retried or looked up', async () => {
    const dir = fresh();
    const chain = recordingChainFor(new MemoryChain(), dev(dir));
    const rail = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
    const first = await rail.payout({ ...settlement, destination: { kind: 'crypto', ref: '0xabc' } });
    expect(first.ok).toBe(true);
    await rail.payout({ ...settlement, destination: { kind: 'crypto', ref: '0xabc' } });
    expect(await rail.queryPayout('pay.payout:w-1')).toMatchObject({ status: 'sent' });
    expect(lines(dir).map(({ label, rail: id, key, direction, assetId, amount }) => [label, id, key, direction, assetId, amount])).toEqual([
      ['TEST', 'crypto-native', 'send:pay.payout:w-1', 'out', 'USDT', '12.5'],
    ]);
  });

  it('a record that cannot be written after the chain sent is an unknown outcome, and the lookup that follows writes it', async () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.lock'), { recursive: true });
    const memory = new MemoryChain();
    const { railRecorder } = await import('./test-rail-records.js');
    const chain = new RecordingChain(memory, railRecorder(dir, 'crypto-native', 50));
    const rail = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
    await expect(rail.payout({ ...settlement, destination: { kind: 'crypto', ref: '0xabc' } })).rejects.toThrow(RailOutcomeUnknownError);
    expect(await memory.lookupSend('pay.payout:w-1')).toMatchObject({ state: 'sent' });
    const { rmdirSync } = await import('node:fs');
    rmdirSync(path.join(dir, '.lock'));
    expect(await rail.queryPayout('pay.payout:w-1')).toMatchObject({ status: 'sent' });
    expect(lines(dir).map((line) => line.key)).toEqual(['send:pay.payout:w-1']);
  });

  it('a send the rail already recorded with other facts refuses rather than contradicting itself', async () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const memory = new MemoryChain();
    // The chain sent 12.5 under this key, but the rail's record says 9.
    await memory.send({ idempotencyKey: 'pay.payout:w-1', to: '0xabc', assetId: 'USDT', amount: parseAmount('12.5') });
    const earlier = { label: 'TEST', rail: 'crypto-native', key: 'send:pay.payout:w-1', direction: 'out', assetId: 'USDT', amount: '9' };
    writeFileSync(path.join(dir, 'crypto-native.jsonl'), `${JSON.stringify({ ...earlier, at: new Date().toISOString() })}\n`);
    const rail = new CryptoNativeAdapter({
      chain: recordingChainFor(memory, dev(dir)),
      secret: SECRET,
      minConfirmations: 6,
      toleranceSeconds: 300,
    });
    await expect(rail.payout({ ...settlement, destination: { kind: 'crypto', ref: '0xabc' } })).rejects.toThrow(RailOutcomeUnknownError);
    expect(lines(dir).map((line) => line.amount)).toEqual(['9']);
  });

  it('after a restart forgets the chain, a recorded payout is never reported not sent and never sent again', async () => {
    const dir = fresh();
    const before = new CryptoNativeAdapter({
      chain: recordingChainFor(new MemoryChain(), dev(dir)),
      secret: SECRET,
      minConfirmations: 6,
      toleranceSeconds: 300,
    });
    expect((await before.payout({ ...settlement, destination: { kind: 'crypto', ref: '0xabc' } })).ok).toBe(true);
    const memory = new MemoryChain();
    const after = new CryptoNativeAdapter({
      chain: recordingChainFor(memory, dev(dir)),
      secret: SECRET,
      minConfirmations: 6,
      toleranceSeconds: 300,
    });
    expect(await after.queryPayout('pay.payout:w-1')).toEqual({ status: 'unknown' });
    await expect(after.payout({ ...settlement, destination: { kind: 'crypto', ref: '0xabc' } })).rejects.toThrow(RailOutcomeUnknownError);
    expect(await memory.lookupSend('pay.payout:w-1')).toEqual({ state: 'not_sent' });
    expect(lines(dir).map((line) => line.key)).toEqual(['send:pay.payout:w-1']);
  });

  it('a refund send is recorded once under its own key, and after a restart it is not sent again', async () => {
    const dir = fresh();
    const request = { idempotencyKey: 'pay.refund:p-1:r-1', to: '0xpayer', assetId: 'USDT', amount: parseAmount('3') };
    const first = recordingChainFor(new MemoryChain(), dev(dir));
    await first.send(request);
    await first.send(request);
    const memory = new MemoryChain();
    await expect(recordingChainFor(memory, dev(dir)).send(request)).rejects.toThrow(/not sent again/);
    expect(await memory.lookupSend(request.idempotencyKey)).toEqual({ state: 'not_sent' });
    expect(lines(dir).map(({ key, direction, amount }) => [key, direction, amount])).toEqual([['send:pay.refund:p-1:r-1', 'out', '3']]);
  });
});
