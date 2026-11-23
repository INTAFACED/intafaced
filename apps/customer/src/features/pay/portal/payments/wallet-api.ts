import { type ReceivingWalletSaveInput } from '@intafaced/contracts/merchant-receiving-wallet';
import type { PortalTools } from '../api-tools';
import './wallet-refusals';
import {
  PAY_MERCHANT_RECEIVING_WALLET_GET,
  PAY_MERCHANT_RECEIVING_WALLET_OUTSIDE_FUNDS,
  PAY_MERCHANT_RECEIVING_WALLET_SAVE,
} from '@intafaced/contracts/pay-merchant-receiving-wallet-procedures';

// The business's own receiving wallet and the money it holds outside our book (J-merchant-04, launch money model):
// svc-pay `merchantReceivingWallet.*`, parsed with the service's own schemas. The business is the signed-in person's own;
// the service resolves it and checks the role.
export const walletApi = ({ queryRecord, mutateRecord }: PortalTools) => ({
  receivingWallet: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_RECEIVING_WALLET_GET, {}, signal),
  saveReceivingWallet: (input: ReceivingWalletSaveInput) => mutateRecord(PAY_MERCHANT_RECEIVING_WALLET_SAVE, input),
  outsideFunds: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_RECEIVING_WALLET_OUTSIDE_FUNDS, {}, signal),
});
