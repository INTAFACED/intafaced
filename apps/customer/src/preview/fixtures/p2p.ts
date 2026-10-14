import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the P2P Preview (the "street rails" board). Invented people, prices and limits; never mixed with real data.
 * Money is a decimal STRING (built with bigint arithmetic, never a float). See ../README.md.
 */

export type P2pSide = 'buy' | 'sell';
export type P2pAssetId = 'USDT' | 'BTC';
export type P2pFiatId = 'usd' | 'try' | 'ngn' | 'idr' | 'brl';
export type P2pMethodId = 'bank' | 'instant' | 'mobile' | 'card';
export type P2pBadge = 'top' | 'verified' | 'none';
export type P2pTradeState = 'awaiting-payment' | 'payment-sent' | 'released' | 'appeal';

export interface P2pFiat {
  readonly id: P2pFiatId;
  readonly name: string;
  /** Currency sign drawn before a price. */
  readonly sign: string;
}
export interface P2pMethod {
  readonly id: P2pMethodId;
  readonly name: string;
}
export interface P2pAdvertiser {
  readonly id: string;
  readonly name: string;
  readonly badge: P2pBadge;
  /** Percent of trades completed, a decimal string such as "98.40". */
  readonly completionPct: string;
  readonly trades: number;
  /** Average minutes the advertiser takes to release the coins. */
  readonly releaseMinutes: number;
}
export interface P2pOffer {
  readonly id: string;
  /** What the viewer does: "buy" means the viewer buys coins from an advertiser who sells. */
  readonly side: P2pSide;
  readonly asset: P2pAssetId;
  readonly fiat: P2pFiatId;
  readonly advertiserId: string;
  /** Price of one coin in the fiat currency (decimal string). */
  readonly price: string;
  /** Decimals the price column lines up on. */
  readonly priceTick: string;
  /** Coins the advertiser still has (decimal string). */
  readonly available: string;
  /** Smallest and largest trade in the fiat currency (decimal strings). */
  readonly minFiat: string;
  readonly maxFiat: string;
  readonly methods: readonly P2pMethodId[];
}
export interface P2pChatLine {
  readonly from: 'you' | 'them' | 'system';
  readonly text: string;
  /** A relative time, so no time zone is involved. */
  readonly when: string;
}
export interface P2pStep {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}
export interface P2pTrade {
  readonly advertiserId: string;
  readonly asset: P2pAssetId;
  readonly fiat: P2pFiatId;
  readonly method: P2pMethodId;
  /** Coins being bought (decimal string). */
  readonly amount: string;
  readonly price: string;
  readonly priceTick: string;
  /** What the buyer pays in fiat (decimal string). */
  readonly fiatAmount: string;
  readonly payWindowMinutes: number;
  readonly steps: readonly P2pStep[];
  /** The id of the step the trade is on, for each sample state. */
  readonly stepFor: Readonly<Record<P2pTradeState, string>>;
  readonly chat: Readonly<Record<P2pTradeState, readonly P2pChatLine[]>>;
  readonly payTo: readonly { readonly label: string; readonly value: string }[];
}
export interface P2pAppeal {
  readonly reason: string;
  readonly status: string;
  readonly steps: readonly P2pStep[];
  /** How many steps are done. */
  readonly doneSteps: number;
  readonly evidence: readonly { readonly name: string; readonly note: string }[];
  readonly escrowNote: string;
}
export interface P2pFixtureRows {
  readonly assets: readonly P2pAssetId[];
  readonly fiats: readonly P2pFiat[];
  readonly methods: readonly P2pMethod[];
  readonly advertisers: readonly P2pAdvertiser[];
  readonly offers: readonly P2pOffer[];
  readonly trade: P2pTrade;
  readonly appeal: P2pAppeal;
}

const fiats: readonly P2pFiat[] = [
  { id: 'usd', name: 'US dollar', sign: '$' },
  { id: 'try', name: 'Turkish lira', sign: '₺' },
  { id: 'ngn', name: 'Nigerian naira', sign: '₦' },
  { id: 'idr', name: 'Indonesian rupiah', sign: 'Rp' },
  { id: 'brl', name: 'Brazilian real', sign: 'R$' },
];

const methods: readonly P2pMethod[] = [
  { id: 'bank', name: 'Bank transfer' },
  { id: 'instant', name: 'Local instant payment' },
  { id: 'mobile', name: 'Mobile wallet' },
  { id: 'card', name: 'Card payment' },
];

