import type { PayHaltEvent, PayHaltOperatorStatus, PayHaltPendingClear } from '@intafaced/contracts';

export type { Part } from '@/lib/desk/part';
import type { Part } from '@/lib/desk/part';

export interface PayHaltsRead {
  /** When the console server read svc-pay. Every figure below is as of this time. */
  readonly asOf: string;
  readonly status: Part<PayHaltOperatorStatus>;
  readonly pending: Part<{ readonly proposals: readonly PayHaltPendingClear[]; readonly nextCursor: string | null }>;
  readonly history: Part<readonly PayHaltEvent[]>;
}
