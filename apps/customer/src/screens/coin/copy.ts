import { defineCopy } from '../../shared/i18n';

// English source only (UI-SPEC 4.4); other languages fall back to English. Plain money words: no internal terms.
const messages = {
  // Coin bar
  'Coin sections': 'Coin sections',
  Overview: 'Overview',
  About: 'About',
  'Add {asset} to watchlist': 'Add {asset} to watchlist',
  'Remove {asset} from watchlist': 'Remove {asset} from watchlist',
  // Price card
  '{name} price': '{name} price',
  'Price in {quote}': 'Price in {quote}',
  'Chart range': 'Chart range',
  'Range 1D': 'Last day',
  'Range 1W': 'Last week',
  'Range 1M': 'Last month',
  'Range 6M': 'Last six months',
  'Range 1Y': 'Last year',
  'Range All': 'All time',
  'Past day': 'Past day',
  'Past week': 'Past week',
  'Past month': 'Past month',
  'Past six months': 'Past six months',
  'Past year': 'Past year',
  'All time': 'All time',
  'Since {time}': 'Since {time}',
  'Last updated {time}': 'Last updated {time}',
  'Price chart of {asset}': 'Price chart of {asset}',
  'No trades yet': 'No trades yet in this period.',
  'Couldn’t load the chart': 'Couldn’t load the chart.',
  'Couldn’t load the price': 'Couldn’t load the price.',
  'Try again': 'Try again',
  'Dollar price': '$1.00',
  'Counted at 1 USD': '(counted at 1 USD)',
  'Loading the chart': 'Loading the chart…',
  'No market title': 'No market for {asset} on this exchange',
  'No pair market title': 'No {pair} market',
  'No market body': 'There is no market, so there is no price or chart to show.',
  'Go to Markets': 'Go to Markets',
  // Key stats
  'Key stats': 'Key stats',
  '24h high': '24h high',
  '24h low': '24h low',
  '24h volume': '24h volume ({asset})',
  'Your balance': 'Your balance',
  '24h high rule': 'The highest price traded in the last 24 hours.',
  '24h low rule': 'The lowest price traded in the last 24 hours.',
  '24h volume rule': 'How much of this coin traded in the last 24 hours.',
  'Your balance rule': 'What you hold now, with its value at the last price.',
  'Market cap': 'Market cap',
  'Market cap rule': 'Price times the coins in circulation. No circulating supply figure is published here, so it is not worked out.',
  'not published': 'not published',
  Networks: 'Networks',
  'Networks rule': 'The networks you can deposit or withdraw this coin on here, as the platform lists them.',
  'not read': 'not read',
  'not listed': 'not listed',
  'About {label}': 'About {label}',
  'Younger than a day': 'This market is less than a day old, so these figures start at {time}.',
  'Trade {pair}': 'Trade {pair}',
  // Your coin
  'Your {asset}': 'Your {asset}',
  Available: 'Available',
  'In orders': 'In orders',
  'Your position': 'Your position',
  Quantity: 'Quantity',
  'Average price': 'Average price',
  'Cost basis': 'Cost basis',
  Result: 'Result',
  'Not known': 'Not known',
  'Reading your lot book': 'Reading your lot book…',
  'Your lot book could not be read': 'Your lot book could not be read, so the cost of this position is not shown.',
  'No open lots of {asset}': 'Your lot book has no open lots of {asset}.',
  'Lots left out of {asset}':
    'Your {asset} came in by transfer, which your lot book leaves out of its figures, so its cost is not worked out here.',
  'Position note': 'From your lot book, with your saved cost-basis method, at the live price. An indicator only, not tax advice.',
  Send: 'Send',
  Convert: 'Convert',
  // About
  'About {name}': 'About {name}',
  // Recent activity
  'Recent {asset} activity': 'Recent {asset} activity',
  'View all': 'View all',
  'No activity yet': 'No {asset} activity yet',
  'No activity body': 'Your {asset} trades will show here.',
  'No latest activity': 'No {asset} trades in your latest {count}',
  'No latest activity body': 'Older {asset} activity may be under View all.',
  // Names we can say without guessing
  Bitcoin: 'Bitcoin',
  Ethereum: 'Ethereum',
  Tether: 'Tether',
  'USD Coin': 'USD Coin',
} as const;

// Spanish and French exist for the sentences below; every other sentence on this page still reads in English.
const es = {
  'Loading the chart': 'Cargando el gráfico…',
  'No market title': 'No hay mercado de {asset} en este exchange',
  'No pair market title': 'No hay mercado {pair}',
  'No market body': 'Sin mercado, no hay precio ni gráfico que mostrar.',
} as const;
const fr = {
  'Loading the chart': 'Chargement du graphique…',
  'No market title': 'Pas de marché pour {asset} sur cet exchange',
  'No pair market title': 'Pas de marché {pair}',
  'No market body': 'Sans marché, il n’y a ni prix ni graphique à afficher.',
} as const;

export const coinCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.coin', messages, { es, fr });

const nameKey = { BTC: 'Bitcoin', ETH: 'Ethereum', USDT: 'Tether', USDC: 'USD Coin' } as const satisfies Record<
  string,
  keyof typeof messages
>;

/** The plain name for an asset we can name, else null (the ticker then stands alone). */
export function coinName(asset: string, copy: Pick<ReturnType<typeof coinCopy.useCopy>, 't'>): string | null {
  return asset in nameKey ? copy.t(nameKey[asset as keyof typeof nameKey]) : null;
}
