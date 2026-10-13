import { describe, expect, it } from 'vitest';
import { DEGRADED_REFUSES_NEW_RISK, SLO_OWNER_UNSET, SPLIT_BRAIN_MONEY, handleResilience } from './resilience-gate.js';
import { handleS2sResilience } from '../s2s-http.js';
import type { LedgerService } from '../service.js';

const stub = {} as LedgerService;

describe('CARD G-resilience degraded risk, split-brain, OWNER SLO', () => {
  it('refuses new risk when a dependency is degraded or down', () => {
    const degraded = handleResilience({
      kind: 'risk',
      dependency: 'postgres',
      dependencyStatus: 'degraded',
      acceptNewRisk: true,
      observedCount: '2',
      observedLatencyMs: '40',
    });
    const down = handleResilience({
      kind: 'risk',
      dependency: 'postgres',
      dependencyStatus: 'down',
      acceptNewRisk: true,
    });
    expect(degraded.ok).toBe(false);
    expect(down.ok).toBe(false);
    if (degraded.ok || down.ok) return;
    expect(degraded.reason).toBe(DEGRADED_REFUSES_NEW_RISK);
    expect(degraded.posted).toBe(false);
    expect(degraded.metrics.observedCount).toBe('2');
    expect(degraded.metrics.observedLatencyMs).toBe('40');
    expect(down.reason).toBe(DEGRADED_REFUSES_NEW_RISK);
  });

  it('makes split-brain money impossible for two writers or two sources of truth', () => {
    const writers = handleResilience({
      kind: 'split_brain',
      writers: ['ledger-a', 'ledger-b'],
      observedCount: '1',
    });
    const truths = handleResilience({
      kind: 'split_brain',
      sourcesOfTruth: ['book', 'sidecar'],
    });
    const flagged = handleResilience({
      kind: 'risk',
      splitBrain: true,
      dependencyStatus: 'ok',
    });
    expect(writers.ok).toBe(false);
    expect(truths.ok).toBe(false);
    expect(flagged.ok).toBe(false);
    if (writers.ok || truths.ok || flagged.ok) return;
    expect(writers.reason).toBe(SPLIT_BRAIN_MONEY);
    expect(truths.reason).toBe(SPLIT_BRAIN_MONEY);
    expect(flagged.reason).toBe(SPLIT_BRAIN_MONEY);
    expect(writers.posted).toBe(false);
  });

  it('refuses an invented SLO and still emits raw metrics', () => {
    const out = handleResilience({
      kind: 'slo',
      observedCount: '4',
      observedLatencyMs: '9',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(SLO_OWNER_UNSET);
    expect(out.metrics).toEqual({ observedCount: '4', observedLatencyMs: '9' });
    expect(JSON.stringify(out)).not.toMatch(/"sloTarget|"p99"|"sloMs"/);
  });

  it('refuses a JS number as an SLO target', () => {
    expect(() =>
      handleResilience({
        kind: 'slo',
        ownerSloSet: true,
        sloTargetMs: 200,
      }),
    ).toThrow();
  });

  it('accepts new risk only when the dependency is ok — never posts from this door', () => {
    const out = handleResilience({
      kind: 'risk',
      dependency: 'postgres',
      dependencyStatus: 'ok',
      acceptNewRisk: true,
      writers: ['ledger'],
      sourcesOfTruth: ['book'],
      observedCount: '3',
      observedLatencyMs: '12',
    });
    expect(out).toEqual({
      ok: true,
      kind: 'risk',
      posted: false,
      acceptedNewRisk: true,
      metrics: { observedCount: '3', observedLatencyMs: '12' },
    });
    expect(out).not.toHaveProperty('sloTargetMs');
  });

  it('serves the degraded refuse through the S2S handle', async () => {
    const out = await handleS2sResilience(stub, {
      kind: 'risk',
      dependency: 'postgres',
      dependencyStatus: 'down',
      acceptNewRisk: true,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(DEGRADED_REFUSES_NEW_RISK);
    expect(out.posted).toBe(false);
  });
});
