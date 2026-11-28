import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadP2pEnv } from './testing/env-load-fixture.js';
import { parseOwnerIntegerEnv } from './fee-bps-env.js';
import { InstrumentError, InstrumentService } from './instrument-service.js';
import { P2pError, publishedEscrowDeadlineSeconds, publishedInstrumentRetentionDays } from './p2p-service.js';

/**
 * Owner escrow clock and instrument retention are refuse-closed when unset.
 *
 * Compose used to bake `:-120` / `:-90` so env.ts default(120)/default(90)
 * looked published on every clean clone. Blank is unset; never invent hours/days.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function p2pComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-p2p:');
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('P2P escrow / retention unset refuse', () => {
  it('blank / omit parse to null — never 120 or 90', () => {
    expect(parseOwnerIntegerEnv(undefined)).toBeNull();
    expect(parseOwnerIntegerEnv('')).toBeNull();
    expect(parseOwnerIntegerEnv('   ')).toBeNull();
    expect(parseOwnerIntegerEnv('120')).toBe(120);
    expect(parseOwnerIntegerEnv('90')).toBe(90);
  });

  it('env.ts leaves the escrow clock and the retention unset when the host gives none', async () => {
    for (const host of [{}, { P2P_ESCROW_DEADLINE_SECONDS: '', P2P_INSTRUMENT_RETENTION_DAYS: '' }]) {
      const env = await loadP2pEnv(host);
      expect(env.P2P_ESCROW_DEADLINE_SECONDS).toBeNull();
      expect(env.P2P_INSTRUMENT_RETENTION_DAYS).toBeNull();
    }
    const published = await loadP2pEnv({ P2P_ESCROW_DEADLINE_SECONDS: '120', P2P_INSTRUMENT_RETENTION_DAYS: '90' });
    expect(published.P2P_ESCROW_DEADLINE_SECONDS).toBe(120);
    expect(published.P2P_INSTRUMENT_RETENTION_DAYS).toBe(90);
  });

  it('compose passes empty — never a baked 120 or 90', () => {
    const block = p2pComposeBlock();
    expect(block).toMatch(/P2P_ESCROW_DEADLINE_SECONDS:\s*\$\{P2P_ESCROW_DEADLINE_SECONDS:-\}/);
    expect(block).not.toMatch(/P2P_ESCROW_DEADLINE_SECONDS:\s*\$\{P2P_ESCROW_DEADLINE_SECONDS:-120\}/);
    expect(block).toMatch(/P2P_INSTRUMENT_RETENTION_DAYS:\s*\$\{P2P_INSTRUMENT_RETENTION_DAYS:-\}/);
    expect(block).not.toMatch(/P2P_INSTRUMENT_RETENTION_DAYS:\s*\$\{P2P_INSTRUMENT_RETENTION_DAYS:-90\}/);
  });

  it('publishedEscrowDeadlineSeconds refuses null rather than inventing 120', () => {
    expect(() => publishedEscrowDeadlineSeconds(null)).toThrow(P2pError);
    expect(() => publishedEscrowDeadlineSeconds(undefined)).toThrow(expect.objectContaining({ code: 'p2p.escrow_deadline_unset' }));
    expect(publishedEscrowDeadlineSeconds(120)).toBe(120);
    expect(() => publishedEscrowDeadlineSeconds(29)).toThrow(expect.objectContaining({ code: 'p2p.invalid_escrow_deadline' }));
  });

  it('publishedInstrumentRetentionDays refuses null rather than inventing 90', () => {
    expect(() => publishedInstrumentRetentionDays(null)).toThrow(P2pError);
    expect(() => publishedInstrumentRetentionDays(undefined)).toThrow(expect.objectContaining({ code: 'p2p.instrument_retention_unset' }));
    expect(publishedInstrumentRetentionDays(90)).toBe(90);
    expect(() => publishedInstrumentRetentionDays(29)).toThrow(expect.objectContaining({ code: 'p2p.invalid_instrument_retention' }));
  });

  it('purge refuses when retentionDays was omitted — never 90', async () => {
    const instruments = new InstrumentService({} as never);
    await expect(instruments.purgeExpiredSnapshots(500)).rejects.toBeInstanceOf(InstrumentError);
    await expect(instruments.purgeExpiredSnapshots(500)).rejects.toMatchObject({
      code: 'p2p.instrument_retention_unset',
    });
  });
});
