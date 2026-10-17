import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
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

export interface ProtocolSpanAttributes {
  operation: string;
  chainId?: number;
  account?: string;
  sessionKey?: string;
  /** Where a signature came from: 'owner' | 'session'. Never 'platform'. */
  authority?: string;
}

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

/**
 * A span over an operation that carries a user's authority.
 *
 * `authority` is recorded because it is the question an auditor will ask of
 * this service first: on whose signature did this happen? The only two answers
 * this service can produce are "the owner" and "a session key the owner
 * granted".
 */
export async function withAuthoritySpan<T>(name: string, attributes: ProtocolSpanAttributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttribute('intafaced.module', 'protocol');
    span.setAttribute('intafaced.plane', 'protocol');
    span.setAttribute('intafaced.custodial', false);
    span.setAttribute('intafaced.operation', attributes.operation);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'operation' || value === undefined) continue;
      span.setAttribute(`intafaced.${key}`, value);
    }

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const safe = redactUrlsInText(err instanceof Error ? err.message : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: safe });
      const recorded = new Error(safe);
      recorded.name = err instanceof Error ? err.name : 'Error';
      span.recordException(recorded);
      if (err instanceof Error) {
        span.setAttribute('intafaced.error_code', (err as { code?: string }).code ?? err.name);
      }
      throw err;
    } finally {
      span.end();
    }
  });
}
