/**
 * G-resilience (PTX-M18-R02, PTX-M18-R04, PTX-M18-R05).
 * Degraded dependency refuses new risk. Split-brain money is impossible.
 * SLO numbers are OWNER — still emit raw metrics. Do not invent an SLO.
 * svc-matching and svc-trade are not recut. metrics.ts scrape mill is not.
 */

import { z } from 'zod';

export const RESILIENCE_KINDS = ['risk', 'split_brain', 'slo'] as const;
export type ResilienceKind = (typeof RESILIENCE_KINDS)[number];

export const DEGRADED_REFUSES_NEW_RISK = 'ledger.resilience.degraded_refuses_new_risk' as const;
export const SPLIT_BRAIN_MONEY = 'ledger.resilience.split_brain_money' as const;
export const SLO_OWNER_UNSET = 'ledger.resilience.slo_owner_unset' as const;

export type ResilienceRefuseReason = typeof DEGRADED_REFUSES_NEW_RISK | typeof SPLIT_BRAIN_MONEY | typeof SLO_OWNER_UNSET;

export type ResilienceRefusal = {
  readonly ok: false;
  readonly reason: ResilienceRefuseReason;
  readonly kind: ResilienceKind;
  readonly posted: false;
  readonly detail: string;
  readonly metrics: ResilienceMetrics;
};

export type ResilienceMetrics = {
  readonly observedCount: string;
  readonly observedLatencyMs: string | null;
};

export type ResilienceOk = {
  readonly ok: true;
  readonly kind: ResilienceKind;
  readonly posted: false;
  readonly acceptedNewRisk: boolean;
  readonly metrics: ResilienceMetrics;
};

export type ResilienceResult = ResilienceOk | ResilienceRefusal;

export const resilienceInputSchema = z.object({
  kind: z.enum(RESILIENCE_KINDS),
  dependency: z.string().optional(),
  dependencyStatus: z.enum(['ok', 'degraded', 'down']).optional(),
  acceptNewRisk: z.boolean().optional(),
  writers: z.array(z.string()).optional(),
  sourcesOfTruth: z.array(z.string()).optional(),
  splitBrain: z.boolean().optional(),
  ownerSloSet: z.boolean().optional(),
  sloTargetMs: z.string().optional(),
  observedLatencyMs: z.string().optional(),
  observedCount: z.string().optional(),
});

function text(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

function metricsOf(input: z.infer<typeof resilienceInputSchema>): ResilienceMetrics {
  return {
    observedCount: text(input.observedCount) ?? '0',
    observedLatencyMs: text(input.observedLatencyMs),
  };
}

function namedSet(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter((v) => v.length > 0))];
}

function refuse(kind: ResilienceKind, reason: ResilienceRefuseReason, detail: string, metrics: ResilienceMetrics): ResilienceRefusal {
  return { ok: false, reason, kind, posted: false, detail, metrics };
}

export function refuseResilienceRisk(input: z.infer<typeof resilienceInputSchema>): ResilienceResult {
  const metrics = metricsOf(input);
  const writers = namedSet(input.writers);
  const truths = namedSet(input.sourcesOfTruth);

  if (input.splitBrain === true || writers.length > 1 || truths.length > 1) {
    return refuse(input.kind, SPLIT_BRAIN_MONEY, 'split-brain money is impossible — one writer, one book', metrics);
  }

  if (input.kind === 'slo' && (input.ownerSloSet !== true || text(input.sloTargetMs))) {
    if (input.ownerSloSet !== true) {
      return refuse(input.kind, SLO_OWNER_UNSET, 'SLO numbers are OWNER — raw metrics still emit', metrics);
    }
  }

  if (input.kind === 'slo' && input.ownerSloSet !== true) {
    return refuse(input.kind, SLO_OWNER_UNSET, 'SLO numbers are OWNER — raw metrics still emit', metrics);
  }

  const degraded =
    input.dependencyStatus === 'degraded' ||
    input.dependencyStatus === 'down' ||
    (input.kind === 'risk' && input.dependencyStatus !== 'ok' && input.acceptNewRisk === true);

  if (degraded && input.acceptNewRisk !== false) {
    return refuse(
      input.kind === 'slo' ? 'risk' : input.kind,
      DEGRADED_REFUSES_NEW_RISK,
      `degraded ${text(input.dependency) ?? 'dependency'} refuses new risk`,
      metrics,
    );
  }

  if (input.kind === 'risk' && input.dependencyStatus !== 'ok' && input.acceptNewRisk === true) {
    return refuse('risk', DEGRADED_REFUSES_NEW_RISK, 'degraded dependency refuses new risk', metrics);
  }

  return {
    ok: true,
    kind: input.kind,
    posted: false,
    acceptedNewRisk: input.acceptNewRisk === true && input.dependencyStatus === 'ok',
    metrics,
  };
}

export function handleResilience(body: unknown): ResilienceResult {
  return refuseResilienceRisk(resilienceInputSchema.parse(body));
}
