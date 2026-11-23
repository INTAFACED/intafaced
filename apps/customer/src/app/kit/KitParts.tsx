import { useState } from 'react';
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  Button,
  Checkbox,
  ChoiceGroup,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  ReviewDialog,
  Sparkline,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@intafaced/ui';
import {
  AmountField,
  AssetIcon,
  Button as VoltButton,
  CardStack,
  CardStackLoading,
  Fold,
  HeroFigure,
  InfoTip,
  Payee,
  Rail,
  StatusNote,
  ToastProvider,
  ToggleChips,
  Field as VoltField,
  useToast as useVoltToast,
  typeRoles,
  type DoorLink,
  type FigurePart,
  type TypeRole,
} from '@intafaced/ui/lit';
import {
  Candles,
  QrCode,
  Sparkline as LineSpark,
  sortRows,
  Stepper,
  Table,
  TabList,
  type Candle as KitCandle,
  type Column,
  type SortState,
} from '@intafaced/ui/lit/templates';
import type { OrderBook as WireBook } from '@intafaced/exchange-contract/schemas';
import { ShellIcon, type ShellIconName } from '../icons';
import { PriceChart } from '../../screens/trade/chart/PriceChart';
import { BookPanel } from '../../screens/trade/desk/OrderBook';
import type { DeskMarket } from '../../screens/trade/desk/market';
import type { Candle, Loadable, TickerRow } from '../../data/types';
// The chart and the book draw with the desk's own sheets, as on the trade desk.
import '../../screens/trade/desk/desk.css';
import '../../screens/trade/chart/chart.css';

/**
 * The parts of the kit /kit did not show before intafaced issue 9326: type roles, form controls, overlays, the stepper,
 * the sparkline, the computer rail, the icon set, the candle chart and the order book. Each is the shipped part with TEST
 * sample data; none of them reads a service.
 */

const ROLE_SAMPLE: Record<TypeRole, string> = {
  hero: '$12,468.50',
  figure: '3,250.00 USDT',
  title: 'Buy crypto in a few steps',
  heading: 'Recent activity',
  body: 'Bitcoin, Ether and more, paid from your USDT or USDC balance.',
  label: 'Est. total value',
  micro: 'TEST · ref 4F2A',
};

