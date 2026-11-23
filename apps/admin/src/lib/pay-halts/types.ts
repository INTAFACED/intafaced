import type { PayHaltEvent, PayHaltOperatorStatus, PayHaltPendingClear } from '@intafaced/contracts';

export type { Part } from '@/lib/desk';
import type { Part } from '@/lib/desk';

export interface PayHaltsRead {
  /** When the console server read svc-pay. Every figure below is as of this time. */
  readonly asOf: string;
  readonly status: Part<PayHaltOperatorStatus>;
  readonly pending: Part<{ readonly proposals: readonly PayHaltPendingClear[]; readonly nextCursor: string | null }>;
  readonly history: Part<readonly PayHaltEvent[]>;
}