const advertisers: readonly P2pAdvertiser[] = [
  { id: 'northwind', name: 'northwind.otc', badge: 'top', completionPct: '99.40', trades: 2841, releaseMinutes: 3 },
  { id: 'coral', name: 'coral_desk', badge: 'top', completionPct: '98.80', trades: 1967, releaseMinutes: 4 },
  { id: 'atlas', name: 'atlas_trades', badge: 'verified', completionPct: '97.60', trades: 1204, releaseMinutes: 5 },
  { id: 'mira', name: 'mira.p2p', badge: 'verified', completionPct: '98.10', trades: 856, releaseMinutes: 6 },
  { id: 'kestrel', name: 'kestrel', badge: 'verified', completionPct: '96.30', trades: 512, releaseMinutes: 8 },
  { id: 'lumen', name: 'lumen_fx', badge: 'none', completionPct: '94.70', trades: 143, releaseMinutes: 9 },
  { id: 'harbor', name: 'harbor.swap', badge: 'none', completionPct: '92.50', trades: 64, releaseMinutes: 11 },
  { id: 'ivy', name: 'ivy_trade', badge: 'none', completionPct: '95.90', trades: 87, releaseMinutes: 7 },
];

// ---------------------------------------------------------------------------------------------------------------------
// Offers are built from an invented base price per coin and currency, in 1/10,000 of the currency, plus a small spread per
// row. All arithmetic is bigint, so no price ever passes through a float.
// ---------------------------------------------------------------------------------------------------------------------
const UNIT = 10_000n;
const base: Readonly<Record<P2pAssetId, Partial<Record<P2pFiatId, bigint>>>> = {
  USDT: { usd: 10_000n, try: 342_000n, ngn: 15_900_000n, idr: 158_200_000n, brl: 54_500n },
  BTC: { usd: 642_500_000n, try: 21_973_500_000n, brl: 3_501_625_000n },
};
/** Whole fiat units one limit step is worth, so limits look right in every currency. Invented. */
const limitScale: Readonly<Record<P2pFiatId, bigint>> = { usd: 1n, try: 34n, ngn: 1_500n, idr: 16_000n, brl: 5n };
const buySpread: readonly bigint[] = [10n, 25n, 40n, 60n];
const sellSpread: readonly bigint[] = [-10n, -25n, -40n, -70n];
const usdtAvailable = ['4250.00', '1800.00', '9200.00', '650.00'] as const;
const btcAvailable = ['0.42000000', '0.18500000', '1.20000000', '0.06500000'] as const;
const maxLimit: readonly bigint[] = [1000n, 2500n, 5000n, 800n];
const methodSets: readonly (readonly P2pMethodId[])[] = [['bank', 'instant'], ['instant'], ['bank', 'mobile', 'card'], ['mobile', 'bank']];

/** `units` is in 1/10,000; returns a decimal string with `places` digits (half-up). */
function decimal(units: bigint, places: number): string {
  const divisor = 10n ** BigInt(4 - places);
  const rounded = (units + divisor / 2n) / divisor;
  const scale = 10n ** BigInt(places);
  return `${rounded / scale}.${(rounded % scale).toString().padStart(places, '0')}`;
}

function buildOffers(): readonly P2pOffer[] {
  const combos: readonly (readonly [P2pAssetId, P2pFiatId])[] = [
    ['USDT', 'usd'],
    ['USDT', 'try'],
    ['USDT', 'ngn'],
    ['USDT', 'idr'],
    ['USDT', 'brl'],
    ['BTC', 'usd'],
    ['BTC', 'try'],
    ['BTC', 'brl'],
  ];
  const rows: P2pOffer[] = [];
  combos.forEach(([asset, fiat], comboIndex) => {
    const places = asset === 'USDT' && fiat === 'usd' ? 4 : 2;
    for (const side of ['buy', 'sell'] as const) {
      for (let index = 0; index < 4; index += 1) {
        const spread = (side === 'buy' ? buySpread : sellSpread)[index]!;
        const price = (base[asset][fiat]! * (UNIT + spread)) / UNIT;
        const advertiser = advertisers[(index * 2 + comboIndex + (side === 'buy' ? 0 : 1)) % advertisers.length]!;
        const scale = limitScale[fiat];
        rows.push({
          id: `${side}-${asset}-${fiat}-${index}`,
          side,
          asset,
          fiat,
          advertiserId: advertiser.id,
          price: decimal(price, places),
          priceTick: places === 4 ? '0.0001' : '0.01',
          available: asset === 'BTC' ? btcAvailable[index]! : usdtAvailable[index]!,
          minFiat: `${(asset === 'BTC' ? 100n : 20n) * scale}.00`,
          maxFiat: `${maxLimit[index]! * scale * (asset === 'BTC' ? 10n : 1n)}.00`,
          methods: methodSets[(index + (side === 'buy' ? 0 : 2)) % methodSets.length]!,
        });
      }
    }
  });
  return rows;
}

