import {
  checkoutMethodsSavedSchema,
  type CheckoutMethodsPreviewInput,
  type CheckoutMethodsSaveInput,
} from '@intafaced/contracts/merchant-checkout-methods';
import type { PortalTools } from '../api-tools';
import './methods-refusals';
import {
  PAY_MERCHANT_CHECKOUT_METHODS_GET,
  PAY_MERCHANT_CHECKOUT_METHODS_PREVIEW,
} from '@intafaced/contracts/pay-merchant-checkout-methods-procedures';

// The payment methods the hosted checkout offers (J-merchant-04 step 7, M-adv-payments-core-11): svc-pay
// `merchantCheckoutMethods.*`, parsed with the service's own schemas. The business is the signed-in person's own; the
// service resolves it and checks the role. The preview is the same rule the hosted page runs.
export const methodsApi = ({ mutate, queryRecord }: PortalTools) => ({
  checkoutMethods: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CHECKOUT_METHODS_GET, {}, signal),
  saveCheckoutMethods: (input: CheckoutMethodsSaveInput) => mutate('merchantCheckoutMethods.save', input, checkoutMethodsSavedSchema),
  previewCheckoutMethods: (input: CheckoutMethodsPreviewInput, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_CHECKOUT_METHODS_PREVIEW, input, signal),
});
