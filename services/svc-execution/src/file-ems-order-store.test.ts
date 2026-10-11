import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { EXECUTION_EMS_CLIENT_ORDER_ID_REQUIRED, EmsClientOrderIdRequiredError, FileEmsOrderStore } from './file-ems-order-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ems-file-'));
  dirs.push(dir);
  return join(dir, 'ems-acks.jsonl');
}

function sampleExecution(venueOrderId = 'v-1') {
  return {
    venueId: 'binance-spot',
    venueOrderId,
    filledAmount: parseAmount('1'),
    averagePrice: parseAmount('100'),
    feeAmount: parseAmount('0'),
    feeAsset: 'USDT',
    status: 'filled' as const,
    executedAt: new Date('2026-08-22T00:00:00.000Z'),
  };
}

describe('FileEmsOrderStore', () => {
  it('record + get round-trip on disk', () => {
    const path = tempStorePath();
    const store = new FileEmsOrderStore(path);
    store.record({
      clientOrderId: 'client-1',
      venueId: 'binance-spot',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: sampleExecution(),
      recordedAtMs: 1,
    });
    expect(store.get('client-1')?.venueId).toBe('binance-spot');
    const reloaded = new FileEmsOrderStore(path);
    expect(reloaded.get('client-1')?.symbol).toBe('BTC/USDT');
  });

  it('a blank or whitespace clientOrderId refuses and is not journaled', () => {
    const path = tempStorePath();
    const store = new FileEmsOrderStore(path);
    store.record({
      clientOrderId: 'kept',
      venueId: 'binance-spot',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: sampleExecution('v-kept'),
      recordedAtMs: 1,
    });
    const dropped = {
      clientOrderId: '   ',
      venueId: 'bybit-spot',
      symbol: 'ETH/USDT',
      side: 'sell' as const,
      execution: sampleExecution('v-dropped'),
      reconciliationKey: 'lookup:blank',
      recordedAtMs: 2,
    };

    for (const clientOrderId of ['', '   ', '\n\t ']) {
      try {
        store.record({ ...dropped, clientOrderId });
        throw new Error('expected refuse');
      } catch (err) {
        expect(err).toBeInstanceOf(EmsClientOrderIdRequiredError);
        expect((err as EmsClientOrderIdRequiredError).code).toBe(EXECUTION_EMS_CLIENT_ORDER_ID_REQUIRED);
      }
    }

    expect(store.get('kept')?.execution?.venueOrderId).toBe('v-kept');
    expect(store.get('')).toBeNull();
    expect(store.get('   ')).toBeNull();
    expect(store.getByReconciliationKey('lookup:blank')).toBeNull();
    expect(store.list().map((row) => row.clientOrderId)).toEqual(['kept']);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).clientOrderId).toBe('kept');
    expect(readFileSync(path, 'utf8')).not.toContain('v-dropped');

    const reloaded = new FileEmsOrderStore(path);
    expect(reloaded.get('kept')?.execution?.venueOrderId).toBe('v-kept');
    expect(reloaded.getByReconciliationKey('lookup:blank')).toBeNull();
    expect(reloaded.list().map((row) => row.clientOrderId)).toEqual(['kept']);

    const execution = sampleExecution('v-real');
    store.record({
      clientOrderId: 'client-real',
      venueId: 'binance-spot',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution,
      recordedAtMs: 3,
    });
    expect(store.get('client-real')?.execution?.venueOrderId).toBe('v-real');
    expect(store.get('client-real')?.execution?.filledAmount).toBe(execution.filledAmount);
    expect(store.get('client-real')?.execution?.averagePrice).toBe(execution.averagePrice);
    expect(store.get('client-real')?.execution?.status).toBe('filled');
    const after = new FileEmsOrderStore(path);
    expect(after.get('client-real')?.execution?.venueOrderId).toBe('v-real');
    expect(after.get('client-real')?.execution?.filledAmount).toBe(parseAmount('1'));
    expect(after.get('client-real')?.execution?.averagePrice).toBe(parseAmount('100'));
    expect(
      after
        .list()
        .map((row) => row.clientOrderId)
        .sort(),
    ).toEqual(['client-real', 'kept']);
  });

  it('duplicate clientOrderId overwrites in memory — latest wins on reload', () => {
    const path = tempStorePath();
    const store = new FileEmsOrderStore(path);
    store.record({
      clientOrderId: 'client-dup',
      venueId: 'binance-spot',
      symbol: 'ETH/USDT',
      side: 'sell',
      execution: sampleExecution('v-1'),
      recordedAtMs: 1,
    });
    store.record({
      clientOrderId: 'client-dup',
      venueId: 'bybit-spot',
      symbol: 'ETH/USDT',
      side: 'sell',
      execution: sampleExecution('v-2'),
      recordedAtMs: 2,
    });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    const reloaded = new FileEmsOrderStore(path);
    expect(reloaded.get('client-dup')?.venueId).toBe('bybit-spot');
  });

  it('list filters by venue and symbol', () => {
    const store = new FileEmsOrderStore(tempStorePath());
    store.record({ clientOrderId: 'a', venueId: 'binance-spot', symbol: 'BTC/USDT', side: 'buy', execution: sampleExecution() });
    store.record({ clientOrderId: 'b', venueId: 'bybit-spot', symbol: 'BTC/USDT', side: 'buy', execution: sampleExecution() });
    expect(store.list({ venueId: 'binance-spot' })).toHaveLength(1);
    expect(store.list({ symbol: 'BTC/USDT' })).toHaveLength(2);
  });

  it('persists an outcome-unknown child without inventing an execution and indexes its reconciliation key', () => {
    const path = tempStorePath();
    const store = new FileEmsOrderStore(path);
    store.record({
      clientOrderId: 'parent-1/client/leg-1-0',
      parentClientOrderId: 'parent-1',
      executionGroupId: 'group-1',
      childOrderId: 'group-1/child/leg-1-0',
      legIndex: 1,
      venueId: 'bybit-spot',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: null,
      state: 'SUBMIT_UNKNOWN',
      reconciliationKey: 'lookup:parent-1/client/leg-1-0',
      recordedAtMs: 3,
    });
    const reloaded = new FileEmsOrderStore(path);
    expect(reloaded.get('parent-1/client/leg-1-0')).toMatchObject({ state: 'SUBMIT_UNKNOWN', execution: null });
    expect(reloaded.getByReconciliationKey('lookup:parent-1/client/leg-1-0')?.childOrderId).toBe('group-1/child/leg-1-0');
  });

  it('a thrown journal format leaves the fill unrecorded and still propagates', () => {
    const path = tempStorePath();
    const store = new FileEmsOrderStore(path);
    store.record({
      clientOrderId: 'already',
      venueId: 'binance-spot',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: sampleExecution('v-prior'),
      recordedAtMs: 1,
    });
    const fill = {
      clientOrderId: 'fill-child',
      parentClientOrderId: 'parent-1',
      executionGroupId: 'group-1',
      childOrderId: 'group-1/child/fill',
      legIndex: 0,
      venueId: 'binance-spot',
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      execution: {
        ...sampleExecution('v-fill'),
        filledAmount: 1 as unknown as ReturnType<typeof parseAmount>,
      },
      reconciliationKey: 'lookup:fill-child',
      recordedAtMs: 2,
    };

    expect(() => store.record(fill)).toThrow(TypeError);
    expect(store.get('fill-child')).toBeNull();
    expect(store.getByReconciliationKey('lookup:fill-child')).toBeNull();
    expect(store.list().map((row) => row.clientOrderId)).toEqual(['already']);
    expect(store.list({ reconciliationKey: 'lookup:fill-child' })).toEqual([]);

    const reloaded = new FileEmsOrderStore(path);
    expect(reloaded.get('fill-child')).toBeNull();
    expect(reloaded.getByReconciliationKey('lookup:fill-child')).toBeNull();

    store.record({ ...fill, execution: sampleExecution('v-fill') });
    expect(store.get('fill-child')?.execution?.venueOrderId).toBe('v-fill');
    expect(store.get('fill-child')?.execution?.status).toBe('filled');
    expect(store.getByReconciliationKey('lookup:fill-child')?.childOrderId).toBe('group-1/child/fill');
    expect(store.list({ reconciliationKey: 'lookup:fill-child' })).toHaveLength(1);
    const afterRetry = new FileEmsOrderStore(path);
    expect(afterRetry.get('fill-child')?.execution?.venueOrderId).toBe('v-fill');
    expect(afterRetry.getByReconciliationKey('lookup:fill-child')?.childOrderId).toBe('group-1/child/fill');
    expect(afterRetry.list({ reconciliationKey: 'lookup:fill-child' })).toHaveLength(1);
  });

  it('a failed journal append leaves the outcome-unknown child unrecorded and still propagates', () => {
    const path = tempStorePath();
    const store = new FileEmsOrderStore(path);
    store.record({
      clientOrderId: 'already',
      venueId: 'binance-spot',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: sampleExecution('v-prior'),
      recordedAtMs: 1,
    });
    const child = {
      clientOrderId: 'parent-1/client/leg-1-0',
      parentClientOrderId: 'parent-1',
      executionGroupId: 'group-1',
      childOrderId: 'group-1/child/leg-1-0',
      legIndex: 1,
      venueId: 'bybit-spot',
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      execution: null,
      state: 'OUTCOME_UNKNOWN' as const,
      reconciliationKey: 'lookup:parent-1/client/leg-1-0',
      recordedAtMs: 3,
    };

    chmodSync(path, 0o444);
    try {
      expect(() => store.record(child)).toThrow();
    } finally {
      chmodSync(path, 0o644);
    }

    expect(store.get(child.clientOrderId)).toBeNull();
    expect(store.getByReconciliationKey(child.reconciliationKey)).toBeNull();
    expect(store.list().map((row) => row.clientOrderId)).toEqual(['already']);
    expect(store.list({ reconciliationKey: child.reconciliationKey })).toEqual([]);

    const reloaded = new FileEmsOrderStore(path);
    expect(reloaded.get(child.clientOrderId)).toBeNull();
    expect(reloaded.getByReconciliationKey(child.reconciliationKey)).toBeNull();
    expect(reloaded.list().map((row) => row.clientOrderId)).toEqual(['already']);

    store.record(child);
    expect(store.get(child.clientOrderId)?.state).toBe('OUTCOME_UNKNOWN');
    expect(store.get(child.clientOrderId)?.execution).toBeNull();
    expect(store.getByReconciliationKey(child.reconciliationKey)?.childOrderId).toBe('group-1/child/leg-1-0');
    expect(store.list({ state: 'OUTCOME_UNKNOWN' }).map((row) => row.clientOrderId)).toEqual([child.clientOrderId]);
    const afterRetry = new FileEmsOrderStore(path);
    expect(afterRetry.get(child.clientOrderId)?.state).toBe('OUTCOME_UNKNOWN');
    expect(afterRetry.get(child.clientOrderId)?.execution).toBeNull();
    expect(afterRetry.getByReconciliationKey(child.reconciliationKey)?.childOrderId).toBe('group-1/child/leg-1-0');
    expect(afterRetry.list({ reconciliationKey: child.reconciliationKey })).toHaveLength(1);
  });
});
