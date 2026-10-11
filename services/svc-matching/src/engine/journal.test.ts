import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FileJournal, FileJournalLockedError, JOURNAL_LOCKED, decodeAll } from './journal-io.js';

const completeLine = JSON.stringify({
  seq: 1,
  kind: 'submit',
  marketId: 'BTC/USDT',
  at: '2026-01-01T00:00:00.000Z',
  order: {
    orderId: '00000000-0000-4000-8000-000000000001',
    accountId: 'a',
    type: 'limit',
    side: 'buy',
    qty: '1',
    price: '100',
    stopPrice: null,
    tif: 'GTC',
  },
});

const partialTail = '{"seq":2,"kind":"cancel","marketId":"BTC/USDT","at":"x","orderId":"y';

describe('decodeAll — crash mid-write residual', () => {
  it('skips a truncated last line so recovery can boot', () => {
    const body = `${completeLine}\n{"seq":2,"kind":"cancel","marketId":"BTC/USDT","at":"2026-01-01T00:00:01.000Z","orderId":"00000000-0000-4000-8000-000000000002`;
    const records = decodeAll(body);
    expect(records).toHaveLength(1);
    expect(records[0]!.seq).toBe(1);
  });

  it('still loads a complete journal that ends with a newline', () => {
    const records = decodeAll(`${completeLine}\n`);
    expect(records).toHaveLength(1);
  });

  it('throws on a corrupt line in the middle — that is not crash residue', () => {
    const body = `{not-json}\n${completeLine}\n`;
    expect(() => decodeAll(body)).toThrow();
  });
});

describe('FileJournal boot from a truncated file', () => {
  it('opens and reads past a partial tail without dying', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-'));
    const path = join(dir, 'engine.ndjson');
    writeFileSync(path, `${completeLine}\n${partialTail}`);

    const journal = new FileJournal(path);
    expect(journal.length).toBe(1);
    expect(journal.read()[0]!.seq).toBe(1);
    journal.close();
  });

  /**
   * W9 residual — #1520 made decode skip a torn last line, but FileJournal
   * still opened O_APPEND on the raw file. The next durable append glued onto
   * the partial bytes, so a later boot either skipped a real record or threw
   * mid-file corruption and refused recovery.
   */
  it('rewrites a clean file so appends after a truncated boot stay bootable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-'));
    const path = join(dir, 'engine.ndjson');
    writeFileSync(path, `${completeLine}\n${partialTail}`);

    const j1 = new FileJournal(path);
    expect(j1.length).toBe(1);
    const appended = j1.append({
      kind: 'cancel',
      marketId: 'BTC/USDT',
      at: '2026-01-01T00:00:02.000Z',
      orderId: '00000000-0000-4000-8000-000000000003',
    });
    expect(appended.seq).toBe(2);
    j1.close();

    // On-disk body must decode cleanly — no glued partial + new line.
    const raw = readFileSync(path, 'utf8');
    expect(() => decodeAll(raw)).not.toThrow();
    expect(decodeAll(raw).map((r) => r.seq)).toEqual([1, 2]);
    expect(raw).not.toContain(partialTail);

    const j2 = new FileJournal(path);
    expect(j2.length).toBe(2);
    expect(j2.read().map((r) => r.seq)).toEqual([1, 2]);
    j2.close();
  });

  it('refuses a short journal write before claiming durability', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-'));
    const path = join(dir, 'engine.ndjson');
    writeFileSync(path, `${completeLine}\n`);

    const journal = new FileJournal(path);
    // Force a short write by stubbing writeSync via monkey-patch is brittle;
    // the public contract is: a failed append must not grow read() length.
    // Exercised with a closed fd after close — write must throw, length stays 1.
    journal.close();
    expect(() =>
      journal.append({
        kind: 'cancel',
        marketId: 'BTC/USDT',
        at: '2026-01-01T00:00:03.000Z',
        orderId: '00000000-0000-4000-8000-000000000004',
      }),
    ).toThrow();
    expect(journal.length).toBe(1);
  });

  it('truncates a short write back to the previous complete prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-short-'));
    const path = join(dir, 'engine.ndjson');
    const statusPath = join(dir, 'status.json');
    const command = {
      kind: 'cancel' as const,
      marketId: 'BTC/USDT',
      at: '2026-01-01T00:00:04.000Z',
      orderId: '00000000-0000-4000-8000-000000000005',
    };

    const setup = new FileJournal(path);
    setup.append(command);
    const admitted = setup.length;
    setup.close();
    const prefix = readFileSync(path);

    // A new O_APPEND fd may write up to RLIMIT_FSIZE bytes in one call, so the
    // limited line has to be longer than that cap. The cap still has to fit
    // the existing prefix rewrite, the lock file, and the status file.
    const longCommand = { ...command, at: `${command.at}${'x'.repeat(2000)}` };
    const probePath = join(dir, 'probe.ndjson');
    const probe = new FileJournal(probePath);
    probe.append(longCommand);
    const longLen = statSync(probePath).size;
    probe.close();
    const byteLimit = Math.floor(longLen / 2);
    expect(byteLimit).toBeGreaterThan(prefix.length);
    expect(byteLimit).toBeLessThan(longLen);

    const child = await runShortWriteChild({
      journalPath: path,
      statusPath,
      command: longCommand,
      byteLimit,
    });
    expect(existsSync(statusPath), child.output).toBe(true);
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as { message: string; length: number };
    const match = status.message.match(/short journal write: wrote (\d+) of (\d+) bytes/);
    expect(match, child.output).not.toBeNull();
    const wrote = Number(match![1]);
    const expected = Number(match![2]);
    expect(wrote).toBeGreaterThan(0);
    expect(wrote).toBeLessThan(expected);
    expect(status.length).toBe(admitted);
    expect(readFileSync(path)).toEqual(prefix);

    const journal = new FileJournal(path);
    try {
      expect(journal.length).toBe(admitted);
      const appended = journal.append(longCommand);
      expect(appended.seq).toBe(admitted + 1);
      const raw = readFileSync(path);
      expect(raw.subarray(0, prefix.length).equals(prefix)).toBe(true);
      const added = raw.subarray(prefix.length).toString('utf8');
      expect(added.endsWith('\n')).toBe(true);
      expect(added.slice(0, -1).includes('\n')).toBe(false);
      expect((JSON.parse(added.slice(0, -1)) as { seq: number }).seq).toBe(admitted + 1);
      const lines = raw
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(admitted + 1);
      expect(lines.every((line) => JSON.parse(line))).toBe(true);
      expect(decodeAll(raw.toString('utf8')).map((record) => record.seq)).toEqual(
        Array.from({ length: admitted + 1 }, (_, index) => index + 1),
      );
    } finally {
      journal.close();
    }
  }, 20_000);

  it('leaves the live journal untouched when the replacement write is not durable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-rewrite-'));
    const path = join(dir, 'engine.ndjson');
    const statusPath = join(dir, 'status.json');
    const command = {
      kind: 'cancel' as const,
      marketId: 'BTC/USDT',
      at: `2026-01-01T00:00:05.000Z${'x'.repeat(4000)}`,
      orderId: '00000000-0000-4000-8000-000000000006',
    };

    const setup = new FileJournal(path);
    setup.append(command);
    const admitted = setup.length;
    setup.close();
    const original = readFileSync(path);
    const before = statSync(path);
    const byteLimit = 1024;
    expect(original.length).toBeGreaterThan(byteLimit);

    const child = await runRewriteFaultChild({ journalPath: path, statusPath, byteLimit });
    expect(existsSync(statusPath), child.output).toBe(true);
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as { opened: boolean; message: string };
    const match = status.message.match(/short journal rewrite: wrote (\d+) of (\d+) bytes/);
    expect(match, child.output).not.toBeNull();
    const wrote = Number(match![1]);
    const expected = Number(match![2]);
    expect(wrote).toBeGreaterThan(0);
    expect(wrote).toBeLessThan(expected);
    expect(status.opened).toBe(false);

    const after = statSync(path);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(path)).toEqual(original);

    const journal = new FileJournal(path);
    try {
      expect(journal.length).toBe(admitted);
      expect(journal.read()[0]).toMatchObject(command);
    } finally {
      journal.close();
    }
  }, 20_000);
});

