import { defineCopy } from '../../shared/i18n';

/**
 * Copy for buying a paid course's certificate track from your own wallet (J-academy-07, AC-commerce-01). It names no
 * partner or vendor, says what INTAFACED holds (none of the buyer's money), and states blockers as present facts.
 */
export const academyPurchaseCopy = defineCopy('academy-purchase', {
  title: 'Buy the certificate track',
  price: 'Price: {price} {asset}',
  tracksDifference:
    'The free track costs nothing and needs no payment. The certificate track is the paid track: it opens once your payment is confirmed and recorded.',
  noPrice: 'Price not set: this paid track cannot be bought until staff set a price.',
  paymentsOff: 'Course payments are switched off, so this track cannot be bought.',
  custody: 'You pay from your own wallet straight to INTAFACED. INTAFACED never holds your money for you.',
  walletTitle: 'Pay from your wallet',
  needsWallet: 'Connect your wallet in Wallet to pay from it.',
  openWallet: 'Open Wallet',
  wrongNetwork: 'Your wallet is on another network. Switch it to the network this payment is on.',
  walletAddress: 'Paying from {address}',
  buy: 'Buy',
  buying: 'Asking your wallet…',
  buyAgain: 'Buy again',
  cardTitle: 'Pay by card',
  card: 'Pay by card',
  cardOff: 'Card payment needs a card partner. It is switched off in this build.',
  signatureAsked: 'Your wallet has already been asked to sign this payment, so it is not asked again. Approve or reject it in your wallet.',
  cancel: 'I rejected it in my wallet',
  rejected: 'Your wallet rejected the payment, so nothing was bought.',
  walletFailed: 'Your wallet did not send the payment: {message}',
  submitted: 'Payment sent. The network is confirming it. Your access is granted when the payment is confirmed and recorded.',
  confirmed: 'Payment confirmed. It is being recorded. Your access is granted when the record is written.',
  recordPending: 'Payment confirmed. Its record is being written again automatically; nothing is paid twice.',
  posted: 'Bought. Your access to the certificate track is granted.',
  refunding: 'A refund of {amount} {asset} to your wallet is under way.',
  refunded: 'Refunded: {amount} {asset} was sent back to your wallet. Your access has ended.',
  refundReason: 'Reason: {reason}',
  failed: 'That payment did not count, so nothing was bought: {reason}.',
  failurePaymentReverted: 'the transaction failed on the network',
  failurePaymentMismatch: 'it did not pay this price to INTAFACED',
  transaction: 'Transaction',
  refundTransaction: 'Refund transaction',
  purchaseKey: 'Purchase {key}',
  reading: 'Reading your purchase…',
});
