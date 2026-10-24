import { defineCopy } from '../../../../shared/i18n';

/** Words for the "Confirm it's you" step before a refund or a payout. */
const en = {
  suTitle: "Confirm it's you",
  suWhyRefund: "A refund sends money back to your customer, so we check it's you first.",
  suWhyPayout: "A payout sends money out of your account, so we check it's you first.",
  suWhyDestination: "Payouts will go here, so we check it's you first.",
  suDestinationPasskey: 'Your browser will ask for your passkey when you save.',
  suExpired: 'That confirmation expired. Confirm again.',
  suRequired: "Confirm it's you with a passkey or authenticator code.",
  suPasskey: 'Use a passkey',
  suPasskeyWaiting: 'Waiting for your passkey…',
  suOr: 'Or enter a code',
  suCode: '6-digit code from your authenticator app',
  suConfirm: 'Confirm',
  suChecking: 'Checking…',
  suCancel: 'Not now',
  suCodeBad: "That code didn't match. Check your authenticator app and try again.",
  suCodeShort: 'Enter the 6 digits from your authenticator app.',
  suNoAuthenticator: 'No authenticator app is saved on this account. Use a passkey, or add an authenticator app in Security settings.',
  suNoPasskey: 'No passkey is saved on this account. Enter your authenticator code, or add a passkey in Security settings.',
  suPasskeyBad: "That passkey check didn't work. Try again, or enter a code.",
  suPasskeyStopped: 'The passkey check was cancelled or timed out. Try again, or enter a code.',
  suPasskeyFailed: 'The browser could not read your passkey. Try again, or enter a code.',
  suPasskeyUnavailable: 'Passkeys need a secure browser connection here. Enter an authenticator code instead.',
  suKeys: 'API keys and sub-accounts cannot confirm a payment.',
  suRoleRefund: 'Your role on this business does not allow refunds. Ask the account owner.',
  suRolePayout: 'Your role on this business does not allow payouts. Ask the account owner.',
  suRoleAny: 'Your role on this business does not allow this. Ask the account owner.',
  suFailed: "We couldn't confirm it's you. Try again.",
  suNoteMany: 'Confirmed for the next {n} minutes.',
  suNoteOne: 'Confirmed for the next minute.',
} as const;
export const stepUpCopy = defineCopy('pay.portal.stepup', en);
/** The wording as written, for the copy lint. */
export const stepUpMessages: Record<string, string> = en;