export function TypeRoles() {
  return (
    <dl className="vk-type">
      {(Object.keys(typeRoles) as TypeRole[]).map((role) => (
        <div key={role} className="vk-type__row" data-role={role}>
          <dt>
            <strong>{role}</strong>
            <small>{typeRoles[role]}</small>
          </dt>
          <dd>
            <Text variant={role}>{ROLE_SAMPLE[role]}</Text>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Controls() {
  const [name, setName] = useState('mika');
  const [agree, setAgree] = useState(true);
  const [notify, setNotify] = useState(true);
  const [speed, setSpeed] = useState('standard');
  const nameError = name.length < 3 ? 'Use 3 characters or more.' : undefined;
  return (
    <div className="vk-controls">
      <div className="vk-panel vk-stack">
        <Field label="Your handle" hint="Shown to people you pay." error={nameError}>
          <Input value={name} onValueChange={setName} aria-label="Your handle" />
        </Field>
        <Field label="Handle with an error" error="That handle is taken.">
          <Input defaultValue="ana" aria-label="Handle with an error" />
        </Field>
        <Field label="A field you cannot change" disabled>
          <Input defaultValue="mika.tan" aria-label="A field you cannot change" disabled />
        </Field>
      </div>
      <div className="vk-panel vk-stack">
        <label className="vk-inline">
          <Checkbox checked={agree} onCheckedChange={setAgree} aria-label="Remember this device" />
          <span>Remember this device</span>
        </label>
        <label className="vk-inline">
          <Checkbox disabled aria-label="A box you cannot change" />
          <span>A box you cannot change</span>
        </label>
        <label className="vk-inline">
          <Switch checked={notify} onCheckedChange={setNotify} aria-label="Tell me when it arrives" />
          <span>Tell me when it arrives</span>
        </label>
        <label className="vk-inline">
          <Switch checked disabled aria-label="A switch you cannot change" />
          <span>A switch you cannot change</span>
        </label>
        <ChoiceGroup
          label="Delivery speed"
          items={['standard', 'fast']}
          labels={{ standard: 'Standard, free', fast: 'Fast, 1.00 USDT TEST' }}
          value={speed}
          onChange={setSpeed}
        />
      </div>
      <div className="vk-panel">
        <Tabs defaultValue="open">
          <TabsList divider aria-label="Orders">
            <TabsTab value="open">Open</TabsTab>
            <TabsTab value="filled">Filled</TabsTab>
            <TabsTab value="cancelled">Cancelled</TabsTab>
          </TabsList>
          <TabsPanel value="open">
            <Text variant="body">Two open TEST orders.</Text>
          </TabsPanel>
          <TabsPanel value="filled">
            <Text variant="body">Five filled TEST orders.</Text>
          </TabsPanel>
          <TabsPanel value="cancelled">
            <Text variant="body">No cancelled orders.</Text>
          </TabsPanel>
        </Tabs>
      </div>
    </div>
  );
}

const COINS = ['Bitcoin', 'Ether', 'Solana', 'Tether USD', 'USD Coin'];

export function Overlays() {
  const [review, setReview] = useState(false);
  return (
    <div className="vk-row">
      <Menu>
        <MenuTrigger render={<Button variant="secondary" size={40} data-kit="open-menu" />}>More</MenuTrigger>
        <MenuContent align="start">
          <MenuItem>Copy address</MenuItem>
          <MenuItem>Share receipt</MenuItem>
          <MenuSeparator />
          <MenuItem>Report a problem</MenuItem>
        </MenuContent>
      </Menu>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size={40} data-kit="tooltip" />}>What is the fee?</TooltipTrigger>
        <TooltipContent>TEST. The network fee, shown before you confirm.</TooltipContent>
      </Tooltip>
      <Popover>
        <PopoverTrigger render={<Button variant="secondary" size={40} data-kit="open-popover" />}>Price details</PopoverTrigger>
        <PopoverContent align="start">
          <PopoverTitle>Price details</PopoverTitle>
          <PopoverDescription>TEST. 1 BTC = 65,000.00 USDT, held for 30 seconds.</PopoverDescription>
        </PopoverContent>
      </Popover>
      <Autocomplete items={COINS}>
        <AutocompleteInput placeholder="Search coins" aria-label="Search coins" data-kit="autocomplete" />
        <AutocompleteContent>
          <AutocompleteEmpty>No coin by that name.</AutocompleteEmpty>
          <AutocompleteList>
            {(coin: string) => (
              <AutocompleteItem key={coin} value={coin}>
                {coin}
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompleteContent>
      </Autocomplete>
      <Button variant="primary" size={40} data-kit="open-review" onClick={() => setReview(true)}>
        Review send
      </Button>
      {review ? (
        <ReviewDialog title="Send 250.00 USDT to Mika Tan" closeLabel="Close" onClose={() => setReview(false)}>
          <dl className="vk-kv">
            <div>
              <dt>You send</dt>
              <dd>250.00 USDT</dd>
            </div>
            <div>
              <dt>Fee</dt>
              <dd>0.00 USDT</dd>
            </div>
            <div>
              <dt>Mika receives</dt>
              <dd>250.00 USDT</dd>
            </div>
          </dl>
          <Text variant="micro">TEST · nothing is sent from this page</Text>
          <div className="vk-row">
            <Button variant="ghost" size={48} onClick={() => setReview(false)}>
              Back
            </Button>
            <Button variant="primary" size={48} onClick={() => setReview(false)}>
              Confirm and send
            </Button>
          </div>
        </ReviewDialog>
      ) : null}
    </div>
  );
}

const SPARK = ['64100', '64320', '64010', '64550', '64900', '64780', '65200', '65080', '65410', '65000'];

export function StepsAndSpark() {
  return (
    <div className="vk-grid">
      <div className="vk-panel">
        <Stepper labels={['Amount', 'Review', 'Done']} current={1} />
      </div>
      <div className="vk-panel vk-row">
        <Sparkline values={SPARK} width={120} height={32} direction="up" label="TEST BTC, the last ten hours" />
        <Sparkline values={[...SPARK].reverse()} width={120} height={32} direction="down" label="TEST ETH, the last ten hours" />
      </div>
    </div>
  );
}

type ListRow = { symbol: string; last: string; change: string; spark: readonly string[] };
type ListChip = 'all' | 'gainers' | 'losers';

/** 120 TEST markets, so the list is long enough to draw only the rows on screen. */
const LIST_ROWS: readonly ListRow[] = Array.from({ length: 120 }, (_, i) => {
  const up = i % 3 !== 1;
  const base = 100 + ((i * 37) % 900);
  return {
    symbol: `TEST${String(i + 1).padStart(3, '0')}/USDT`,
    last: `${base}.${String((i * 13) % 100).padStart(2, '0')}`,
    change: `${up ? '' : '-'}${(i % 9) + 1}.${(i * 7) % 10}`,
    spark: Array.from({ length: 12 }, (_, h) => String(base + (up ? h : -h) * ((i % 5) + 1) + ((h * i) % 7))),
  };
});

const LIST_COLUMNS: readonly Column<ListRow>[] = [
  { key: 'name', label: 'Name', cell: (r) => r.symbol, sortType: 'text', sortLabel: 'Sort by Name' },
  { key: 'last', label: 'Price', cell: (r) => r.last, align: 'end', sortType: 'decimal', sortLabel: 'Sort by Price' },
  { key: 'change', label: '24h change', cell: (r) => `${r.change}%`, align: 'end', sortType: 'decimal', sortLabel: 'Sort by 24h change' },
  {
    key: 'spark',
    label: 'Last 12h',
    cell: (r) => (
      <LineSpark label={`${r.symbol}, the last twelve hours`} values={r.spark} size="row" tone={r.change.startsWith('-') ? 'down' : 'up'} />
    ),
  },
];

const LIST_SORT_VALUES = [
  { id: 'name', value: (r: ListRow) => r.symbol, sortType: 'text' as const },
  { id: 'last', value: (r: ListRow) => r.last, sortType: 'decimal' as const },
  { id: 'change', value: (r: ListRow) => r.change, sortType: 'decimal' as const },
];

/** A markets list: filter chips over a sortable table that draws only the rows near the window's view. */
export function MarketList() {
  const [chip, setChip] = useState<ListChip | null>('all');
  const [sort, setSort] = useState<SortState | null>(null);
  const shown = LIST_ROWS.filter((r) => chip !== 'gainers' || !r.change.startsWith('-')).filter(
    (r) => chip !== 'losers' || r.change.startsWith('-'),
  );
  return (
    // Inside a room frame, as in a room: the table stacks its rows by the room's own width.
    <div className="lt-room">
      <div className="vk-stack">
        <ToggleChips
          label="Filter by change"
          options={[
            { value: 'all', label: 'All' },
            { value: 'gainers', label: 'Gainers' },
            { value: 'losers', label: 'Losers' },
          ]}
          value={chip}
          onChange={setChip}
          clearable
        />
        <Table
          caption="TEST markets"
          columns={LIST_COLUMNS}
          rows={sortRows(shown, LIST_SORT_VALUES, sort)}
          rowKey={(r) => r.symbol}
          rowHref={() => '/kit'}
          rowMarks={(r) => ({ 'data-symbol': r.symbol })}
          sort={sort}
          onSort={setSort}
          empty="No TEST markets match"
          virtual={{ estimate: 56 }}
        />
      </div>
    </div>
  );
}

const RAIL_LINKS: DoorLink[] = [
  { door: 'home', label: 'Home', href: '/kit', icon: <ShellIcon name="home" /> },
  { door: 'money', label: 'Money', href: '/kit', icon: <ShellIcon name="wallet" /> },
  { door: 'trade', label: 'Trade', href: '/kit', icon: <ShellIcon name="markets" /> },
  { door: 'pay', label: 'Pay', href: '/kit', icon: <ShellIcon name="send" /> },
  { door: 'more', label: 'More', href: '/kit', icon: <ShellIcon name="grid" /> },
];

export function ComputerRail() {
  return (
    <div className="vk-rail">
      <Rail links={RAIL_LINKS} current="home" label="TEST rail" />
    </div>
  );
}

const ICONS: ShellIconName[] = [
  'home',
  'wallet',
  'activity',
  'markets',
  'spot',
  'buy',
  'convert',
  'send',
  'receive',
  'help',
  'settings',
  'grid',
  'search',
  'bell',
  'user',
  'chevron',
  'academy',
  'merchant',
  'bank',
  'margin',
  'futures',
  'options',
  'loans',
  'cards',
];

export function Icons() {
  return (
    <ul className="vk-icons">
      {ICONS.map((name) => (
        <li key={name}>
          <ShellIcon name={name} size={24} />
          <code>{name}</code>
        </li>
      ))}
    </ul>
  );
}

// Forty TEST hourly candles, made by a fixed rule so every render draws the same chart.
const START = Date.UTC(2026, 10, 20, 0, 0, 0);
const TEST_CANDLES: Candle[] = Array.from({ length: 40 }, (_, i) => {
  const base = 64000 + Math.round(900 * Math.sin(i / 5) + 25 * i);
  const open = base + ((i * 37) % 120) - 60;
  const close = base + ((i * 53) % 160) - 80;
  const high = Math.max(open, close) + 40 + ((i * 11) % 60);
  const low = Math.min(open, close) - 40 - ((i * 17) % 60);
  return {
    t: START + i * 3_600_000,
    o: open.toFixed(2),
    h: high.toFixed(2),
    l: low.toFixed(2),
    c: close.toFixed(2),
    v: (2 + ((i * 7) % 9) / 3).toFixed(4),
    filled: false,
  };
});

const CHART_LABELS = {
  buy: 'Buy',
  sell: 'Sell',
  open: 'O',
  high: 'H',
  low: 'L',
  close: 'C',
  change: 'Change',
  chart: 'TEST BTC/USDT, 1 hour',
};

export function CandleChart() {
  return (
    <div className="vk-candles">
      <PriceChart
        candles={TEST_CANDLES}
        mode="candles"
        interval="1h"
        resetKey="kit"
        tickSize="0.01"
        orderLines={[]}
        fills={[]}
        timeZone="UTC"
        labels={CHART_LABELS}
      />
    </div>
  );
}

/** The kit's QR code: dark on its own light ground on the dark page, in both sizes, and its failure line. */
export function ScanCodes() {
  return (
    <div className="vk-row">
      <QrCode
        value="https://example.test/pay/link/TEST-0001"
        label="Scan to open the TEST payment link"
        failed="This link is too long for a code."
      />
      <QrCode
        value="ethereum:0x000000000000000000000000000000000000dEaD@84532"
        label="Scan to send to this TEST address"
        failed="This address is too long for a code."
        size="sm"
        showValue
      />
      <QrCode value={'x'.repeat(3000)} label="Scan" failed="This TEST text is too long for a code, so none is drawn." />
    </div>
  );
}

/** The kit's own small candle chart, for a pool's or a token's page: the same TEST candles, placed by time. */
export function SmallCandles() {
  const window = { start: START / 1000, seconds: 48 * 3600, width: 3600 };
  // A quiet stretch: candles 20 to 27 are left out, so the chart shows the gap.
  const candles: KitCandle[] = TEST_CANDLES.filter((_, i) => i < 20 || i > 27).map((c) => ({
    key: String(c.t),
    at: c.t / 1000,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
    title: `${new Date(c.t).toISOString().slice(11, 16)} UTC: open ${c.o}, high ${c.h}, low ${c.l}, close ${c.c}, TEST`,
    marks: { 'data-testid': 'kit-candle' },
  }));
  return (
    <div className="vk-grid">
      <Candles
        label="TEST/USDT, hourly candles over two days, TEST"
        candles={candles}
        window={window}
        empty="No trades in these two days, so there is no price to draw."
        caption="Hourly candles, TEST. The gap is eight hours with no trade."
      />
      <Candles label="TEST/USDT, hourly candles, TEST" candles={[]} empty="No trades in these two days, so there is no price to draw." />
    </div>
  );
}

const MARKET: DeskMarket = {
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  tickSize: '0.01',
  lotSize: '0.0001',
  minAmount: null,
  minCost: null,
  open: true,
  state: 'OPEN',
};

const level = (price: number, amount: number): [string, string] => [price.toFixed(2), amount.toFixed(4)];

export function Book() {
  // The book's age is read against now, so it is stamped when the page draws it.
  const [book] = useState<Loadable<WireBook>>(() => {
    const now = Date.now();
    return {
      status: 'ready',
      asOf: now,
      data: {
        symbol: 'BTC/USDT',
        bids: Array.from({ length: 10 }, (_, i) => level(64999.5 - i * 0.5, 0.12 + ((i * 7) % 10) / 20)),
        asks: Array.from({ length: 10 }, (_, i) => level(65000.5 + i * 0.5, 0.09 + ((i * 3) % 10) / 20)),
        timestamp: now,
        datetime: new Date(now).toISOString(),
        nonce: 1,
      },
    };
  });
  const ticker: Loadable<TickerRow> = {
    status: 'ready',
    asOf: 0,
    data: {
      symbol: 'BTC/USDT',
      last: '65000.00',
      bid: '64999.50',
      ask: '65000.50',
      open24h: null,
      high24h: null,
      low24h: null,
      change24h: null,
      changePct24h: null,
      baseVolume24h: null,
      quoteVolume24h: null,
      windowStart: null,
      source: 'server',
    },
  };
  return (
    <div className="if-desk vk-book">
      <BookPanel market={MARKET} book={book} ticker={ticker} zone="UTC" onPick={() => {}} onPickPrice={() => {}} />
    </div>
  );
}

// TEST figures, already formatted (a room gets these from packages/i18n's *ToParts formatters, from decimal strings).
const usdParts = (integer: string, fraction: string): FigurePart[] => [
  { type: 'currency', value: '$' },
  { type: 'integer', value: integer },
  { type: 'decimal', value: '.' },
  { type: 'fraction', value: fraction },
];

/**
 * The money parts the Money and Home rooms move onto (intafaced issue 9563): an asset's mark with its honest fallback,
 * the info tip, the hero figure shown, hidden and missing, the small-balances fold and the card stack. TEST figures.
 */
export function MoneyParts() {
  const [hidden, setHidden] = useState(false);
  return (
    <div className="vk-grid" data-kit="money-parts">
      <div className="vk-row">
        {(['BTC', 'ETH', 'USDT', 'USDC', 'XYZ'] as const).map((a) => (
          <AssetIcon key={a} asset={a} size="lg" label={a === 'XYZ' ? 'XYZ, an asset with no artwork' : undefined} />
        ))}
        <AssetIcon asset="BTC" />
        <AssetIcon asset="BTC" size="sm" />
      </div>
      <div className="vk-row">
        <HeroFigure parts={usdParts('12,468', '50')} hidden={hidden} hiddenLabel="Balance hidden" unknownLabel="Not available" test />
        <InfoTip
          label="About this number"
          text="TEST. Your cash and crypto at today's prices, in US dollars."
          side="end"
          data-testid="kit-tip"
        />
        <Button variant="ghost" size={32} onClick={() => setHidden((h) => !h)} aria-pressed={hidden}>
          Hide balances
        </Button>
      </div>
      <div className="vk-row">
        <HeroFigure parts={null} hiddenLabel="Balance hidden" unknownLabel="Not available" />
      </div>
      <Fold title="Small balances" count={3}>
        <ul className="vk-list">
          {[
            ['DOGE', '12.00 DOGE'],
            ['SHIB', '41,000 SHIB'],
            ['XYZ', '0.10 XYZ'],
          ].map(([asset, held]) => (
            <li key={asset} className="vk-list__row">
              <AssetIcon asset={asset!} />
              <span className="vk-list__name">
                <strong>{asset}</strong>
                <small>{held} · TEST</small>
              </span>
            </li>
          ))}
        </ul>
      </Fold>
      <div className="vk-object">
        <CardStack
          label="TEST holdings"
          back={{ label: 'Crypto', value: hidden ? '••••' : '$3,250.00', href: '/kit' }}
          front={{ label: 'Cash', value: hidden ? '••••' : '$9,218.50', href: '/kit' }}
        />
        <CardStackLoading />
      </div>
    </div>
  );
}

/** The parts the Pay room takes from the kit (issue 9563): the money box, the handle box, the person found, where a send
 * stands, and a confirmation toast. TEST figures and names. */
export function PayParts() {
  return (
    <ToastProvider closeLabel="Dismiss">
      <PayPartsBody />
    </ToastProvider>
  );
}

function PayPartsBody() {
  const [amount, setAmount] = useState('');
  const [handle, setHandle] = useState('mika');
  const [tab, setTab] = useState<'send' | 'receive' | 'request'>('send');
  const toast = useVoltToast();
  return (
    <div className="vk-grid" data-kit="pay-parts">
      <TabList
        label="Send or receive"
        items={[
          { value: 'send', label: 'Send' },
          { value: 'receive', label: 'Receive' },
          { value: 'request', label: 'Request' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <AmountField
        label="Amount to send"
        hideLabel
        size="hero"
        precision={2}
        value={amount}
        onChange={setAmount}
        unit={
          <>
            <AssetIcon asset="USDT" size="sm" />
            USDT
          </>
        }
        available="Available 9,218.50 USDT · TEST"
        max={{ label: 'Max', onSelect: () => setAmount('9218.50') }}
        data-testid="kit-amount"
      />
      <AmountField
        label="Amount with a refusal"
        precision={2}
        value="99999"
        onChange={() => undefined}
        unit="USDT"
        error="More than your 9,218.50 USDT balance. TEST."
      />
      <VoltField
        label="To"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        before="@"
        after={<VoltButton tone="quiet">Paste</VoltButton>}
        hint="Ask for their handle"
      />
      <div className="vk-row">
        <Payee face="Mika Tan" name="Mika Tan" handle="@mika" badge="Member since Nov 2026" confirmed data-testid="kit-payee" />
        <Payee face="@ana" handle="@ana" />
      </div>
      <StatusNote title="Still confirming" actions={<VoltButton>View activity</VoltButton>}>
        TEST. We are waiting for the bank to confirm this send. Nothing more will be sent.
      </StatusNote>
      <StatusNote tone="warn">TEST. Held for review. We will tell you when it moves.</StatusNote>
      <StatusNote tone="error" actions={<VoltButton tone="quiet">Try again</VoltButton>}>
        TEST. Recent payments could not load.
      </StatusNote>
      <div className="vk-row">
        <VoltButton data-kit="show-volt-toast" onClick={() => toast.add({ title: 'Link copied', description: 'TEST.', timeout: 0 })}>
          Show a confirmation
        </VoltButton>
      </div>
    </div>
  );
}
