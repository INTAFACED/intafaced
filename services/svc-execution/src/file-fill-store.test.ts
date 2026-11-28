import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootExecution } from './testing/boot.js';
import { ExecutionAlgoStorePathUnsetError } from './file-algo-store.js';
import {
  FileFillAssignStore,
  FileFillConfirmStore,
  FileManualFillStore,
  fillAssignJournalPath,
  fillConfirmJournalPath,
  manualFillJournalPath,
} from './file-fill-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fill-file-'));
  dirs.push(dir);
  return dir;
}

describe('FileFillConfirmStore', () => {
  it('empty journal constructor throws named error', () => {
    expect(() => new FileFillConfirmStore('')).toThrow(ExecutionAlgoStorePathUnsetError);
  });

  it('missing file is empty — restart does not invent a confirmation', () => {
    const path = join(tempDir(), 'fill-confirms.jsonl');
    const store = new FileFillConfirmStore(path);
    expect(store.get('child-1')).toBeNull();
  });

  it('confirm survives reload — second confirm still refuses', () => {
    const path = join(tempDir(), 'fill-confirms.jsonl');
    const store = new FileFillConfirmStore(path);
    const recorded = store.confirm({
      clientOrderId: 'child-1',
      parentClientOrderId: 'parent-1',
      confirmerId: 'op-1',
      confirmedAt: '2026-09-09T00:00:00.000Z',
    });
    expect(recorded?.confirmerId).toBe('op-1');
    expect(store.confirm({ ...recorded!, confirmerId: 'op-2' })).toBeNull();
    const reloaded = new FileFillConfirmStore(path);
    expect(reloaded.get('child-1')).toMatchObject({
      clientOrderId: 'child-1',
      parentClientOrderId: 'parent-1',
      confirmerId: 'op-1',
      confirmedAt: '2026-09-09T00:00:00.000Z',
    });
    expect(reloaded.confirm({ ...recorded!, confirmerId: 'op-2' })).toBeNull();
  });

  it('a thrown confirm append leaves the confirmation out of memory, and a retry writes the line', () => {
    const path = join(tempDir(), 'fill-confirms.jsonl');
    const store = new FileFillConfirmStore(path);
    writeFileSync(path, '');
    chmodSync(path, 0o444);
    const row = {
      clientOrderId: 'child-1',
      parentClientOrderId: 'parent-1',
      confirmerId: 'op-1',
      confirmedAt: '2026-09-09T00:00:00.000Z',
    };

    try {
      expect(() => store.confirm(row)).toThrow(/EACCES/);
    } finally {
      chmodSync(path, 0o644);
    }

    expect(store.get('child-1')).toBeNull();
    expect(new FileFillConfirmStore(path).get('child-1')).toBeNull();

    expect(store.confirm(row)).toMatchObject(row);
    expect(store.get('child-1')).toMatchObject(row);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(row)}\n`);
    expect(new FileFillConfirmStore(path).get('child-1')).toMatchObject(row);

    expect(store.confirm({ ...row, confirmerId: 'op-2' })).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(row)}\n`);
  });
});

