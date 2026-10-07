import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXECUTION_ALGO_STORE_PATH_UNSET,
  ExecutionAlgoStorePathUnsetError,
  FileAlgoPauseStore,
  FileApprovedAlgoParentStore,
  algoParentJournalPath,
  algoPauseJournalPath,
  requireExecutionEmsStorePath,
} from './file-algo-store.js';
import { startApprovedAlgoParent, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';

const dirs: string[] = [];
const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = () => readFileSync(join(here, 'index.ts'), 'utf8');

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'algo-file-'));
  dirs.push(dir);
  return dir;
}

function retained(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function approved(id = 'parent-1'): ApprovedAlgoParent {
  return {
    parentClientOrderId: id,
    kind: 'twap',
    status: 'approved',
    schedule: retained(),
    startedAt: null,
  };
}

describe('requireExecutionEmsStorePath', () => {
  it('blank path throws named execution.algo_store_path_unset', () => {
    expect(() => requireExecutionEmsStorePath('')).toThrow(ExecutionAlgoStorePathUnsetError);
    expect(() => requireExecutionEmsStorePath('   ')).toThrow(ExecutionAlgoStorePathUnsetError);
    try {
      requireExecutionEmsStorePath('');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionAlgoStorePathUnsetError);
      expect((err as ExecutionAlgoStorePathUnsetError).code).toBe(EXECUTION_ALGO_STORE_PATH_UNSET);
    }
  });

  it('trims a set path', () => {
    expect(requireExecutionEmsStorePath(' /data/execution/ems-journal.jsonl ')).toBe('/data/execution/ems-journal.jsonl');
  });
});