describe('FileJournal exclusive writer lock', () => {
  const cancel = {
    kind: 'cancel' as const,
    marketId: 'BTC/USDT',
    at: '2026-01-01T00:00:02.000Z',
    orderId: '00000000-0000-4000-8000-000000000003',
  };

  it('refuses a second open with journal_locked and still appends+fsyncs on the holder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-lock-'));
    const path = join(dir, 'engine.ndjson');

    const holder = new FileJournal(path);
    expect(() => new FileJournal(path)).toThrow(FileJournalLockedError);
    try {
      new FileJournal(path);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FileJournalLockedError);
      expect(err).toMatchObject({ code: JOURNAL_LOCKED, name: 'FileJournalLockedError', path });
    }

    const appended = holder.append(cancel);
    expect(appended.seq).toBe(1);
    holder.close();

    const raw = readFileSync(path, 'utf8');
    expect(decodeAll(raw)).toHaveLength(1);
    expect(existsSync(`${path}.lock`)).toBe(false);

    const next = new FileJournal(path);
    expect(next.length).toBe(1);
    expect(next.read()[0]!.seq).toBe(1);
    next.close();
  });

  it('takes a lock whose pid is this process but whose nonce this process did not write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-reuse-'));
    const path = join(dir, 'engine.ndjson');
    writeFileSync(path, '', 'utf8');
    writeFileSync(`${path}.lock`, `${process.pid}\nnot-ours\n`, 'utf8');

    const journal = new FileJournal(path);
    expect(journal.length).toBe(0);
    journal.close();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('releases only the lock nonce this process still holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-release-'));
    const path = join(dir, 'engine.ndjson');
    const journal = new FileJournal(path);
    const replacement = `${process.pid}\nreplacement-nonce\n`;
    writeFileSync(`${path}.lock`, replacement);
    journal.close();
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(replacement);
  });

  it('does not let a slower dead-lock recoverer unlink the winner or append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-journal-recover-'));
    const path = join(dir, 'engine.ndjson');
    const barrier = join(dir, 'barrier');
    mkdirSync(barrier);
    writeFileSync(path, '', 'utf8');
    writeFileSync(`${path}.lock`, `${deadPid()}\ndead-nonce\n`, 'utf8');

    const winner = startRecoverer(path, barrier);
    const slower = startRecoverer(path, barrier);
    const children = [winner, slower];
    const stderr = new Map<number, string>();
    for (const child of children) {
      stderr.set(child.pid!, '');
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.set(child.pid!, `${stderr.get(child.pid!) ?? ''}${chunk.toString('utf8')}`);
      });
    }

    try {
      await waitFor(
        () => existsSync(join(barrier, `seen-${winner.pid}`)) && existsSync(join(barrier, `seen-${slower.pid}`)),
        'both recoverers to observe the dead lock',
      );
      writeFileSync(join(barrier, `release-${winner.pid}`), '1');
      await waitFor(() => existsSync(join(barrier, `appended-${winner.pid}`)), 'winner to append');
      const winnerLock = readFileSync(join(barrier, `appended-${winner.pid}`), 'utf8');

      writeFileSync(join(barrier, `release-${slower.pid}`), '1');
      await waitFor(
        () => existsSync(join(barrier, `failed-${slower.pid}`)) || existsSync(join(barrier, `appended-${slower.pid}`)),
        'slower recoverer to finish',
      );

      const appended = readdirSync(barrier).filter((name) => name.startsWith('appended-'));
      expect(appended, stderrText(children, stderr)).toEqual([`appended-${winner.pid}`]);
      expect(readFileSync(`${path}.lock`, 'utf8'), stderrText(children, stderr)).toBe(winnerLock);
      expect(readFileSync(join(barrier, `failed-${slower.pid}`), 'utf8')).toContain(JOURNAL_LOCKED);
      expect(decodeAll(readFileSync(path, 'utf8'))).toHaveLength(1);
    } finally {
      writeFileSync(join(barrier, 'done'), '1');
      writeFileSync(join(barrier, `release-${winner.pid}`), '1');
      writeFileSync(join(barrier, `release-${slower.pid}`), '1');
      await Promise.all(children.map((child) => waitExit(child)));
    }
  }, 20_000);
});

