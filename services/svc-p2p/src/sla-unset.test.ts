import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadP2pEnv } from './testing/env-load-fixture.js';
import { parseOwnerIntegerEnv } from './fee-bps-env.js';
import {
  P2pError,
  publishedDisputeEscalationRecheckSeconds,
  publishedDisputeSlaSeconds,
  publishedPaymentDeadlineSeconds,
  publishedReleaseDeadlineSeconds,
  publishedSweepIntervalSeconds,
} from './p2p-service.js';

/**
 * Owner payment/release/sweep/dispute SLA clocks are refuse-closed when unset.
 *
 * Compose used to bake `:-900` / `:-1800` / `:-30` / `:-604800` / `:-3600`
 * so env.ts git-defaults looked published on every clean clone. Blank is unset;
 * never invent hours.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function p2pComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-p2p:');
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('P2P payment/release/sweep/dispute SLA unset refuse', () => {
  it('blank / omit parse to null — never 900 / 1800 / 604800 / 3600 / 30', () => {
    expect(parseOwnerIntegerEnv(undefined)).toBeNull();
    expect(parseOwnerIntegerEnv('')).toBeNull();
    expect(parseOwnerIntegerEnv('   ')).toBeNull();
    expect(parseOwnerIntegerEnv('900')).toBe(900);
    expect(parseOwnerIntegerEnv('1800')).toBe(1800);
    expect(parseOwnerIntegerEnv('604800')).toBe(604800);
    expect(parseOwnerIntegerEnv('3600')).toBe(3600);
    expect(parseOwnerIntegerEnv('30')).toBe(30);
  });

  it('env.ts leaves payment/release/sweep/dispute clocks unset when the host gives none', async () => {
    const names = [
      'P2P_PAYMENT_DEADLINE_SECONDS',
      'P2P_RELEASE_DEADLINE_SECONDS',
      'P2P_SWEEP_INTERVAL_SECONDS',
      'P2P_DISPUTE_SLA_SECONDS',
      'P2P_DISPUTE_ESCALATION_RECHECK_SECONDS',
    ] as const;
    for (const host of [{}, Object.fromEntries(names.map((name) => [name, '   ']))]) {
      const env = await loadP2pEnv(host);
      for (const name of names) expect(env[name], name).toBeNull();
    }
  });

  it('compose passes empty — never baked 900 / 1800 / 30 / 604800 / 3600', () => {
    const block = p2pComposeBlock();
    expect(block).toMatch(/P2P_PAYMENT_DEADLINE_SECONDS:\s*\$\{P2P_PAYMENT_DEADLINE_SECONDS:-\}/);
    expect(block).not.toMatch(/P2P_PAYMENT_DEADLINE_SECONDS:\s*\$\{P2P_PAYMENT_DEADLINE_SECONDS:-900\}/);
    expect(block).toMatch(/P2P_RELEASE_DEADLINE_SECONDS:\s*\$\{P2P_RELEASE_DEADLINE_SECONDS:-\}/);
    expect(block).not.toMatch(/P2P_RELEASE_DEADLINE_SECONDS:\s*\$\{P2P_RELEASE_DEADLINE_SECONDS:-1800\}/);
    expect(block).toMatch(/P2P_SWEEP_INTERVAL_SECONDS:\s*\$\{P2P_SWEEP_INTERVAL_SECONDS:-\}/);
    expect(block).not.toMatch(/P2P_SWEEP_INTERVAL_SECONDS:\s*\$\{P2P_SWEEP_INTERVAL_SECONDS:-30\}/);
    expect(block).toMatch(/P2P_DISPUTE_SLA_SECONDS:\s*\$\{P2P_DISPUTE_SLA_SECONDS:-\}/);
    expect(block).not.toMatch(/P2P_DISPUTE_SLA_SECONDS:\s*\$\{P2P_DISPUTE_SLA_SECONDS:-604800\}/);
    expect(block).toMatch(/P2P_DISPUTE_ESCALATION_RECHECK_SECONDS:\s*\$\{P2P_DISPUTE_ESCALATION_RECHECK_SECONDS:-\}/);
    expect(block).not.toMatch(/P2P_DISPUTE_ESCALATION_RECHECK_SECONDS:\s*\$\{P2P_DISPUTE_ESCALATION_RECHECK_SECONDS:-3600\}/);
  });

  it('publishedPaymentDeadlineSeconds refuses null rather than inventing 15m', () => {
    expect(() => publishedPaymentDeadlineSeconds(null)).toThrow(P2pError);
    expect(() => publishedPaymentDeadlineSeconds(undefined)).toThrow(expect.objectContaining({ code: 'p2p.payment_deadline_unset' }));
    expect(publishedPaymentDeadlineSeconds(900)).toBe(900);
    expect(() => publishedPaymentDeadlineSeconds(59)).toThrow(expect.objectContaining({ code: 'p2p.invalid_payment_deadline' }));
  });

  it('publishedReleaseDeadlineSeconds refuses null rather than inventing 30m', () => {
    expect(() => publishedReleaseDeadlineSeconds(null)).toThrow(P2pError);
    expect(() => publishedReleaseDeadlineSeconds(undefined)).toThrow(expect.objectContaining({ code: 'p2p.release_deadline_unset' }));
    expect(publishedReleaseDeadlineSeconds(1800)).toBe(1800);
    expect(() => publishedReleaseDeadlineSeconds(59)).toThrow(expect.objectContaining({ code: 'p2p.invalid_release_deadline' }));
  });

  it('publishedDisputeSlaSeconds refuses null rather than inventing 7d', () => {
    expect(() => publishedDisputeSlaSeconds(null)).toThrow(P2pError);
    expect(() => publishedDisputeSlaSeconds(undefined)).toThrow(expect.objectContaining({ code: 'p2p.dispute_sla_unset' }));
    expect(publishedDisputeSlaSeconds(604800)).toBe(604800);
    expect(() => publishedDisputeSlaSeconds(3599)).toThrow(expect.objectContaining({ code: 'p2p.invalid_dispute_sla' }));
  });

  it('publishedDisputeEscalationRecheckSeconds refuses null rather than inventing 1h', () => {
    expect(() => publishedDisputeEscalationRecheckSeconds(null)).toThrow(P2pError);
    expect(() => publishedDisputeEscalationRecheckSeconds(undefined)).toThrow(
      expect.objectContaining({ code: 'p2p.dispute_escalation_recheck_unset' }),
    );
    expect(publishedDisputeEscalationRecheckSeconds(3600)).toBe(3600);
    expect(() => publishedDisputeEscalationRecheckSeconds(59)).toThrow(
      expect.objectContaining({ code: 'p2p.invalid_dispute_escalation_recheck' }),
    );
  });

  it('publishedSweepIntervalSeconds refuses null rather than inventing 30s', () => {
    expect(() => publishedSweepIntervalSeconds(null)).toThrow(P2pError);
    expect(() => publishedSweepIntervalSeconds(undefined)).toThrow(expect.objectContaining({ code: 'p2p.sweep_interval_unset' }));
    expect(publishedSweepIntervalSeconds(30)).toBe(30);
    expect(() => publishedSweepIntervalSeconds(4)).toThrow(expect.objectContaining({ code: 'p2p.invalid_sweep_interval' }));
  });
});