describe('FileApprovedAlgoParentStore', () => {
  it('empty journal constructor throws named error', () => {
    expect(() => new FileApprovedAlgoParentStore('')).toThrow(ExecutionAlgoStorePathUnsetError);
  });

  it('missing file is empty — restart does not invent a live parent', () => {
    const path = join(tempDir(), 'algo-parents.jsonl');
    const store = new FileApprovedAlgoParentStore(path);
    expect(store.get('parent-1')).toBeNull();
    expect(store.list()).toEqual([]);
    const started = startApprovedAlgoParent({
      parentClientOrderId: 'parent-1',
      operatorId: 'op-1',
      parentStore: store,
      jobs: { enabled: true },
    });
    expect(started).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('approve + start survives reload as running', () => {
    const path = join(tempDir(), 'algo-parents.jsonl');
    const store = new FileApprovedAlgoParentStore(path);
    store.approve(approved());
    const started = store.start('parent-1', '2026-09-09T00:00:00.000Z', 'op-1');
    expect(started?.status).toBe('running');
    const reloaded = new FileApprovedAlgoParentStore(path);
    expect(reloaded.get('parent-1')).toMatchObject({
      parentClientOrderId: 'parent-1',
      status: 'running',
      startedAt: '2026-09-09T00:00:00.000Z',
      executionOwner: 'op-1',
    });
  });

  it('stopped parent reloads stopped — does not invent live', () => {
    const path = join(tempDir(), 'algo-parents.jsonl');
    const store = new FileApprovedAlgoParentStore(path);
    store.approve(approved());
    store.start('parent-1', '2026-09-09T00:00:00.000Z', 'op-1');
    expect(store.stop('parent-1')?.status).toBe('stopped');
    const reloaded = new FileApprovedAlgoParentStore(path);
    expect(reloaded.get('parent-1')?.status).toBe('stopped');
    const again = startApprovedAlgoParent({
      parentClientOrderId: 'parent-1',
      operatorId: 'op-1',
      parentStore: reloaded,
      jobs: { enabled: true },
    });
    expect(again).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('latest snapshot wins on reload', () => {
    const path = join(tempDir(), 'algo-parents.jsonl');
    const store = new FileApprovedAlgoParentStore(path);
    store.approve(approved());
    store.start('parent-1', '2026-09-09T00:00:00.000Z', 'op-1');
    store.stop('parent-1');
    expect(readFileSync(path, 'utf8').trim().split('\n').length).toBeGreaterThan(1);
    const reloaded = new FileApprovedAlgoParentStore(path);
    expect(reloaded.get('parent-1')?.status).toBe('stopped');
  });

  it('rolls memory back when the journal append throws on stop or kill', () => {
    const stopPath = join(tempDir(), 'algo-parents.jsonl');
    const stopStore = new FileApprovedAlgoParentStore(stopPath);
    stopStore.approve(approved());
    stopStore.start('parent-1', '2026-09-09T00:00:00.000Z', 'op-1');
    const running = stopStore.get('parent-1');
    expect(running?.status).toBe('running');

    chmodSync(stopPath, 0o444);
    try {
      expect(() => stopStore.stop('parent-1')).toThrow();
      expect(stopStore.get('parent-1')).toEqual(running);
      expect(stopStore.list()).toEqual([running]);
    } finally {
      chmodSync(stopPath, 0o644);
    }

    expect(stopStore.stop('parent-1')?.status).toBe('stopped');
    expect(stopStore.get('parent-1')?.status).toBe('stopped');
    expect(stopStore.list()).toEqual([expect.objectContaining({ parentClientOrderId: 'parent-1', status: 'stopped' })]);

    const killPath = join(tempDir(), 'algo-parents.jsonl');
    const killStore = new FileApprovedAlgoParentStore(killPath);
    killStore.approve(approved());
    killStore.start('parent-1', '2026-09-09T00:00:00.000Z', 'op-1');
    const live = killStore.get('parent-1');
    expect(live?.status).toBe('running');

    chmodSync(killPath, 0o444);
    try {
      expect(() => killStore.kill('parent-1')).toThrow();
      expect(killStore.get('parent-1')).toEqual(live);
      expect(killStore.list()).toEqual([live]);
    } finally {
      chmodSync(killPath, 0o644);
    }

    expect(killStore.kill('parent-1')?.status).toBe('stopped');
    expect(killStore.get('parent-1')?.status).toBe('stopped');
    expect(killStore.list()).toEqual([expect.objectContaining({ parentClientOrderId: 'parent-1', status: 'stopped' })]);
  });
});

describe('FileAlgoPauseStore', () => {
  it('empty journal constructor throws named error', () => {
    expect(() => new FileAlgoPauseStore('')).toThrow(ExecutionAlgoStorePathUnsetError);
  });

  it('pause survives reload — restart does not lose a pause', () => {
    const path = join(tempDir(), 'algo-pauses.jsonl');
    const store = new FileAlgoPauseStore(path);
    expect(store.pause({ kind: 'parent', id: 'parent-1' })).toBe(true);
    expect(store.isPaused({ parentClientOrderId: 'parent-1' })).toBe(true);
    const reloaded = new FileAlgoPauseStore(path);
    expect(reloaded.isPaused({ parentClientOrderId: 'parent-1' })).toBe(true);
    expect(reloaded.pause({ kind: 'parent', id: 'parent-1' })).toBe(false);
  });

  it('resume survives reload', () => {
    const path = join(tempDir(), 'algo-pauses.jsonl');
    const store = new FileAlgoPauseStore(path);
    store.pause({ kind: 'group', id: 'g-1' });
    expect(store.resume({ kind: 'group', id: 'g-1' })).toBe(true);
    const reloaded = new FileAlgoPauseStore(path);
    expect(reloaded.isPaused({ executionGroupId: 'g-1' })).toBe(false);
  });

  it('missing file is empty — nothing paused', () => {
    const path = join(tempDir(), 'algo-pauses.jsonl');
    const store = new FileAlgoPauseStore(path);
    expect(store.isPaused({ parentClientOrderId: 'parent-1' })).toBe(false);
  });

  it('a thrown pause append leaves memory unpaused, and a retry writes the line', () => {
    const path = join(tempDir(), 'algo-pauses.jsonl');
    const store = new FileAlgoPauseStore(path);
    writeFileSync(path, '');
    chmodSync(path, 0o444);

    expect(() => store.pause({ kind: 'parent', id: 'parent-1' })).toThrow(/EACCES/);
    expect(store.isPaused({ parentClientOrderId: 'parent-1' })).toBe(false);
    expect(new FileAlgoPauseStore(path).isPaused({ parentClientOrderId: 'parent-1' })).toBe(false);

    chmodSync(path, 0o644);
    expect(store.pause({ kind: 'parent', id: 'parent-1' })).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{"kind":"parent","id":"parent-1","paused":true}\n');
    expect(store.isPaused({ parentClientOrderId: 'parent-1' })).toBe(true);
    expect(new FileAlgoPauseStore(path).isPaused({ parentClientOrderId: 'parent-1' })).toBe(true);
  });

  it('a thrown resume append stays paused, and a retry writes the line', () => {
    const path = join(tempDir(), 'algo-pauses.jsonl');
    const store = new FileAlgoPauseStore(path);
    expect(store.pause({ kind: 'parent', id: 'parent-1' })).toBe(true);
    chmodSync(path, 0o444);

    expect(() => store.resume({ kind: 'parent', id: 'parent-1' })).toThrow(/EACCES/);
    expect(store.isPaused({ parentClientOrderId: 'parent-1' })).toBe(true);
    expect(new FileAlgoPauseStore(path).isPaused({ parentClientOrderId: 'parent-1' })).toBe(true);

    chmodSync(path, 0o644);
    expect(store.resume({ kind: 'parent', id: 'parent-1' })).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(
      '{"kind":"parent","id":"parent-1","paused":true}\n{"kind":"parent","id":"parent-1","paused":false}\n',
    );
    expect(store.isPaused({ parentClientOrderId: 'parent-1' })).toBe(false);
    expect(new FileAlgoPauseStore(path).isPaused({ parentClientOrderId: 'parent-1' })).toBe(false);
  });
});

describe('algo journal paths', () => {
  it('parents and pauses sit beside the EMS ack journal', () => {
    expect(algoParentJournalPath('/data/execution/ems-journal.jsonl')).toBe('/data/execution/algo-parents.jsonl');
    expect(algoPauseJournalPath('/data/execution/ems-journal.jsonl')).toBe('/data/execution/algo-pauses.jsonl');
  });

  it('blank EMS path refuses sibling journals', () => {
    expect(() => algoParentJournalPath('')).toThrow(ExecutionAlgoStorePathUnsetError);
    expect(() => algoPauseJournalPath('')).toThrow(ExecutionAlgoStorePathUnsetError);
  });
});

describe('execution boot durable algo stores', () => {
  it('index wires file parent/pause stores and fail-closed path', () => {
    const src = indexSrc();
    expect(src).toContain('requireExecutionEmsStorePath');
    expect(src).toContain('FileApprovedAlgoParentStore');
    expect(src).toContain('FileAlgoPauseStore');
    expect(src).toContain('algoParentJournalPath');
    expect(src).toContain('algoPauseJournalPath');
    expect(src).not.toContain('new InMemoryApprovedAlgoParentStore()');
    expect(src).not.toContain('new InMemoryAlgoPauseStore()');
  });
});
