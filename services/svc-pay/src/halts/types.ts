import type { z } from 'zod';
import type {
  PayHaltEvent,
  PayHaltOperatorStatus,
  PayHaltScope,
  PayHaltSetInput,
  PayHaltState,
  PayHaltStatus,
  PayHaltTarget,
  payHaltMerchantStateSchema,
  payHaltSetResultSchema,
} from '@intafaced/contracts';

export { PAY_HALT_SCOPES } from '@intafaced/contracts/pay-halts';
export type { PayHaltEvent, PayHaltOperatorStatus, PayHaltScope, PayHaltSetInput, PayHaltState, PayHaltStatus, PayHaltTarget };
export type PayHaltMerchantState = z.infer<typeof payHaltMerchantStateSchema>;
export type PayHaltSetResult = z.infer<typeof payHaltSetResultSchema>;
