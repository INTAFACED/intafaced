/**
 * Plain-English words for typed refusals (UI-SPEC §4.3).
 *
 * Rules for every string here: money words only, no internal terms. The list of
 * banned words (UI-SPEC §4.3) is enforced by `refusals.test.ts`, which greps this
 * file. Raw codes are sorted in `refusal-codes.ts`; the customer sees the code
 * only as small support text.
 */
import { classifyRefusal, type RefusalKind } from './refusal-codes';
import type { RefusalCopy } from './types';

/** Facts a screen may know, used to fill the blanks in a message. */
export interface RefusalContext {
  asset?: string;
  /** Exact decimal string of what the user can use, already formatted for display. */
  available?: string;
  /** Who the money was meant for (a handle or name). */
  recipient?: string;
  /** Market in URL form, e.g. "BTC-USDT", for the "Use Spot" link. */
  pair?: string;
  /** Pass the Help route only when Help is live (registry); adds "Contact support". */
  helpHref?: string;
  /** A price band's edges, already formatted for display. */
  low?: string;
  high?: string;
  /** An open-order cap and how many orders are open now. */
  cap?: string;
  open?: string;
}

type Words = { title: string; body: string; action?: { label: string; href: string } };

const FIXED: Readonly<Partial<Record<RefusalKind, Words>>> = {
  screening: { title: 'Paused for account checks', body: 'Your account is paused while checks are set up.' },
  region: { title: 'Not offered where you are', body: "This action isn't offered in your region." },
  verify: {
    title: 'Verify your identity first',
    body: 'You need a verified account to do this.',
    action: { label: 'Verify now', href: '/verification' },
  },
  emailProof: {
    title: 'Confirm your email first',
    body: 'New orders wait until you confirm the email on this account. Nothing was held, and your open orders stay.',
    action: { label: 'Confirm email', href: '/uc/account' },
  },
  signInMismatch: {
    title: 'Those details did not work',
    body: 'Check what you typed and try again.',
  },
  tooManyTries: { title: 'Too many tries', body: 'New tries are paused for a while. Wait, then try again.' },
  mfaRequired: {
    title: 'Confirm it is you',
    body: 'Sign in again with your passkey or authenticator code to change this.',
    action: { label: 'Sign in again', href: '/login' },
  },
  pricesDown: { title: "Prices can't be loaded", body: "Prices can't be loaded right now. Try again in a minute." },
  slippageCapUnset: { title: 'Market orders are paused', body: 'Use a limit order instead.' },
  priceBandUnset: {
    title: 'No price band is published',
    body: 'This market takes no priced orders until it publishes the range of prices it accepts. Nothing was sent.',
  },
  openOrdersCapUnset: {
    title: 'No open-order limit is published',
    body: 'Orders that wait on the book are paused here until this market publishes how many you may have open. Nothing was sent.',
  },
  protectionUnset: {
    title: 'Price protection isn’t set',
    body: 'A market order needs a price limit it may not pass, and none is published for this market. Use a limit order instead.',
  },
  noBook: { title: 'No one is trading this market right now', body: 'Prices will show when the first orders arrive.' },
  insufficientDepth: {
    title: 'Not enough for sale right now',
    body: 'Not enough for sale right now for that amount. Try a smaller amount.',
  },
  quoteFailed: { title: "Couldn't get a price", body: "Couldn't get a price, try again." },
  marketNotOpen: { title: "This market isn't open", body: "You can't trade it right now." },
  marketHalted: {
    title: 'Trading is halted',
    body: 'An operator has paused new orders. Your open orders stay, and you can still cancel them.',
  },
  destMissing: { title: "We couldn't find that account", body: 'Check the handle and try again.' },
  signedOut: { title: 'Sign in again', body: 'Your session ended. Sign in to carry on.', action: { label: 'Sign in', href: '/login' } },
  stepUp: {
    title: 'Confirm it is you',
    body: 'Finish the extra security step, then try again.',
    action: { label: 'Open security', href: '/uc/safe' },
  },
  noPermission: { title: "You can't do this here", body: 'This account is not allowed to make this change.' },
  rateLimited: { title: 'Too many requests', body: 'Wait a moment, then try again.' },
  tryAgain: { title: 'Something went wrong on our side', body: 'Nothing was changed. Try again in a moment.' },
  orderGone: { title: 'That order has already finished', body: 'It was filled or cancelled. Check your orders for the result.' },
  priceMoved: { title: 'The price moved', body: 'Review the new price and confirm again.' },
  quoteExpired: { title: 'That price has expired', body: 'Get a fresh price and confirm again.' },
  amountInvalid: { title: 'Check the amount', body: 'Enter an amount that is more than zero and fits this market.' },
  priceInvalid: { title: 'Check the price', body: 'Enter a price that is close to the market price.' },
  belowMinimum: { title: 'Amount is too small', body: 'Enter a larger amount to continue.' },
  orderTypeUnsupported: { title: "That order type isn't offered", body: 'This market takes limit and market orders only.' },
  marketLimitOnly: {
    title: 'Market orders are paused here',
    body: 'This market is taking limit orders only right now. Place a limit order instead. Nothing was held.',
  },
  optionUnsupported: { title: "That option isn't offered", body: "This order option isn't offered on spot orders. Nothing was held." },
  requestExpired: {
    title: 'That request expired',
    body: 'Its time limit passed before it was read. Nothing was placed; review and send again.',
  },
  exitPriceOrder: {
    title: 'Check the exit prices',
    body: 'To buy with exits, the take profit must be below the stop loss, and the stop-loss limit at or above it. Nothing was held.',
  },
  exitStopLimitMissing: {
    title: 'Add a stop-loss limit price',
    body: 'A buy with exits needs a limit on its stop loss, so the funds can be held once. Nothing was held.',
  },
  exitMissing: { title: 'Add both exit prices', body: 'A take profit and a stop loss are both needed. Nothing was held.' },
  exitsNotPlaced: {
    title: 'Your buy went through, but the exits were not placed',
    body: 'Until they are placed, what you bought has no stop loss. Place the exits again; the buy will not be repeated.',
  },
  postOnlyWouldCross: {
    title: 'Post-only order not placed',
    body: 'It would have matched an order on the book right away, so it was refused. Nothing was traded.',
  },
  fokUnfillable: {
    title: 'Fill-or-kill order not placed',
    body: "The book couldn't fill the whole amount, so nothing was traded.",
  },
  ordersPaused: {
    title: 'Orders are paused right now',
    body: "Orders can't go through at the moment, and this one wasn't placed. Try again later.",
  },
  tifInvalid: { title: 'Check the order type', body: 'Post only needs a limit price. Choose a limit order, or another time in force.' },
  tagInvalid: { title: 'Check the order tag', body: 'An order tag is 1 to 16 characters. Shorten it or leave it blank. Nothing was held.' },
  expiryInvalid: { title: 'Check the expiry', body: 'The expiry time has already passed. Choose a time in the future. Nothing was held.' },
  selfTrade: { title: 'You would trade with yourself', body: 'Change the price so it does not match one of your own orders.' },
  accountOnHold: { title: 'Your account is on hold', body: 'Money cannot move right now. Contact support to find out why.' },
  platformPaused: {
    title: 'Money movement is paused for everyone',
    body: 'Money movement is paused across the platform right now. Your account is not on hold. Nothing was done.',
  },
  spaceLocked: { title: 'This space is locked', body: 'You locked this space for a time. It opens again at the time you chose.' },
  notFound: { title: "We couldn't find that", body: 'It may have been removed. Go back and try again.' },
  duplicate: { title: 'That was already sent', body: 'We saw this request a moment ago, so we kept the first one.' },
  notSetUp: { title: 'Not switched on', body: "This part of INTAFACED isn't switched on. Nothing was changed." },
  feeScheduleUnset: {
    title: 'Fee schedule not set',
    body: 'No trading fee is published for this market, so no order can be placed on it. Nothing was held.',
  },
  refundPolicyUnset: {
    title: 'The refund policy is not decided',
    body: 'No refund window is published, so a refund cannot be asked for. Your purchase is unchanged and nothing moved.',
  },
  refundWindowClosed: {
    title: 'The refund window has ended',
    body: 'This purchase is past its refund window, so it cannot be refunded. Nothing moved.',
  },
  notRefundable: {
    title: 'This purchase has no refund window',
    body: 'It was paid to the seller when you bought it, so nothing is held to give back. Nothing moved.',
  },
  alreadyHeld: {
    title: 'You already have this purchase',
    body: 'A purchase of this listing is held for you or still being recorded. Nothing was charged again.',
  },
  chartRange: { title: 'That chart range is too long', body: 'Choose a shorter range and try again.' },
  algoSchedulerOff: {
    title: 'Scheduled orders are off',
    body: 'Nothing was saved. A schedule placed now would stay open and send no orders.',
  },
  unknown: { title: "This can't be done right now", body: 'Try again later. If it keeps happening, contact support.' },
  walletPaused: {
    title: 'Withdrawal was not sent',
    body: 'A new withdrawal cannot be sent right now. Your balance is unchanged.',
  },
  walletFee: {
    title: 'Network fee is not set',
    body: 'The fee for this withdrawal is not published, so nothing was held.',
  },
  walletCap: {
    title: 'Above the remaining limit',
    body: 'That amount is above the remaining withdrawal limit. Nothing was held.',
  },
  walletFields: {
    title: 'Withdrawal was unsuccessful',
    body: 'Add the missing recipient details and submit the withdrawal again. Nothing was sent.',
  },
  walletAddress: {
    title: 'Use the saved destination',
    body: 'That address was not sent. Nothing was held.',
  },
  addressLabelTaken: { title: 'That name is taken', body: 'You already have a saved address with this name. Choose another name.' },
  addressBookFull: { title: 'Your address book is full', body: 'Remove an address to save a new one.' },
  securityLocked: {
    title: 'Your security lock is on',
    body: 'No withdrawal address can be added and nothing can be withdrawn to one until the lock ends. Nothing was changed.',
  },
  entriesDoNotSum: {
    title: 'The entries do not add up to your balance',
    body: 'Nothing is shown rather than a list that does not match. Your balance is unchanged. Try again, and contact support with the reference if it stays.',
  },
  entriesTooLong: {
    title: 'Too many entries to check at once',
    body: 'This balance has a long history. Use the activity list for this coin instead.',
  },
  noBankPartner: {
    title: 'Account details need a banking partner',
    body: 'Account numbers come from a banking partner, and none is connected in this build. No number is shown rather than a made-up one.',
  },
  detailsCurrenciesUnset: {
    title: 'Which currencies have account details has not been published',
    body: 'Which currencies have account details has not been published, so none are listed.',
  },
  eligibilityUnset: {
    title: 'Who can open an account has not been published',
    body: 'The countries, account types and product limits have not been published, so no statement is shown.',
  },
  globalOff: {
    title: 'Sending abroad is switched off',
    body: 'Sending abroad needs a payout partner and published settings, and this build has neither. Nothing was sent.',
  },
  globalNoPayout: {
    title: 'No payout partner for this destination',
    body: 'Money sent here needs a payout partner, and none is connected for this destination. Nothing was sent, and the send is kept in your history.',
  },
  globalNoRate: {
    title: 'No exchange rate is available',
    body: 'We never guess a rate, so there is no quote and nothing was sent. Try again later.',
  },
  globalPurpose: {
    title: 'Say what this payment is for',
    body: 'Sends to this currency need a purpose. Add it and send again. Nothing was sent.',
  },
  globalSource: {
    title: 'Say where this money comes from',
    body: 'A send of this size needs a source of funds. Add it and send again. Nothing was sent.',
  },
  globalReference: {
    title: 'That reference is too long',
    body: 'Shorten the reference and send again. Nothing was sent.',
  },
  globalRecipientInvalid: {
    title: 'Check the bank details',
    body: 'The account or bank code is not in a shape we can use. We only check the format, not the bank. Nothing was saved.',
  },
  globalPayoutRefused: { title: 'The payment was refused', body: 'The receiving side refused it. Nothing was taken from your balance.' },
  globalQuoteNeeded: { title: 'This send needs a locked rate', body: 'Get a quote, then confirm the send while its rate is locked.' },
  globalQuoteOther: { title: 'That quote is not for this send', body: 'Get a fresh quote for this send and confirm again.' },
  globalCorridorUnknown: {
    title: 'We do not send there',
    body: 'That country, currency and delivery method are not on the list. Choose one from the list.',
  },
  globalAmountOutside: {
    title: 'That amount does not fit this destination',
    body: 'It is below the smallest or above the largest send for this destination. Nothing was sent. Change the amount.',
  },
  globalDetailsMissing: {
    title: 'More details are needed',
    body: 'This send needs details about you or the recipient that were not included. Nothing was sent.',
  },
  globalNoSend: {
    title: 'We can’t send this payment',
    body: 'This payment can’t be sent to that recipient right now. Nothing was taken from your balance.',
  },
  globalCancelled: {
    title: 'This send was cancelled',
    body: 'It was cancelled while on hold, so it was not sent. Nothing was taken from your balance.',
  },
  globalNotCancellable: {
    title: 'This send can’t be cancelled',
    body: 'Only a send that is on hold, with nothing sent, can be cancelled.',
  },
  globalNotRecallable: {
    title: 'This send can’t be asked back',
    body: 'Only a send that has left your balance, and has not come back, can be asked back.',
  },
  receiptNotReady: { title: 'No receipt for this send', body: 'A receipt is made once the send has left your balance.' },
  receiptOff: {
    title: 'Receipts are switched off',
    body: 'Receipts can’t be signed in this build, so none is made. Your send is not affected.',
  },
  proofOff: {
    title: 'Uploads are switched off',
    body: 'The file types and size we accept have not been published, so no upload is accepted. Nothing was sent.',
  },
  proofType: { title: 'We can’t take that kind of file', body: 'Choose a file of one of the types listed under the upload box.' },
  proofSize: { title: 'That file is too big', body: 'Choose a smaller file, within the size shown under the upload box.' },
  proofInvalid: { title: 'We couldn’t read that file', body: 'Choose the file again. If it keeps failing, try another copy of it.' },
  proofNotAsked: {
    title: 'No document is needed',
    body: 'We haven’t asked for a document on this payment, so there is nothing to upload.',
  },
  proofDone: { title: 'We already have a document', body: 'A document was already uploaded for this payment and is being looked at.' },
  activitySortBounded: {
    title: 'Too many lines to sort oldest first',
    body: 'Narrow the dates, the account or the filters, then try again.',
  },
};

