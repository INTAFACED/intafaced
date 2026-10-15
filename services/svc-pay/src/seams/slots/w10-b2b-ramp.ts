import type { Sql } from 'postgres';
import type { PartialPayGuards } from '../guards.js';

/**
 * Guard slot for W10 switched-off B2B ramp.
 *
 * Owned by that workstream alone: implement the hooks it needs here, built from
 * code under `services/svc-pay/src/b2b-ramp/**`. Until then it contributes nothing, so today's behaviour is
 * unchanged. A hook refuses by throwing a typed error; see seams/guards.ts.
 */
export function createW10B2bRampGuards(_deps: { sql: Sql }): PartialPayGuards {
  return {};
}