function runRewriteFaultChild(opts: { journalPath: string; statusPath: string; byteLimit: number }): Promise<{ output: string }> {
  const childPath = fileURLToPath(new URL('./journal-rewrite-fault-child.ts', import.meta.url));
  const launcher = [
    'import os, resource, sys',
    'limit = int(sys.argv[1])',
    'soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)',
    'resource.setrlimit(resource.RLIMIT_FSIZE, (limit, hard))',
    'os.execv(sys.argv[2], sys.argv[2:])',
  ].join('\n');
  const child = spawn('python3', ['-c', launcher, String(opts.byteLimit), process.execPath, '--import', 'tsx', childPath], {
    env: {
      ...process.env,
      JOURNAL_PATH: opts.journalPath,
      JOURNAL_STATUS: opts.statusPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`rewrite-fault child timed out\n${output}`));
    }, 8_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ output: `code=${code} signal=${signal}\n${output}` });
    });
  });
}

function runShortWriteChild(opts: {
  journalPath: string;
  statusPath: string;
  command: { kind: 'cancel'; marketId: string; at: string; orderId: string };
  byteLimit: number;
}): Promise<{ output: string }> {
  const childPath = fileURLToPath(new URL('./journal-short-write-child.ts', import.meta.url));
  const launcher = [
    'import os, resource, sys',
    'limit = int(sys.argv[1])',
    'soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)',
    'resource.setrlimit(resource.RLIMIT_FSIZE, (limit, hard))',
    'os.execv(sys.argv[2], sys.argv[2:])',
  ].join('\n');
  const child = spawn('python3', ['-c', launcher, String(opts.byteLimit), process.execPath, '--import', 'tsx', childPath], {
    env: {
      ...process.env,
      JOURNAL_PATH: opts.journalPath,
      JOURNAL_STATUS: opts.statusPath,
      JOURNAL_COMMAND: JSON.stringify(opts.command),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`short-write child timed out\n${output}`));
    }, 8_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ output: `code=${code} signal=${signal}\n${output}` });
    });
  });
}

function deadPid(): number {
  for (let pid = 1_000_000; pid < 1_000_020; pid++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not find a dead pid');
}

function startRecoverer(journalPath: string, barrier: string): ChildProcess {
  const childPath = fileURLToPath(new URL('./journal-lock-recover-child.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
    env: {
      ...process.env,
      JOURNAL_PATH: journalPath,
      MATCHING_JOURNAL_LOCK_RECOVER_BARRIER: barrier,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) throw new Error('recoverer did not start');
  return child;
}

function stderrText(children: readonly ChildProcess[], stderr: ReadonlyMap<number, string>): string {
  return children.map((child) => `${child.pid}: ${stderr.get(child.pid!) ?? ''}`).join('\n');
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