/** What a customer can quote to support instead of the raw service code (UI-SPEC 4.3: no internal terms on screen). */
const REFERENCE: Readonly<Partial<Record<RefusalKind, string>>> = {
  screening: 'SCR-1',
  region: 'REG-1',
  verify: 'VER-1',
  accountOnHold: 'HOLD-1',
  stepUp: 'MFA-1',
  mfaRequired: 'MFA-2',
  pricesDown: 'PRC-1',
};

function words(kind: RefusalKind, context: RefusalContext): Words {
  switch (kind) {
    case 'convertSpreadUnset':
      return {
        title: 'Instant buy is paused',
        body: "Prices for instant buys aren't set up.",
        action: { label: 'Use Spot', href: context.pair ? `/trade/spot/${context.pair}` : '/trade' },
      };
    case 'insufficient': {
      const asset = context.asset?.trim();
      const available = context.available?.trim();
      return {
        title: asset ? `Not enough ${asset}` : 'Not enough funds',
        body: asset && available ? `You have ${available} ${asset} available.` : 'Add funds or lower the amount, then try again.',
      };
    }
    case 'recipientNoAccount': {
      const who = context.recipient?.trim() || 'They';
      const asset = context.asset?.trim();
      return {
        title: asset ? `${who} can't receive ${asset}` : `${who} can't receive this`,
        body: 'Ask them to open INTAFACED once, then try again.',
      };
    }
    case 'priceBand': {
      const low = context.low?.trim();
      const high = context.high?.trim();
      return {
        title: 'Price is outside the allowed range',
        body:
          low && high
            ? `This market takes buy prices up to ${high} and sell prices down to ${low} right now. Change the price and try again.`
            : 'This market only takes prices near the middle of its book. Change the price and try again.',
      };
    }
    case 'openOrdersCap': {
      const cap = context.cap?.trim();
      const open = context.open?.trim();
      return {
        title: 'Too many open orders',
        body:
          cap && open
            ? `You have ${open} open orders here and this market allows ${cap}. Cancel one to place another.`
            : 'You have as many open orders as this market allows. Cancel one to place another.',
      };
    }
    default:
      return FIXED[kind] ?? FIXED.unknown!;
  }
}

/**
 * Words for a typed refusal code. `bank.dest_user_missing` reads as "we couldn't
 * find that account" unless the screen already resolved the recipient (pass
 * `recipient`), in which case the real cause is that they have no account in the asset.
 */
export function refusalCopy(code: string, context: RefusalContext = {}): RefusalCopy {
  let kind = classifyRefusal(code);
  if (kind === 'destMissing' && context.recipient) kind = 'recipientNoAccount';
  const result = words(kind, context);
  const reference = REFERENCE[kind];
  const withReference = reference ? { ...result, reference: `Ref ${reference}` } : result;
  if (kind === 'unknown' && context.helpHref) return { ...withReference, action: { label: 'Contact support', href: context.helpHref } };
  return withReference;
}

/** The code, trimmed for the small support line under the message. */
export function refusalSupportCode(code: string): string {
  return code.trim().slice(0, 80);
}
