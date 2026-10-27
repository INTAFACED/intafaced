import {
  checkoutBrandingSavedSchema,
  checkoutBrandingSchema,
  type CheckoutBrandingSaveInput,
} from '@intafaced/contracts/merchant-checkout-branding';
import type { PortalTools } from '../api-tools';
import './look-refusals';

// The look of the hosted checkout (J-merchant-04 step 1, M-payments-core-08): svc-pay `merchantCheckout.branding.*`,
// parsed with the service's own schemas. The business is the signed-in person's own; the service resolves it and checks
// the role.
export const lookApi = ({ query, mutate }: PortalTools) => ({
  checkoutLook: (signal?: AbortSignal) => query('merchantCheckout.branding.get', {}, checkoutBrandingSchema, signal),
  /** The brand colour as typed (the service keeps it in lower case); a logo left out keeps the saved one, null takes it off. */
  saveCheckoutLook: (input: Omit<CheckoutBrandingSaveInput, 'brandColor'> & { brandColor: string }) =>
    mutate('merchantCheckout.branding.save', input, checkoutBrandingSavedSchema),
});
