import { defineCopy } from '../../../shared/i18n';

/**
 * Authored copy for the wallet portfolio, its profit and loss, the token page and the address tracker
 * (D-portfolio-wallet-04, RC-dex-protocol-17, J-dex-protocol-06). English only for now. Every figure is read from the
 * chain; nothing here is a balance INTAFACED holds.
 */
const en = {
  portfolioTitle: 'Portfolio',
  portfolioNote:
    'What this wallet holds on this network, priced from the pools at the latest block. Read from the chain; we hold none of it.',
  totalLabel: 'Total value',
  asOf: 'At block {block}',
  noPriceNote_one: '{count} token has no price from the pools and is left out of the total.',
  noPriceNote_other: '{count} tokens have no price from the pools and are left out of the total.',
  holdingsLabel: 'Holdings',
  hdr_token: 'Token',
  hdr_balance: 'Balance',
  hdr_price: 'Price',
  hdr_value: 'Value',
  noPrice_thin_reserve: 'No price: its pools are too thin to price honestly',
  noPrice_no_route: 'No price: no pool leads to a dollar',
  holdingsEmpty: 'This wallet holds none of the tokens the pools list.',
  pnlButton: 'Profit and loss',
  positionsButton: 'Positions',
  holdingsButton: 'Holdings',
  pnlTitle: 'Profit and loss',
  pnlLabel: 'Profit and loss',
  pnlExcludes:
    'Excludes {deposits} of deposits and {withdrawals} of withdrawals since block {block}, each valued at the price of its own block.',
  pnlNone: 'No history yet: this wallet has not held a token the pools list.',
  drawdownLabel: 'Largest fall',
  drawdownText: '{pct}%, from {peak} at block {peakBlock} to {trough} at block {troughBlock}',
  drawdownNone: 'None: the value has not fallen from a peak.',
  conventionsLabel: 'Conventions',
  readFailed: 'The portfolio could not be read.',
  needsWallet: 'Connect a wallet to see its portfolio.',
  tokenBack: 'Back to the portfolio',
  tokenMissing: 'This wallet holds none of this token now.',
  tokenBalance: 'Balance',
  tokenPrice: 'Price now',
  tokenValue: 'Value now',
  entryLabel: 'Entry price',
  entryOne: '{price}, the price at its arrival block (block {block})',
  entryMany: '{price}, the average of the prices at each arrival block ({count} arrivals, blocks {first} to {last})',
  entryUnpriced: '{count} arrivals had no price at their block and are not in it.',
  entryNone: 'Not known: no amount of it arrived while the pools gave it a price.',
  positionsTitle: 'Positions',
  positionsLabel: 'Positions',
  conv_pnl: 'How profit and loss is counted',
  conv_pnl_body:
    'Profit and loss is the value now, less every amount that came into the wallet and plus every amount that went out, each valued at the price of the block it moved in. A trade with a pool is not money in or out: its result is in the value. A token with no price is left out of the value and of what came in.',
  conv_drawdown: 'How the largest fall is measured',
  conv_drawdown_body:
    'The largest fall is measured on the value with money in and out taken out: at each block, the change in value less what came in or went out. It is the deepest fall from a peak, shown with the value at the peak and at the low.',
  conv_prices: 'How prices are read',
  conv_prices_body:
    'Each token is priced in dollars from the pools at one block: against a reference dollar token, or through one priced token. A pool whose other side holds less than the published minimum gives no price, and a token with no honest price says so instead of showing a figure.',
  conv_entry: 'How the entry price is set',
  conv_entry_body:
    'The entry price of a token is the price at the block each amount of it arrived in the wallet, averaged by amount. It is read from the chain, not entered by anyone.',
  conventionMissing: 'There is no such convention.',
  conv_modes: 'Account modes',
  conv_modes_body:
    'An account on our own book is Standard: each futures position is isolated and can lose only the margin put into it. Portfolio margin, which would offset positions against each other, has no published rules and is not offered. A routed venue keeps its own modes, shown on its own desk.',
  modeTitle: 'Account mode',
  modeStandard: 'Standard',
  modeNote: 'Your account on our own book is Standard, the only mode offered. Each position keeps its own margin.',
  modeLink: 'What Standard means',
  modeAsk: 'Ask for portfolio margin',
  modeCode: 'Code: {code}',
  modeOffered: 'The futures service now offers portfolio margin. It is not switched on here: it is set when a position opens.',
  trackerTitle: 'Track an address',
  trackerNote:
    'Paste any public address to see what it holds and its token history. The read sends only the address: no cookie, no sign-in and nothing about you. The watchlist stays in this browser and is never sent or exported.',
  trackerAddress: 'Address',
  trackerAddressHint: '0x and 40 characters',
  trackerButton: 'Track',
  trackerInvalid: 'This is not an address. Check it has 0x and 40 characters.',
  trackedTitle: 'Tracked {address}',
  historyLabel: 'History',
  transfersLabel: 'Token transfers',
  noHistory: 'No history: this address has never held or moved a token the pools list.',
  hdr_block: 'Block',
  hdr_direction: 'Direction',
  hdr_amount: 'Amount',
  hdr_counterparty: 'Other side',
  hdr_tx: 'Transaction',
  dirIn: 'In',
  dirOut: 'Out',
  poolTrade: 'pool trade',
  historyNewest: 'The newest {shown} of {count} transfers.',
  watchlistLabel: 'Watchlist',
  watchlistEmpty: 'No address is on the watchlist yet. Track one to keep it here, in this browser only.',
  watchlistRemove: 'Remove {address}',
} as const;

export const portfolioCopy = defineCopy('customer.protocol.wallet.portfolio', en);
export type PortfolioTranslate = ReturnType<typeof portfolioCopy.forLocale>['t'];
