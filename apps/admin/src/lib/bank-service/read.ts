import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { parseDirectDebits, parseRampMetrics, type DirectDebitsReport, type RampMetrics } from './model';

export interface ServiceDesk {
  readonly asOf: string;
  /** null inside `ok`: no ramp partner is wired, so there is no data (never zero orders). */
  readonly ramps: Part<RampMetrics | null>;
  /** null inside `ok`: no partner answers for direct debits, so there is no data. */
  readonly directDebits: Part<DirectDebitsReport | null>;
}

const labels = {
  service: 'svc-bank',
  forbiddenMessage: 'svc-bank did not accept this founder session for bank service reads. It needs the operator permission admin:read.',
} as const;

/** Both parts are read on their own, so a refused ramp read never hides the direct debits, and the other way round. */
export async function readServiceDesk(ctx: FounderCallContext): Promise<ServiceDesk> {
  const [ramps, directDebits] = await Promise.all([
    founderCall(ctx, 'bank', 'ops.rampMetrics', 'GET', undefined, parseRampMetrics),
    founderCall(ctx, 'bank', 'ops.directDebitMandates', 'GET', undefined, parseDirectDebits),
  ]);
  return {
    asOf: new Date().toISOString(),
    ramps: partFrom(ramps, (d) => d.partner, labels),
    directDebits: partFrom(directDebits, (d) => d.partner, labels),
  };
}
