import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { BankError } from './errors.js';
import { BANK_OFFRAMP_COOLING_HOURS_ENV, assertOfframpDestCoolingElapsed, requireOfframpCoolingHours } from './offramp-cooling.js';
import { RampService } from './ramps/ramp-service.js';
import { CRYPTO_LEDGER_PROGRAMME } from './ramps/rails.js';
import { memoryWithdrawDestinations } from './withdraw-destination.js';
import { memorySecurityLock } from './security-lock.js';
import { memoryFraudList } from './ramps/fraud-list.js';

function unusedSql(): Sql {
  const trap = () => {
    throw new Error('sql must not run before cooling refuse');
  };
  return new Proxy(trap, { apply: trap, get: trap }) as unknown as Sql;
}

describe('requireOfframpCoolingHours — owner window, never invent 24h', () => {
  it('refuses unset, blank, non-integer, and negative by name', () => {
    for (const raw of [undefined, '', '  ', '24h', 'abc', '-1', '1.5', '1e2']) {
      try {
        requireOfframpCoolingHours(raw);
        throw new Error(`expected refuse for ${JSON.stringify(raw)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(BankError);
        expect(err).toMatchObject({ code: 'bank.offramp_cooling_unset' });
      }
    }
  });

  it('accepts a non-negative integer the owner actually set — including zero', () => {
    expect(requireOfframpCoolingHours('0')).toBe(0);
    expect(requireOfframpCoolingHours('1')).toBe(1);
    expect(requireOfframpCoolingHours(' 48 ')).toBe(48);
    expect(BANK_OFFRAMP_COOLING_HOURS_ENV).toBe('BANK_OFFRAMP_COOLING_HOURS');
  });

  it('does not substitute 24 when the owner is silent', () => {
    expect(() => requireOfframpCoolingHours(undefined)).toThrow(BankError);
    expect(() => requireOfframpCoolingHours(undefined)).not.toThrow(/24/);
  });
});

describe('RampService.offramp — cooling refuse is before dest, claim, and withdrawHold', () => {
  it('blank owner window refuses bank.offramp_cooling_unset with no ledger post', async () => {
    const ledger = new MemoryLedger();
    const ramps = new RampService(unusedSql(), ledger, {
      securityLock: memorySecurityLock(),
      fraudList: memoryFraudList(),
      programme: CRYPTO_LEDGER_PROGRAMME,
      offrampCoolingHours: '',
    });
    await expect(
      ramps.offramp({
        offrampId: randomUUID(),
        userId: '11111111-1111-4111-8111-111111111111',
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        destinationRef: '0x000000000000000000000000000000000000dEaD',
        clientRef: 'cool-no-sql',
      }),
    ).rejects.toMatchObject({ code: 'bank.offramp_cooling_unset' });
    expect(ledger.journal()).toHaveLength(0);
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
  });

  it('dest inside window refuses bank.offramp_cooling_active with no ledger post and no sql', async () => {
    const ledger = new MemoryLedger();
    const dests = memoryWithdrawDestinations();
    const userId = '11111111-1111-4111-8111-111111111111';
    await dests.persist({ userId, kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' });
    const ramps = new RampService(unusedSql(), ledger, {
      securityLock: memorySecurityLock(),
      fraudList: memoryFraudList(),
      programme: CRYPTO_LEDGER_PROGRAMME,
      destinations: dests,
      offrampCoolingHours: '48',
    });
    await expect(
      ramps.offramp({
        offrampId: randomUUID(),
        userId,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        clientRef: 'cool-active-no-sql',
      }),
    ).rejects.toMatchObject({ code: 'bank.offramp_cooling_active' });
    expect(ledger.journal()).toHaveLength(0);
  });

  it('hours set and dest missing is withdraw_destination_missing — not dest-elapsed', async () => {
    const ledger = new MemoryLedger();
    const ramps = new RampService(unusedSql(), ledger, {
      securityLock: memorySecurityLock(),
      fraudList: memoryFraudList(),
      programme: CRYPTO_LEDGER_PROGRAMME,
      destinations: memoryWithdrawDestinations(),
      offrampCoolingHours: '48',
    });
    await expect(
      ramps.offramp({
        offrampId: randomUUID(),
        userId: '11111111-1111-4111-8111-111111111111',
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        clientRef: 'cool-missing-dest',
      }),
    ).rejects.toMatchObject({ code: 'bank.withdraw_destination_missing' });
    expect(ledger.journal()).toHaveLength(0);
  });
});

describe('assertOfframpDestCoolingElapsed — dest clock, never invent 24h', () => {
  const now = new Date('2026-09-03T12:00:00.000Z');

  it('zero hours is no wait even when dest just changed', () => {
    expect(() => assertOfframpDestCoolingElapsed(0, now, now)).not.toThrow();
  });

  it('refuses when dest last-changed is inside the owner window', () => {
    const destUpdatedAt = new Date(now.getTime() - 47 * 60 * 60 * 1000);
    try {
      assertOfframpDestCoolingElapsed(48, destUpdatedAt, now);
      throw new Error('expected refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(BankError);
      expect(err).toMatchObject({ code: 'bank.offramp_cooling_active' });
    }
  });

  it('passes when dest last-changed is at or older than the window', () => {
    expect(() => assertOfframpDestCoolingElapsed(48, new Date(now.getTime() - 48 * 60 * 60 * 1000), now)).not.toThrow();
    expect(() => assertOfframpDestCoolingElapsed(48, new Date(now.getTime() - 49 * 60 * 60 * 1000), now)).not.toThrow();
  });
});

describe('compose BANK_OFFRAMP_COOLING_HOURS empty default (svc-bank only)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const match = compose.match(/^  svc-bank:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-bank service block missing from docker-compose.apps.yml');
  const block = match[0];

  it('svc-bank names the key with an empty default — never 24', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-bank/);
    expect(block).toMatch(/BANK_OFFRAMP_COOLING_HOURS:\s*\$\{BANK_OFFRAMP_COOLING_HOURS:-\}/);
    expect(block).not.toMatch(/BANK_OFFRAMP_COOLING_HOURS:\s*\$\{BANK_OFFRAMP_COOLING_HOURS:-24\}/);
    expect(block).not.toMatch(/BANK_OFFRAMP_COOLING_HOURS:\s*['"]?24/);
  });

  it('does not recut other services with this key', () => {
    const hits = compose.match(/^\s+BANK_OFFRAMP_COOLING_HOURS:/gm) ?? [];
    expect(hits, 'BANK_OFFRAMP_COOLING_HOURS must appear once (svc-bank only)').toHaveLength(1);
  });
});
