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
  mfaRequired: {
    title: 'Confirm it is you',
    body: 'Sign in again with your passkey or authenticator code to change this.',
    action: { label: 'Sign in again', href: '/login' },
  },
  pricesDown: { title: "Prices can't be loaded", body: "Prices can't be loaded right now. Try again in a minute." },
  slippageCapUnset: { title: 'Market orders are paused', body: 'Use a limit order instead.' },
  noBook: { title: 'No one is trading this market right now', body: 'Prices will show when the first orders arrive.' },
  insufficientDepth: {
    title: 'Not enough for sale right now',
    body: 'Not enough for sale right now for that amount. Try a smaller amount.',
  },
  quoteFailed: { title: "Couldn't get a price", body: "Couldn't get a price, try again." },
  marketNotOpen: { title: "This market isn't open", body: "You can't trade it right now." },
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
  selfTrade: { title: 'You would trade with yourself', body: 'Change the price so it does not match one of your own orders.' },
  accountOnHold: { title: 'Your account is on hold', body: 'Money cannot move right now. Contact support to find out why.' },
  notFound: { title: "We couldn't find that", body: 'It may have been removed. Go back and try again.' },
  duplicate: { title: 'That was already sent', body: 'We saw this request a moment ago, so we kept the first one.' },
  notSetUp: { title: 'Not switched on', body: "This part of INTAFACED isn't switched on. Nothing was changed." },
  algoSchedulerOff: {
    title: 'Scheduled orders are off',
    body: 'Nothing was saved. A schedule placed now would stay open and send no orders.',
  },
  unknown: { title: "This can't be done right now", body: 'Try again later. If it keeps happening, contact support.' },
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
