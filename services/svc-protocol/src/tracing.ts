import { trace, SpanStatusCode } from '@opentelemetry/api';
import { redactUrlsInText } from './chain/availability.js';

/**
 * Tracing (§9, §14 DoD).
 *
 * There is no `withMoneySpan` in this service, and that absence is the point:
 * `intafaced.money_path` marks spans that lead to a ledger post, and nothing
 * here ever does. What this service traces instead is the custody boundary —
 * every span carries `intafaced.custodial=false`, so a trace search for
 * custodial activity on the Protocol Plane returns nothing, verifiably, rather
 * than by assertion in a README.
 */
const tracer = trace.getTracer('svc-protocol');

export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttribute('intafaced.module', 'protocol');
    span.setAttribute('intafaced.plane', 'protocol');
    span.setAttribute('intafaced.custodial', false);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const safe = redactUrlsInText(err instanceof Error ? err.message : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: safe });
      const recorded = new Error(safe);
      recorded.name = err instanceof Error ? err.name : 'Error';
      span.recordException(recorded);
      throw err;
    } finally {
      span.end();
    }
  });
}
