import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateFraud, FRAUD_THRESHOLD_UNPUBLISHED, isAutoDecline, type FraudDecision } from './evaluate.js';
import { payServiceSource } from '../payment-service/source.testkit.js';

/**
 * Unit card — pay.fraud mechanism · wave 13 L02
 *
 * 1. Promise: SPEC-PAY-VERTICALS §3 — velocity, amount anomaly, blocklists,
 *    explainable decisions, kill-switch; never silent decline.
 * 2. Reachable break on tip: configured rules silently allow when their signal is
 *    absent/malformed, and blocklist reasons disclose the matched IP/device value.
 * 3. Done bar: missing configured signals review with reasons; explanations do not
 *    disclose signal values; chargeback money stays unwired (Class X park).
 * 4. Class P (policy/mechanism, no ledger post).
 * 5. Paths: services/svc-pay/src/fraud/** only — no payment-service dual-write.
 * 6. RED first.
 * 7. Collision: clear of Denon #1625–1627.
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = {
  merchantId: 'm_1',
  amount: '100',
  assetId: 'USDT',
};

/** Kill-switch unused scoring rules so a focused assertion is not drowned in unpublished-threshold reviews. */
const scoringOff = {
  velocity_count: false,
  velocity_volume: false,
  amount_anomaly: false,
} as const;

