import type { Sql } from 'postgres';
import type { PayScreeningService } from '../screening/service.js';
import { composeGuards, type PayGuards } from './guards.js';
import { createW1ControlGuards } from './slots/w1-control.js';
import { createW5HaltsGuards } from './slots/w5-halts.js';
import { createW6ConversionGuards } from './slots/w6-conversion.js';
import { createW9ScreeningGuards } from './slots/w9-screening.js';
import { createW10B2bRampGuards } from './slots/w10-b2b-ramp.js';

/**
 * The one place the guard slots are composed (W0 owns this file; streams edit
 * only their own slot file).
 *
 * ORDER IS A SAFETY DECISION. Halts run first (cheapest refusal, nothing else
 * should be consulted while a scope is stopped), then screening, then the
 * per-merchant control room (caps take row locks, so they come last and hold
 * them for the shortest time), then the conversion and B2B-ramp slots, which
 * only matter on their own paths.
 */
export function buildPayGuards(deps: { sql: Sql; screening?: PayScreeningService }): PayGuards {
  return composeGuards(
    createW5HaltsGuards(deps),
    createW9ScreeningGuards(deps),
    createW1ControlGuards(deps),
    createW6ConversionGuards(deps),
    createW10B2bRampGuards(deps),
  );
}
