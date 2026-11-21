/**
 * Customer-truth for matching halt / venue incident on notify.
 *
 * `ok: true` on the process probe is liveness, not "all markets are fine".
 * `allFine` is the venue claim — false on halt-all, one-market halt, missing
 * halt source, or incident-silence without an explicit all-clear.
 *
 * All-clear never overrides a halt or an unavailable source (do not invent
 * recovered). Incident-silence never auto-unmutes matching-open as success.
 */

import { z } from 'zod';
import type { MatchingVenueLoad } from './matching-venue-incident.js';
import { VENUE_INCIDENT_CODES, venueIncidentOutput } from '@intafaced/contracts/notify-call-schemas';

export type VenueIncidentCode = (typeof VENUE_INCIDENT_CODES)[number];

export type VenueIncidentTruth = z.infer<typeof venueIncidentOutput>;

export const UNWIRED_VENUE_INCIDENT: VenueIncidentTruth = {
  allFine: false,
  matching: 'unwired',
  code: null,
  incidentSilence: false,
  allClear: false,
};

export interface PresentVenueIncidentInput {
  readonly load: MatchingVenueLoad;
  readonly incidentSilence: boolean;
  readonly allClear: boolean;
}

function truth(
  partial: Omit<VenueIncidentTruth, 'incidentSilence' | 'allClear'>,
  flags: { readonly incidentSilence: boolean; readonly allClear: boolean },
): VenueIncidentTruth {
  return { ...partial, incidentSilence: flags.incidentSilence, allClear: flags.allClear };
}

/**
 * Present matching + silence flags as the customer-visible venue claim.
 *
 * Halt / unavailable always win over all-clear. Silence without all-clear
 * blocks `allFine` even when matching looks open.
 */
export function presentVenueIncident(input: PresentVenueIncidentInput): VenueIncidentTruth {
  const flags = { incidentSilence: input.incidentSilence, allClear: input.allClear };
  const load = input.load;

  if (load.kind === 'unavailable') {
    return truth(
      {
        allFine: false,
        matching: 'unavailable',
        code: input.allClear ? 'notify.incident_all_clear_refused' : 'notify.venue_halt_unavailable',
      },
      flags,
    );
  }

  if (load.kind === 'board') {
    if (load.board.venueHalted) {
      return truth(
        {
          allFine: false,
          matching: 'halted',
          code: input.allClear ? 'notify.incident_all_clear_refused' : 'notify.venue_halted',
        },
        flags,
      );
    }
    if (load.board.haltedMarkets.length > 0) {
      return truth(
        {
          allFine: false,
          matching: 'halted',
          code: input.allClear ? 'notify.incident_all_clear_refused' : 'notify.market_halted',
        },
        flags,
      );
    }
    if (input.incidentSilence && !input.allClear) {
      return truth({ allFine: false, matching: 'open', code: 'notify.incident_silence' }, flags);
    }
    return truth({ allFine: true, matching: 'open', code: null }, flags);
  }

  // unwired — do not invent halt or all-clear
  if (input.allClear) {
    return truth({ allFine: false, matching: 'unwired', code: 'notify.incident_all_clear_refused' }, flags);
  }
  if (input.incidentSilence) {
    return truth({ allFine: false, matching: 'unwired', code: 'notify.incident_silence' }, flags);
  }
  return truth({ allFine: false, matching: 'unwired', code: null }, flags);
}

export type VenueIncidentLoader = () => Promise<VenueIncidentTruth> | VenueIncidentTruth;

export async function resolveVenueIncident(loader: VenueIncidentLoader | undefined): Promise<VenueIncidentTruth> {
  if (!loader) return UNWIRED_VENUE_INCIDENT;
  return loader();
}
