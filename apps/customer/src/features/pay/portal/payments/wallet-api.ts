import {
  outsideFundsSchema,
  receivingWalletSavedSchema,
  receivingWalletSchema,
  type ReceivingWalletSaveInput,
} from '@intafaced/contracts/merchant-receiving-wallet';
import type { PortalTools } from '../api-tools';
import './wallet-refusals';

// The business's own receiving wallet and the money it holds outside our book (J-merchant-04, launch money model):
// svc-pay `merchantReceivingWallet.*`, parsed with the service's own schemas. The business is the signed-in person's own;
// the service resolves it and checks the role.
export const walletApi = ({ query, mutate }: PortalTools) => ({
  receivingWallet: (signal?: AbortSignal) => query('merchantReceivingWallet.get', {}, receivingWalletSchema, signal),
  saveReceivingWallet: (input: ReceivingWalletSaveInput) => mutate('merchantReceivingWallet.save', input, receivingWalletSavedSchema),
  outsideFunds: (signal?: AbortSignal) => query('merchantReceivingWallet.outsideFunds', {}, outsideFundsSchema, signal),
});
