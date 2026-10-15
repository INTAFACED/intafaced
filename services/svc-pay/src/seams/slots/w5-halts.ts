import type { Sql } from 'postgres';
import type { PartialPayGuards } from '../guards.js';

/**
 * Guard slot for W5 granular halts and treasury exposure.
 *
 * Owned by that workstream alone: implement the hooks it needs here, built from
 * code under `services/svc-pay/src/halts/**`. Until then it contributes nothing, so today's behaviour is
 * unchanged. A hook refuses by throwing a typed error; see seams/guards.ts.
 */
export function createW5HaltsGuards(_deps: { sql: Sql }): PartialPayGuards {
  return {};
}
