import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { createSbeCodec } from './codec.js';
import { JAVA_ENV } from './java-bridge.js';
import type { EncodeInput } from './types.js';

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawnSync };
});

function trade(): EncodeInput {
  return {
    template: 'Trade',
    instrument: 'BTCUSDT',
    tradeId: '9',
    side: 'buy',
    price: '100.25',
    qty: '1.50',
    eventTimeNs: '1',
  };
}

const encodeStdout = '{"ok":true,"template":"Trade","payloadB64":"AQID"}';
const decodeStdout =
  '{"ok":true,"template":"Trade","instrument":"BTCUSDT","tradeId":"9","side":"buy","price":"100.25","qty":"1.50","eventTimeNs":"1"}';

type Failure = {
  readonly label: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
};

const failures: readonly Failure[] = [
  { label: 'non-zero exit', status: 1, signal: null },
  {
    label: 'null status',
    status: null,
    signal: 'SIGKILL',
    error: Object.assign(new Error('spawnSync java ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  },
  {
    label: 'spawn error',
    status: null,
    signal: null,
    error: Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' }),
  },
];

function spawnResult(stdout: string, failure: Failure): SpawnSyncReturns<string> {
  return {
    pid: 42,
    output: [null, stdout, ''],
    stdout,
    stderr: '',
    status: failure.status,
    signal: failure.signal,
    error: failure.error,
  };
}

describe('sbe java codec process status', () => {
  const priorJavaHome = process.env.JAVA_HOME;
  const priorPinned = process.env[JAVA_ENV];
  let dir: string | undefined;

  afterEach(() => {
    spawnSync.mockReset();
    if (priorJavaHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = priorJavaHome;
    if (priorPinned === undefined) delete process.env[JAVA_ENV];
    else process.env[JAVA_ENV] = priorPinned;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('refuses encode and decode when the Java process fails even if stdout looks complete', () => {
    dir = mkdtempSync(join(tmpdir(), 'sbe-codec-exit-'));
    const javaHome = join(dir, 'jdk');
    mkdirSync(join(javaHome, 'bin'), { recursive: true });
    writeFileSync(join(javaHome, 'bin', 'java'), '');
    const jar = join(dir, 'codec.jar');
    writeFileSync(jar, '');
    process.env.JAVA_HOME = javaHome;
    process.env[JAVA_ENV] = jar;

    for (const failure of failures) {
      spawnSync.mockReset();
      spawnSync.mockReturnValue(spawnResult(encodeStdout, failure));
      const encoded = createSbeCodec().encode(trade());
      expect(spawnSync, failure.label).toHaveBeenCalled();
      expect(encoded.ok, failure.label).toBe(false);
      if (!encoded.ok) expect(encoded.reason, failure.label).toBe('sbe_unavailable');

      spawnSync.mockReset();
      spawnSync.mockReturnValue(spawnResult(decodeStdout, failure));
      const decoded = createSbeCodec().decode('AQID');
      expect(spawnSync, failure.label).toHaveBeenCalled();
      expect(decoded.ok, failure.label).toBe(false);
      if (!decoded.ok) expect(decoded.reason, failure.label).toBe('sbe_unavailable');
    }
  });
});
