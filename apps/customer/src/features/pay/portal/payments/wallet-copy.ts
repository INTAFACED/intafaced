import { defineCopy } from '../../../../shared/i18n';

/**
 * Words for the business's own receiving wallet (J-merchant-04, launch money model) and the money it holds outside
 * INTAFACED. Plain English: what happened, why, what to do next.
 */
const en = {
  title: 'Where crypto payments go',
  purpose:
    'Crypto your customers pay at checkout goes straight to your own wallet. INTAFACED never holds it, and we take only our fee, which we bill you.',
  unset: 'No wallet is set, so your checkout cannot take crypto. Add your wallet’s public key below.',
  savedOn: 'Last saved:',
  key: 'Wallet public key (xpub) *',
  keyHint:
    'Your wallet’s extended public key for its Ethereum account, starting xpub. It only lets us make a fresh address for each payment; it cannot move your money. Never paste a private key or recovery phrase.',
  firstAddress: 'First receiving address',
  firstAddressHint: 'Check that your own wallet shows this address. Each payment gets the next one.',
  save: 'Save wallet',
  saving: 'Saving…',
  saved: 'Saved. Your next crypto payment goes to this wallet.',
  noWrite: 'Only the owner or an admin can set where crypto payments go.',
  unverified: 'You can set your wallet once your business is verified.',
  rPrivateKey: 'That is a private key. Never share it. Paste your wallet’s public key, which starts xpub, instead.',
  rInvalid: 'That is not a wallet public key we can read. Copy the xpub from your wallet again.',
  rStale: 'Someone changed the wallet while you were editing. The page now shows the latest one; make your change again.',
  rInteractive: 'Sign in again with your authenticator code to change the wallet.',
  outsideTitle: 'Held outside INTAFACED',
  outsidePurpose:
    'Money your customers paid that is in your own wallet or with the payment partner. These are the chain’s or the partner’s own figures, as last reported.',
  outsideEmpty: 'No payment has reached your own wallet or the partner yet.',
  outsideAsset: 'Asset',
  outsideWhere: 'Where',
  outsideClearing: 'Clearing',
  outsideAvailable: 'Available',
  outsideAsOf: 'As of',
  outsideSource: 'Reported by',
  outsidePayments: 'Payments',
  whereOwnWallet: 'Your own wallet',
  wherePartner: 'With the payment partner',
  sourceChain: 'The chain',
  sourcePartner: 'The partner',
} as const;

export const walletCopy = defineCopy('pay.portal.receivingWallet', en);
/** The wording as written, for the copy lint. */
export const walletMessages: Record<string, string> = en;
