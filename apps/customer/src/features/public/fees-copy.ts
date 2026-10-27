import { defineCopy } from '../../shared/i18n';

// English source only. Every rate on the page is read from the published schedule; a blank one reads "not set".
export const feesCopy = defineCopy('public-fees', {
  title: 'Trading fees',
  lead: 'What you pay to trade spot, by pair group and tier. A fee is a share of the value traded, taken from what you receive.',
  version: 'Schedule version {version}',
  loading: 'Loading the fee schedule…',
  failed: 'The fee schedule did not load.',
  retry: 'Try again',
  blankTitle: 'The trading fee schedule is not set',
  blankBody: 'No maker or taker rate is published, so no spot order can be placed. Nothing is shown rather than a made-up rate.',
  noGroups: 'No pair group is published.',
  groupTitle: 'Pair group: {group}',
  defaultGroup: 'Every pair not named in another group is in this one.',
  pairs: 'Pairs: {pairs}',
  noPairs: 'No listed pair is in this group.',
  colTier: 'Tier',
  colMaker: 'Maker',
  colTaker: 'Taker',
  notSet: 'not set',
  notAvailable: 'not available',
  zeroFee: 'Zero fee',
  regular: 'Regular',
  makerTakerTitle: 'Maker and taker',
  makerTakerBody:
    'A maker order rests on the book and waits for someone to trade with it. A taker order trades with an order already on the book. The order ticket shows which one your order is, and its rate, before you send it.',
  networkTitle: 'Network fee',
  networkLine: 'Network fee on withdrawals: not set here',
  networkBody:
    'Sending a coin out of your account costs a fee set for each network, separate from any trading fee. It is shown on the withdrawal before you send.',
  tradeLink: 'Go to the spot desk',
  myTierLink: 'See your own tier and the volume counted toward the next one',
});
