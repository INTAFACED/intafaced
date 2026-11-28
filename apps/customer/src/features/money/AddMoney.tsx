import type { ApiClient } from '../../shared/api';
import { type AddMoneyMethod } from './contracts';
import { BANK_ADD_MONEY_START } from '@intafaced/contracts/bank-add-money-2-procedures';

export { TrackerSteps, walletDeliveryMessage } from './add-money/AddMoneyRoom';

/** Starts one add-money request (kept on its existing call site while the call-records codemod owns `addMoney.start`). */
export function startAddMoney(
  api: ApiClient,
  input: {
    requestId: string;
    assetId: string;
    amount: string;
    country: string;
    method: AddMoneyMethod;
    quoteId?: string;
    walletAddress?: string;
    walletSignature?: string;
  },
) {
  return api.call(BANK_ADD_MONEY_START, input);
}