describe('FileManualFillStore', () => {
  it('empty journal constructor throws named error', () => {
    expect(() => new FileManualFillStore('')).toThrow(ExecutionAlgoStorePathUnsetError);
  });

  it('record survives reload as ledger strings — does not invent a print', () => {
    const path = join(tempDir(), 'manual-fills.jsonl');
    const store = new FileManualFillStore(path);
    expect(
      store.record({
        clientOrderId: 'child-1',
        parentClientOrderId: 'parent-1',
        filledAmount: '1.5',
        averagePrice: '100.25',
        confirmerId: 'op-1',
        confirmedAt: '2026-09-09T00:00:00.000Z',
      }),
    ).toMatchObject({ filledAmount: '1.5', averagePrice: '100.25' });
    const reloaded = new FileManualFillStore(path);
    expect(reloaded.get('child-1')).toMatchObject({
      clientOrderId: 'child-1',
      filledAmount: '1.5',
      averagePrice: '100.25',
      confirmerId: 'op-1',
    });
    expect(reloaded.record({ ...reloaded.get('child-1')!, confirmerId: 'op-2' })).toBeNull();
  });

  it('a thrown record append leaves the manual fill out of memory, and a retry writes the line', () => {
    const path = join(tempDir(), 'manual-fills.jsonl');
    const store = new FileManualFillStore(path);
    writeFileSync(path, '');
    chmodSync(path, 0o444);
    const row = {
      clientOrderId: 'child-1',
      parentClientOrderId: 'parent-1',
      filledAmount: '1.5',
      averagePrice: '100.25',
      confirmerId: 'op-1',
      confirmedAt: '2026-09-09T00:00:00.000Z',
    };

    try {
      expect(() => store.record(row)).toThrow(/EACCES/);
    } finally {
      chmodSync(path, 0o644);
    }

    expect(store.get('child-1')).toBeNull();
    expect(new FileManualFillStore(path).get('child-1')).toBeNull();

    expect(store.record(row)).toMatchObject(row);
    expect(store.get('child-1')).toMatchObject(row);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(row)}\n`);
    expect(new FileManualFillStore(path).get('child-1')).toMatchObject(row);

    expect(store.record({ ...row, confirmerId: 'op-2' })).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(row)}\n`);
  });
});

describe('FileFillAssignStore', () => {
  it('empty journal constructor throws named error', () => {
    expect(() => new FileFillAssignStore('')).toThrow(ExecutionAlgoStorePathUnsetError);
  });

  it('assign + correct trail survives reload — last row is the correction', () => {
    const path = join(tempDir(), 'fill-assigns.jsonl');
    const store = new FileFillAssignStore(path);
    expect(
      store.assign({
        clientOrderId: 'child-1',
        parentClientOrderId: 'parent-1',
        accountTag: 'acct-a',
        filledAmount: '1',
        averagePrice: '100',
        operatorId: 'op-1',
        recordedAt: '2026-09-09T00:00:00.000Z',
        kind: 'assign',
      }),
    ).toMatchObject({ accountTag: 'acct-a', kind: 'assign' });
    store.correct({
      clientOrderId: 'child-1',
      parentClientOrderId: 'parent-1',
      accountTag: 'acct-b',
      filledAmount: '2',
      averagePrice: '101',
      operatorId: 'op-2',
      recordedAt: '2026-09-09T00:01:00.000Z',
      kind: 'correct',
    });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    const reloaded = new FileFillAssignStore(path);
    expect(reloaded.get('child-1')).toMatchObject({
      accountTag: 'acct-b',
      filledAmount: '2',
      averagePrice: '101',
      kind: 'correct',
    });
    expect(reloaded.trail('child-1')).toHaveLength(2);
    expect(reloaded.trail('child-1')[0]?.kind).toBe('assign');
    expect(reloaded.assign({ ...reloaded.get('child-1')!, kind: 'assign' })).toBeNull();
  });

  it('a thrown assign append leaves the assignment out of memory, and a retry writes the line', () => {
    const path = join(tempDir(), 'fill-assigns.jsonl');
    const store = new FileFillAssignStore(path);
    writeFileSync(path, '');
    chmodSync(path, 0o444);
    const row = {
      clientOrderId: 'child-1',
      parentClientOrderId: 'parent-1',
      accountTag: 'acct-a',
      filledAmount: '1',
      averagePrice: '100',
      operatorId: 'op-1',
      recordedAt: '2026-09-09T00:00:00.000Z',
      kind: 'assign' as const,
    };

    try {
      expect(() => store.assign(row)).toThrow(/EACCES/);
    } finally {
      chmodSync(path, 0o644);
    }

    expect(store.get('child-1')).toBeNull();
    expect(store.trail('child-1')).toEqual([]);
    expect(new FileFillAssignStore(path).get('child-1')).toBeNull();

    expect(store.assign(row)).toMatchObject(row);
    expect(store.get('child-1')).toMatchObject(row);
    expect(store.trail('child-1')).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(row)}\n`);
    expect(new FileFillAssignStore(path).get('child-1')).toMatchObject(row);
    expect(new FileFillAssignStore(path).trail('child-1')).toHaveLength(1);

    expect(store.assign({ ...row, accountTag: 'acct-b' })).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(row)}\n`);
    expect(store.trail('child-1')).toHaveLength(1);
  });
});

