import 'server-only';
import { opsVenueEconomicsSchema, type OpsVenueEconomics } from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';

export interface VenueEconomicsRead {
  readonly asOf: string;
  readonly period: string;
  readonly part: Part<OpsVenueEconomics>;
}

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'ops.cost_storage_unconfigured': 'svc-ops has no durable storage for cost entries on this deployment, so nothing can be read or saved.',
  'ops.cost_period_invalid': 'That month is not one svc-ops accepts. Use a month like 2026-10.',
};

/** The month's report from svc-ops as the signed-in founder. A failed read says why and shows no figures. */
export async function readVenueEconomics(ctx: FounderCallContext, period: string): Promise<VenueEconomicsRead> {
  const result = await founderCall(ctx, 'ops', 'venueEconomics', 'GET', { period }, parseWith(opsVenueEconomicsSchema));
  return {
    asOf: new Date().toISOString(),
    period,
    part: partFrom(result, (d) => d, {
      service: 'svc-ops',
      forbiddenMessage:
        'svc-ops did not accept this founder session for the venue report. It needs the operations read permission (ops:read).',
      refusedMessage: (code) => (code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null),
    }),
  };
}
