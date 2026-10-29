import { PayClient, type PayClientOptions } from './client.js';
import { bindOperations, type PayOperations } from './operations.js';

export {
  PayClient,
  DEFAULT_MAX_RETRIES,
  type PayCall,
  type PayCallInput,
  type PayClientOptions,
  type PayResponse,
  type PayTransport,
} from './client.js';
export {
  REQUEST_NONCE_HEADER,
  REQUEST_SIGNATURE_HEADER,
  REQUEST_SIGN_VERSION,
  REQUEST_TIMESTAMP_HEADER,
  canonicalRequest,
  hashBody,
  newRequestNonce,
  signPayRequest,
  signRequest,
  signaturesEqual,
  type SignedPayRequest,
} from './sign.js';
export { bindOperations, type PayOperations } from './operations.js';
export {
  paymentPageFromResponse,
  parsePaymentPage,
  type PayFailure,
  type PayPayment,
  type PayPaymentPage,
  type PayPaymentStatus,
} from './payments-page.js';
export { paymentLinkPageFromResponse, parsePaymentLinkPage, type PayPaymentLink, type PayPaymentLinkPage } from './payment-links-page.js';

export function createPayClient(options: PayClientOptions): PayClient & PayOperations {
  const client = new PayClient(options);
  return Object.assign(client, bindOperations(client));
}
