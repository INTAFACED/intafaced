import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

/**
 * Tracing (§9, §14 DoD).
 *
 * svc-blueprint moves no value, so nothing here is tagged
 * `intafaced.money_path` — that flag exists to make the collector's tail
 * sampler keep money traces at 100%, and marking a non-money service with it
 * would dilute exactly the signal it protects.
 *
 * What this service traces instead is the **onboarding budget**. §7.2's exit
 * criterion is a number — "signup → session → reveal → crew placement < 3
 * minutes" — and a number in a spec that nothing measures is a wish. Every span
 * here carries `intafaced.stage`, so the p95 of each stage is a dashboard panel
 * and a regression in the engine call is visible before it is a missed target.
 *
 * ── The rule that matters more than any of that ─────────────────────────────
 * **No profile content ever reaches a span.** Not an axis, not a guardrail, not
 * a curriculum path, and above all not a session response or birth data. A span
 * attribute is exported to a collector, retained, and searchable — which makes
 * it a copy of the data outside the isolation §10 requires. `BlueprintSpanAttributes`
 * is a closed type for that reason: adding a field to it is a deliberate act,
 * visible in a diff, and not something a caller can do by passing an extra key.
 */
const tracer = trace.getTracer('svc-blueprint');

export type OnboardingStage = 'session' | 'engine' | 'persist' | 'match' | 'mentors' | 'card' | 'visibility' | 'export' | 'erase' | 'share';

/**
 * The ONLY attributes this service puts on a span.
 *
 * Every field is an id, a count, a duration or an enum. None of them is derived
 * from what a user said. If a future change needs something else on a span,
 * that is a decision to make here, in the open.
 */
export interface BlueprintSpanAttributes {
  stage: OnboardingStage;
  /** Ids are fine: they are references, not content. */
  userId?: string;
  blueprintId?: string;
  crewId?: string;
  /** Engine build — an operational fact, not a personal one. */
  engineVersion?: string;
  /** Placement score in basis points. An integer about a crew, not about a person. */
  score?: number;
  candidateCount?: number;
  latencyMs?: number;
  /**
   * Whether the card rasterizer produced an asset. An operational fact about a
   * rail — it says nothing about the person, only whether an external renderer
   * answered.
   */
  cardRaster?: 'rendered' | 'unavailable';
}

/**
 * Set one attribute from the closed set AFTER the span has started.
 *
 * Some facts are only known once the work is done, and the raster status is the
 * first of them. This exists rather than a bare `span.setAttribute` because the
 * closed type above is only a guarantee if there is no second way onto a span:
 * a raw call takes any string, so it would put an attribute on the wire that
 * never appears in `BlueprintSpanAttributes` and therefore never appears in the
 * review this file describes.
 */
export function setBlueprintSpanAttribute<K extends keyof BlueprintSpanAttributes>(
  span: Span,
  key: K,
  value: NonNullable<BlueprintSpanAttributes[K]>,
): void {
  span.setAttribute(`intafaced.${key}`, value as string | number);
}

export async function withBlueprintSpan<T>(name: string, attributes: BlueprintSpanAttributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttribute('intafaced.module', 'blueprint');
    span.setAttribute('intafaced.stage', attributes.stage);

    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'stage' || value === undefined) continue;
      span.setAttribute(`intafaced.${key}`, value as string | number);
    }

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : 'failed' });
      if (err instanceof Error) {
        span.recordException(err);
        // What an SLO dashboard groups by: `blueprint.engine_unavailable` is an
        // upstream alarm, `blueprint.crew_full` is a user hitting a rule.
        span.setAttribute('intafaced.error_code', (err as { code?: string }).code ?? err.name);
      }
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
