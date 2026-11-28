import { defineCopy } from '../../../shared/i18n';

// Profit lock, in the venue account room (J-wallet-26). English source; other languages fall back to English. No service
// sentence is shown: each refusal is named here by its code.
const en = {
  title: 'Profit lock',
  intro:
    'Set a weekly target for your venue account’s realised profit and a share of it to lock. When the week’s profit reaches the target, you are offered a withdrawal of that share to your own cold wallet, ready to sign. INTAFACED holds, moves and signs nothing.',
  target: 'Weekly target (TEST USDC)',
  targetHint: 'The realised profit this week, as the venue reports it, that makes the offer.',
  share: 'Share to lock (%)',
  shareHint: 'The percent of the week’s realised profit offered to your cold wallet.',
  coldWallet: 'Cold wallet address',
  coldWalletHint: 'Another wallet of your own, on this network. Paste it with its capital letters to have it checked.',
  save: 'Save profit lock',
  saved: 'Saved. Address checked: {address}',
  setting: 'Weekly target {target} TEST USDC, {share}% to {address}',
  refusedOurs:
    'That is an INTAFACED address, not your own wallet. INTAFACED holds none of your money, so the share goes only to a wallet you hold.',
  refusedMistyped: 'That address looks mistyped: its capital letters do not match its checksum. Copy it again from your cold wallet.',
  refusedOwnWallet: 'Give an address of your own wallet, other than the one this venue account belongs to.',
  refusedTarget: 'Weekly target must be a number above zero, like 200.',
  refusedShare: 'Share to lock must be a percent above zero and at most 100, like 50.',
  refusedOther: 'That was not saved. Try again in a moment.',
  weekTitle: 'This week',
  weekProfit: 'Realised profit {profit} TEST USDC of your {target} TEST USDC target, as the venue reports it',
  weekFrom: 'Week from',
  asOf: 'As of',
  unreadTitle: 'Can’t read the venue',
  unreadBody: 'This week’s profit can’t be read from the venue now, so no offer is made. It is not counted as no profit.',
  lastRead: 'Last read',
  neverRead: 'Never read for this lock',
  readyTitle: 'Profit lock ready',
  readyBody: 'This week’s realised profit is {profit} TEST USDC, as the venue reports it. Your {share}% share is {amount} TEST USDC.',
  withdrawalTitle: 'Venue withdrawal, filled in',
  amount: 'Amount',
  to: 'To your cold wallet',
  fee: 'Venue withdrawal fee',
  withdrawable: 'Withdrawable',
  withdrawableNote: 'The venue’s free balance {free} TEST USDC, less its withdrawal fee, which it charges on top.',
  notKnown: 'not known',
  cut: 'Your share, {share} TEST USDC, is above what the venue lets you withdraw now, so it is cut to {amount} TEST USDC.',
  sign: 'Sign withdrawal in my wallet',
  close: 'Close offer',
  signNote: 'Your main wallet signs the venue’s withdrawal. INTAFACED never signs it, and no agent key can.',
  signedTitle: 'Withdrawal signed',
  signedBody: 'You signed this week’s withdrawal to {address}. It is sent once; its state is the venue’s.',
  declinedTitle: 'Offer closed',
  declinedBody: 'You closed this week’s offer. Nothing was signed or sent.',
  noOffer: 'No offer this week yet.',
} as const;
export type ProfitLockCopyKey = keyof typeof en;
export const profitLockCopy = defineCopy('protocol.profitLock', en);
