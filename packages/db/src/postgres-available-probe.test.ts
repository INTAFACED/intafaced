import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readInfraProbes, redactUrl } from './infra-journal.js';
import { postgresAvailable } from './testing.js';

describe('postgresAvailable required probe', () => {
  const prevRequire = process.env.REQUIRE_POSTGRES;
  const prevJournal = process.env.INTAFACED_INFRA_JOURNAL;
  let journalDir: string | undefined;

  afterEach(() => {
    if (prevRequire === undefined) delete process.env.REQUIRE_POSTGRES;
    else process.env.REQUIRE_POSTGRES = prevRequire;
    if (prevJournal === undefined) delete process.env.INTAFACED_INFRA_JOURNAL;
    else process.env.INTAFACED_INFRA_JOURNAL = prevJournal;
    if (journalDir) rmSync(journalDir, { recursive: true, force: true });
    journalDir = undefined;
  });

  it('redacts userinfo when a required probe fails', async () => {
    const password = 'secret-test-pw';
    const user = 'probe';
    const withSecret = `postgres://${user}:${password}@127.0.0.1:1/intafaced_test`;
    const plain = 'postgres://Nitro@127.0.0.1:1/intafaced_test';
    process.env.REQUIRE_POSTGRES = '1';
    journalDir = mkdtempSync(join(tmpdir(), 'l85-probe-'));
    process.env.INTAFACED_INFRA_JOURNAL = journalDir;

    const secretMessage = await requiredProbeFailure(withSecret);
    expect(secretMessage).toMatch(/Postgres required/);
    expect(secretMessage).toMatch(/unreachable/);
    expect(secretMessage).not.toContain(password);
    expect(secretMessage).not.toContain(`${user}:${password}@`);
    expect(secretMessage).toContain(redactUrl(withSecret));

    const plainMessage = await requiredProbeFailure(plain);
    expect(plainMessage).toMatch(/Postgres required/);
    expect(plainMessage).toMatch(/unreachable/);
    expect(plainMessage).toContain(redactUrl(plain));
    expect(plainMessage).toContain('127.0.0.1:1');
    expect(plainMessage).toContain('intafaced_test');
  });

  it('redacts driver-echoed credentials from the thrown error and journal', async () => {
    const password = 'driver-test-secret';
    const target = `postgres://probe:${password}@127.0.0.1:1/intafaced_test`;
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(
      async () => {
        throw new Error(`error: ${target}?%70assword=${password} password='${password} tail'`);
      },
      { end },
    );
    process.env.REQUIRE_POSTGRES = '1';
    journalDir = mkdtempSync(join(tmpdir(), 'db-driver-probe-'));
    process.env.INTAFACED_INFRA_JOURNAL = journalDir;
    vi.resetModules();
    vi.doMock('postgres', () => ({ default: () => sql }));
    try {
      const { postgresAvailable: mockedProbe } = await import('./testing.js');
      let message = '';
      try {
        await mockedProbe(target);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Postgres required');
      expect(message.includes(password)).toBe(false);
      expect(message.includes('tail')).toBe(false);
      const [probe] = readInfraProbes();
      expect(probe?.outcome).toBe('required-failed');
      expect(JSON.stringify(probe).includes(password)).toBe(false);
      expect(end).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('postgres');
      vi.resetModules();
    }
  });
});

async function requiredProbeFailure(url: string): Promise<string> {
  try {
    const ok = await postgresAvailable(url);
    throw new Error(`expected probe to throw, got ${String(ok)}`);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (err.message.startsWith('expected probe to throw')) throw err;
    return err.message;
  }
}
