import type { Sql } from 'postgres';
import type { PartialPayGuards } from '../guards.js';

/**
 * Guard slot for W1 merchant control room (caps, tiers, pricing, maker-checker).
 *
 * Owned by that workstream alone: implement the hooks it needs here, built from
 * code under `services/svc-pay/src/control/**`. Until then it contributes nothing, so today's behaviour is
 * unchanged. A hook refuses by throwing a typed error; see seams/guards.ts.
 */
export function createW1ControlGuards(_deps: { sql: Sql }): PartialPayGuards {
  return {};
}
