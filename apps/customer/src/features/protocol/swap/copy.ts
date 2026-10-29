import { defineCopy } from '../../../shared/i18n';

/** Authored copy for the /dex swap form. English only for now. Names no wallet, router or partner brand. */
const en = {
  formTitle: 'Swap',
  formNote:
    'Swap one token for another from your own wallet on {network}. Your wallet signs and sends it; nothing passes through your exchange account.',
  mode: 'Mode',
  simple: 'Simple',
  simpleHint: 'The best route and a safe minimum are chosen for you.',
  manual: 'Manual',
  manualHint: 'You choose the route and the slippage.',
  manualTitle: 'Manual mode',
  manualBody:
    'In Manual you choose which pools the swap may use and how far the price may move before it fails. A loose setting can fill at a worse price. Simple stays available at any time.',
  manualAccept: 'I understand',
  youPay: 'You pay',
  youReceive: 'You receive',
  chooseToken: 'Choose a token',
  noTokens: 'No tokens to list: the token list comes from the pools on {network}, and the pool reader is not built in this build.',
  amountIn: 'Amount you pay',
  amountHint: 'In whole tokens, for example 25 or 0.5.',
  routeOptions: 'Route options',
  routeNeedsQuote: 'Route options open once there is a quote to compare.',
  slippage: 'Slippage (%)',
  slippageHint: 'How far the price may move before the swap fails instead of filling.',
  swap: 'Swap',
  needsWallet: 'Connect a wallet to swap.',
  needsTokens: 'Choose the token you pay and the token you receive.',
  sameToken: 'Choose two different tokens.',
  needsAmount: 'Enter an amount above zero.',
  needsQuote: 'A swap needs a quote from the pools, and the pool reader is not built in this build.',
} as const;

export const swapCopy = defineCopy('customer.protocol.swap', en);
