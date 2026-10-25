import {
  checkoutMethodOfferSchema,
  checkoutMethodsSavedSchema,
  checkoutMethodsSchema,
  type CheckoutMethodsPreviewInput,
  type CheckoutMethodsSaveInput,
} from '@intafaced/contracts/merchant-checkout-methods';
import type { PortalTools } from '../api-tools';
import './methods-refusals';

// The payment methods the hosted checkout offers (J-merchant-04 step 7, M-adv-payments-core-11): svc-pay
// `merchantCheckoutMethods.*`, parsed with the service's own schemas. The business is the signed-in person's own; the
// service resolves it and checks the role. The preview is the same rule the hosted page runs.
export const methodsApi = ({ query, mutate }: PortalTools) => ({
  checkoutMethods: (signal?: AbortSignal) => query('merchantCheckoutMethods.get', {}, checkoutMethodsSchema, signal),
  saveCheckoutMethods: (input: CheckoutMethodsSaveInput) => mutate('merchantCheckoutMethods.save', input, checkoutMethodsSavedSchema),
  previewCheckoutMethods: (input: CheckoutMethodsPreviewInput, signal?: AbortSignal) =>
    query('merchantCheckoutMethods.preview', input, checkoutMethodOfferSchema, signal),
});
