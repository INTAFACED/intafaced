import type { QuantCore } from './core.js';
import { QUANT_HEALTH } from '@intafaced/contracts/quant-health-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { quantRefusal } from './core.js';

export function healthRoutes(_core: QuantCore) {
  return mountRecord(QUANT_HEALTH, () => ({ ok: true as const, service: 'svc-quant' as const }), quantRefusal);
}