describe('pay.fraud mechanism — evaluateFraud', () => {
  it('allows a clean payment when scoring rules are kill-switched and no blocklist is configured', () => {
    const d = evaluateFraud({ ...base, enabled: scoringOff });
    expect(d.outcome).toBe('allow');
    expect(d.reasons).toEqual([]);
    expect(d.skippedDisabled).toEqual(expect.arrayContaining(['velocity_count', 'velocity_volume', 'amount_anomaly']));
  });

  it('D26-P1-P5: enabled velocity_count with unpublished maxPaymentsInWindow is not silent allow', () => {
    const d = evaluateFraud({
      ...base,
      enabled: { velocity_count: true, velocity_volume: false, amount_anomaly: false },
    });
    expect(d.outcome).not.toBe('allow');
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons).toEqual([{ ruleId: 'velocity_count', detail: `${FRAUD_THRESHOLD_UNPUBLISHED}: maxPaymentsInWindow` }]);
    expect(d.outcome).toBe('review');
  });

  it('D26-P1-P5: enabled volume and amount_anomaly with unpublished thresholds are not silent allow', () => {
    const volume = evaluateFraud({
      ...base,
      enabled: { velocity_count: false, velocity_volume: true, amount_anomaly: false },
    });
    expect(volume.outcome).toBe('review');
    expect(volume.reasons).toEqual([{ ruleId: 'velocity_volume', detail: `${FRAUD_THRESHOLD_UNPUBLISHED}: maxVolumeInWindow` }]);

    const amount = evaluateFraud({
      ...base,
      enabled: { velocity_count: false, velocity_volume: false, amount_anomaly: true },
      thresholds: { amountAnomalyMultiplier: Number.NaN },
    });
    expect(amount.outcome).toBe('review');
    expect(amount.reasons).toEqual([{ ruleId: 'amount_anomaly', detail: `${FRAUD_THRESHOLD_UNPUBLISHED}: amountAnomalyMultiplier` }]);
  });

  it('D26-P1-P5: default-enabled scoring (missing key) with unset thresholds is not silent allow', () => {
    const d = evaluateFraud(base);
    expect(d.outcome).toBe('review');
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons.map((r) => r.ruleId).sort()).toEqual(['amount_anomaly', 'velocity_count', 'velocity_volume']);
    expect(d.reasons.every((r) => r.detail.startsWith(FRAUD_THRESHOLD_UNPUBLISHED))).toBe(true);
  });

  it('D26-P1-P5: kill-switched scoring may skip unpublished thresholds', () => {
    const d = evaluateFraud({
      ...base,
      enabled: { ...scoringOff, velocity_count: false },
    });
    expect(d.outcome).toBe('allow');
    expect(d.reasons).toEqual([]);
    expect(d.skippedDisabled).toContain('velocity_count');
  });

  it('declines blocklisted IP with an explicit reason that does not disclose the IP', () => {
    const d = evaluateFraud({
      ...base,
      ip: '203.0.113.9',
      blocklists: { ips: ['203.0.113.9'] },
      enabled: scoringOff,
    });
    expect(d.outcome).toBe('decline');
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons[0]?.ruleId).toBe('blocklist_ip');
    expect(d.reasons[0]?.detail).not.toContain('203.0.113.9');
    expect(isAutoDecline(d)).toBe(true);
  });

  it('declines blocklisted device without disclosing the device identifier', () => {
    const d = evaluateFraud({
      ...base,
      deviceId: 'dev_bad',
      blocklists: { devices: new Set(['dev_bad']) },
      enabled: scoringOff,
    });
    expect(d.outcome).toBe('decline');
    expect(d.reasons.some((r) => r.ruleId === 'blocklist_device')).toBe(true);
    expect(d.reasons[0]?.detail).not.toContain('dev_bad');
  });

  it('reviews instead of silently allowing when a configured count signal is missing', () => {
    const noMeter = evaluateFraud({
      ...base,
      thresholds: { maxPaymentsInWindow: 3 },
      enabled: { velocity_volume: false, amount_anomaly: false },
      // recentPaymentCount omitted — must not invent
    });
    expect(noMeter.outcome).toBe('review');
    expect(noMeter.reasons).toEqual([{ ruleId: 'velocity_count', detail: 'recent payment count signal is unavailable' }]);

    const d = evaluateFraud({
      ...base,
      recentPaymentCount: 10,
      thresholds: { maxPaymentsInWindow: 3 },
      enabled: { velocity_volume: false, amount_anomaly: false },
    });
    expect(d.outcome).toBe('review');
    expect(d.reasons[0]?.ruleId).toBe('velocity_count');
  });

  it('reviews malformed configured velocity signals instead of silently allowing', () => {
    const badCount = evaluateFraud({
      ...base,
      recentPaymentCount: -1,
      thresholds: { maxPaymentsInWindow: 3 },
      enabled: { velocity_volume: false, amount_anomaly: false },
    });
    expect(badCount.outcome).toBe('review');
    expect(badCount.reasons[0]?.detail).toBe('recent payment count signal is unavailable');

    const badVolume = evaluateFraud({
      ...base,
      recentVolume: 'not-money',
      thresholds: { maxVolumeInWindow: '1000' },
      enabled: { velocity_count: false, amount_anomaly: false },
    });
    expect(badVolume.outcome).toBe('review');
    expect(badVolume.reasons[0]?.detail).toBe('recent volume signal is unavailable');
  });

  it('reviews velocity volume when meter exceeds max (decimal strings)', () => {
    const d = evaluateFraud({
      ...base,
      recentVolume: '5000',
      thresholds: { maxVolumeInWindow: '1000' },
      enabled: { velocity_count: false, amount_anomaly: false },
    });
    expect(d.outcome).toBe('review');
    expect(d.reasons[0]?.ruleId).toBe('velocity_volume');
  });

  it('reviews when a configured amount anomaly rule has no baseline', () => {
    const noBaseline = evaluateFraud({
      ...base,
      amount: '99999',
      thresholds: { amountAnomalyMultiplier: 5 },
      enabled: { velocity_count: false, velocity_volume: false },
    });
    expect(noBaseline.outcome).toBe('review');
    expect(noBaseline.reasons[0]?.detail).toBe('merchant amount baseline signal is unavailable');

    const d = evaluateFraud({
      ...base,
      amount: '600',
      baselineAmount: '100',
      thresholds: { amountAnomalyMultiplier: 5 },
      enabled: { velocity_count: false, velocity_volume: false },
    });
    expect(d.outcome).toBe('review');
    expect(d.reasons[0]?.ruleId).toBe('amount_anomaly');
  });

  it('reviews when configured blocklist evaluation is missing its signal', () => {
    const missingIp = evaluateFraud({
      ...base,
      blocklists: { ips: ['203.0.113.9'] },
      enabled: scoringOff,
    });
    expect(missingIp.outcome).toBe('review');
    expect(missingIp.reasons).toEqual([{ ruleId: 'blocklist_ip', detail: 'IP risk signal is unavailable' }]);

    const missingDevice = evaluateFraud({
      ...base,
      blocklists: { devices: ['dev_bad'] },
      enabled: scoringOff,
    });
    expect(missingDevice.outcome).toBe('review');
    expect(missingDevice.reasons).toEqual([{ ruleId: 'blocklist_device', detail: 'device risk signal is unavailable' }]);
  });

  it('kill-switch disables a rule even when signals would fire', () => {
    const d = evaluateFraud({
      ...base,
      ip: '203.0.113.9',
      blocklists: { ips: ['203.0.113.9'] },
      enabled: { ...scoringOff, blocklist_ip: false },
    });
    expect(d.outcome).toBe('allow');
    expect(d.skippedDisabled).toContain('blocklist_ip');
    expect(d.reasons).toEqual([]);
  });

  it('picks the worse outcome when multiple rules fire', () => {
    const d = evaluateFraud({
      ...base,
      ip: '203.0.113.9',
      recentPaymentCount: 99,
      blocklists: { ips: ['203.0.113.9'] },
      thresholds: { maxPaymentsInWindow: 1, velocityCountAction: 'review' },
      enabled: { velocity_volume: false, amount_anomaly: false },
    });
    expect(d.outcome).toBe('decline');
    expect(d.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('never returns decline/review with empty reasons (invariant)', () => {
    const samples: FraudDecision[] = [
      evaluateFraud(base),
      evaluateFraud({ ...base, ip: '1.1.1.1', blocklists: { ips: ['9.9.9.9'] } }),
      evaluateFraud({
        ...base,
        recentPaymentCount: 5,
        thresholds: { maxPaymentsInWindow: 1, velocityCountAction: 'decline' },
        enabled: { velocity_volume: false, amount_anomaly: false },
      }),
    ];
    for (const d of samples) {
      if (d.outcome !== 'allow') {
        expect(d.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  it('chargeback ledger recipes stay unwired from fraud module (Class X park)', () => {
    const src = readFileSync(join(here, 'evaluate.ts'), 'utf8');
    expect(src).not.toMatch(/chargebackOpen|chargebackWon|chargebackShortfall/);
    expect(src).not.toMatch(/postTransaction|PostRequest|recipes\./);
    expect(src).toMatch(/parseAmount/);
    expect(src).not.toMatch(/from '@intafaced\/ledger-client\/recipes'/);
    // Outcome posts live in chargeback-ledger.ts. This module stays free of them.
    const pay = payServiceSource();
    expect(pay).not.toMatch(/recipes\.chargeback/);
    expect(pay).toMatch(/postDisputeWon/);
    expect(pay).toMatch(/postDisputeShortfall/);
  });

  it('compares volume and amount as scaled bigint — never Number()', () => {
    const src = readFileSync(join(here, 'evaluate.ts'), 'utf8');
    expect(src).not.toMatch(/\bparseFloat\s*\(/);
    expect(src).not.toMatch(/function parseDecimal/);
    expect(src).not.toMatch(/const n = Number\(/);

    const pastSafe = evaluateFraud({
      ...base,
      amount: '9007199254740993',
      baselineAmount: '1',
      thresholds: { amountAnomalyMultiplier: 2 },
      enabled: { velocity_count: false, velocity_volume: false },
    });
    expect(pastSafe.outcome).toBe('review');
    expect(pastSafe.reasons[0]?.ruleId).toBe('amount_anomaly');

    const volumePastSafe = evaluateFraud({
      ...base,
      recentVolume: '9007199254740993',
      thresholds: { maxVolumeInWindow: '9007199254740992' },
      enabled: { velocity_count: false, amount_anomaly: false },
    });
    expect(volumePastSafe.outcome).toBe('review');
    expect(volumePastSafe.reasons[0]?.ruleId).toBe('velocity_volume');

    const exactTimes = evaluateFraud({
      ...base,
      amount: '200',
      baselineAmount: '100',
      thresholds: { amountAnomalyMultiplier: 2 },
      enabled: { velocity_count: false, velocity_volume: false },
    });
    expect(exactTimes.outcome).toBe('allow');
  });

  it('does not score protected-characteristic fields', () => {
    const src = readFileSync(join(here, 'evaluate.ts'), 'utf8');
    expect(src).not.toMatch(/\b(race|religion|gender|ethnicity|nationality)\b/i);
  });
});