describe('fill journal paths', () => {
  it('fill journals sit beside the EMS ack journal', () => {
    expect(fillConfirmJournalPath('/data/execution/ems-journal.jsonl')).toBe('/data/execution/fill-confirms.jsonl');
    expect(manualFillJournalPath('/data/execution/ems-journal.jsonl')).toBe('/data/execution/manual-fills.jsonl');
    expect(fillAssignJournalPath('/data/execution/ems-journal.jsonl')).toBe('/data/execution/fill-assigns.jsonl');
  });

  it('blank EMS path refuses sibling journals', () => {
    expect(() => fillConfirmJournalPath('')).toThrow(ExecutionAlgoStorePathUnsetError);
    expect(() => manualFillJournalPath('')).toThrow(ExecutionAlgoStorePathUnsetError);
    expect(() => fillAssignJournalPath('')).toThrow(ExecutionAlgoStorePathUnsetError);
  });
});

describe('execution boot durable fill stores', () => {
  it('index wires file fill stores and fail-closed path', async () => {
    const booted = await bootExecution();
    try {
      // createExecutionRouter's fillConfirmStore, manualFillStore and fillAssignStore (parameters 20 to 22).
      const confirms = booted.routerArgs[19] as FileFillConfirmStore;
      const manual = booted.routerArgs[20] as FileManualFillStore;
      const assigns = booted.routerArgs[21] as FileFillAssignStore;
      const at = '2026-09-09T00:00:00.000Z';
      expect(confirms.confirm({ clientOrderId: 'c-1', parentClientOrderId: 'p-1', confirmerId: 'op-1', confirmedAt: at })).not.toBeNull();
      expect(
        manual.record({
          clientOrderId: 'c-2',
          parentClientOrderId: 'p-1',
          filledAmount: '1.5',
          averagePrice: '100.25',
          confirmerId: 'op-1',
          confirmedAt: at,
        }),
      ).not.toBeNull();
      expect(
        assigns.assign({
          clientOrderId: 'c-3',
          parentClientOrderId: 'p-1',
          accountTag: 'acct-a',
          filledAmount: '1',
          averagePrice: '100',
          operatorId: 'op-1',
          recordedAt: at,
          kind: 'assign',
        }),
      ).not.toBeNull();
      // What the booted stores wrote is on the journals beside the EMS path: a restart reads it back.
      expect(new FileFillConfirmStore(fillConfirmJournalPath(booted.emsStorePath)).get('c-1')).toMatchObject({ confirmerId: 'op-1' });
      expect(new FileManualFillStore(manualFillJournalPath(booted.emsStorePath)).get('c-2')).toMatchObject({ filledAmount: '1.5' });
      expect(new FileFillAssignStore(fillAssignJournalPath(booted.emsStorePath)).get('c-3')).toMatchObject({ accountTag: 'acct-a' });
    } finally {
      await booted.close();
    }
    // A blank EMS path stops the boot before any store exists.
    const refused = await bootExecution({ EXECUTION_EMS_STORE_PATH: '' }).then(
      () => null,
      (err: unknown) => err,
    );
    const booting = await import('./file-algo-store.js');
    expect(refused).toBeInstanceOf(booting.ExecutionAlgoStorePathUnsetError);
  });
});
