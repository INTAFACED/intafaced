import 'server-only';
import { type FounderCallContext, partFrom, type Part, founderRecordRead } from '@/lib/desk';
import { parseDirectDebits, parseRampMetrics, type DirectDebitsReport, type RampMetrics } from './model';
import { BANK_OPS_RAMP_METRICS, BANK_OPS_DIRECT_DEBIT_MANDATES } from '@intafaced/contracts/bank-ops-procedures';

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
    founderRecordRead(ctx, BANK_OPS_RAMP_METRICS, undefined, parseRampMetrics),
    founderRecordRead(ctx, BANK_OPS_DIRECT_DEBIT_MANDATES, undefined, parseDirectDebits),
  ]);
  return {
    asOf: new Date().toISOString(),
    ramps: partFrom(ramps, (d) => d.partner, labels),
    directDebits: partFrom(directDebits, (d) => d.partner, labels),
  };
}