const tradeSteps: readonly P2pStep[] = [
  { id: 'order', title: 'Order placed', detail: 'The seller’s USDT is locked in escrow.' },
  { id: 'pay', title: 'You pay the seller', detail: 'Send the exact amount outside INTAFACED.' },
  { id: 'confirm', title: 'Seller confirms', detail: 'The seller checks their account.' },
  { id: 'release', title: 'USDT released to you', detail: 'Escrow pays out to your balance.' },
];

const trade: P2pTrade = {
  advertiserId: 'northwind',
  asset: 'USDT',
  fiat: 'usd',
  method: 'bank',
  amount: '250.00',
  price: '1.0010',
  priceTick: '0.0001',
  fiatAmount: '250.25',
  payWindowMinutes: 15,
  steps: tradeSteps,
  stepFor: { 'awaiting-payment': 'pay', 'payment-sent': 'confirm', released: 'release', appeal: 'confirm' },
  payTo: [
    { label: 'Account holder', value: 'Sample Holder Ltd' },
    { label: 'Bank', value: 'Sample Bank' },
    { label: 'Account number', value: '0000 1111 2222' },
    { label: 'Reference', value: 'SAMPLE-1' },
  ],
  chat: {
    'awaiting-payment': [
      { from: 'system', text: 'Order placed. 250.00 USDT is now held in escrow.', when: '2 min ago' },
      { from: 'them', text: 'Hi! The bank details are on the left. Please use the reference.', when: '2 min ago' },
      { from: 'you', text: 'Thanks, sending now.', when: '1 min ago' },
    ],
    'payment-sent': [
      { from: 'system', text: 'You marked the payment as sent. Waiting for the seller.', when: '4 min ago' },
      { from: 'you', text: 'Paid $250.25. Receipt attached.', when: '4 min ago' },
      { from: 'them', text: 'Got it, checking my account.', when: '3 min ago' },
    ],
    released: [
      { from: 'system', text: 'Payment confirmed. 250.00 USDT released to your balance.', when: 'Just now' },
      { from: 'them', text: 'Done. Thanks for the quick trade!', when: 'Just now' },
      { from: 'you', text: 'All good, thank you.', when: 'Just now' },
    ],
    appeal: [
      { from: 'system', text: 'You marked the payment as sent. Waiting for the seller.', when: '40 min ago' },
      { from: 'you', text: 'Paid $250.25. Receipt attached. Can you release?', when: '38 min ago' },
      { from: 'them', text: 'I do not see it yet.', when: '30 min ago' },
      { from: 'system', text: 'You opened an appeal. A reviewer will look at this trade.', when: '5 min ago' },
    ],
  },
};

const appeal: P2pAppeal = {
  reason: 'I paid, and the seller has not released the USDT.',
  status: 'In review',
  doneSteps: 2,
  steps: [
    { id: 'opened', title: 'Appeal opened', detail: 'The trade is paused.' },
    { id: 'evidence', title: 'Evidence received', detail: 'Both sides can add proof.' },
    { id: 'review', title: 'A reviewer checks', detail: 'They may ask for more proof first.' },
    { id: 'decision', title: 'Decision', detail: 'Escrow goes to the buyer or back to the seller.' },
  ],
  evidence: [
    { name: 'Payment receipt', note: 'Image, added by you' },
    { name: 'Bank statement line', note: 'Image, added by you' },
    { name: 'Seller reply', note: 'Chat message, added by the seller' },
  ],
  escrowNote: 'While an appeal is open the USDT stays in escrow. Nobody can move it.',
};

export const p2pFixture = definePreviewFixture<P2pFixtureRows>(
  'p2p',
  'P2P: sample offers, merchants, one sample escrow trade and a sample appeal.',
  { assets: ['USDT', 'BTC'], fiats, methods, advertisers, offers: buildOffers(), trade, appeal },
);
