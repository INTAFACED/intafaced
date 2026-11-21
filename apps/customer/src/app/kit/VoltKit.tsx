import { useState, type ReactNode } from 'react';
import {
  AmountInput,
  Badge,
  Button,
  ChangeText,
  CoinIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  HeroNumber,
  Money,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StateBlock,
  StatusTag,
  Table,
  useToast,
  type TableColumn,
} from '@intafaced/ui';
import { AreaChart, QuickSend, type Point } from '@intafaced/ui/lit/templates';
import { contrastRatio, deltaE2000, toHex } from '@intafaced/ui/lit';
import { VoltStack } from '../../screens/home/VoltStack';
import type { HomePortfolio } from '../../screens/home/deps';
import { MobileTabs } from '../TopBar';
import { useResolvedColours } from '../../shared/resolved-colours';
import './kit.css';

/**
 * The Volt kit (intafaced issue 9302): every building block of the app in the chosen look, on one page, for the owner's
 * one approval. At `/kit` (`?scheme=light` for the light values behind the scheme switch). Every block is the shipped component
 * drawn by the shipped role tokens; every figure and name is TEST sample data, marked as such.
 */

const TEST_PORTFOLIO: HomePortfolio = {
  totalUsd: '12468.50',
  change24hUsd: '420.69',
  change24hPct: '3.49',
  cashUsd: '9218.50',
  cryptoUsd: '3250.00',
  holdings: [
    { asset: 'USDT', class: 'cash', total: '9218.50', usdValue: '9218.50', usdChange24h: '0', share: '0.739', priceSymbol: null },
    { asset: 'BTC', class: 'crypto', total: '0.05', usdValue: '3250.00', usdChange24h: '420.69', share: '0.261', priceSymbol: 'BTC/USDT' },
  ],
  unpriced: [],
  source: 'server',
  asOf: 0,
};

// A month of TEST balance, one point a day, for the chart's shape only.
const TEST_SERIES: Point[] = [
  10120, 10240, 10180, 10410, 10390, 10620, 10580, 10840, 10760, 10990, 11240, 11120, 11380, 11290, 11560, 11720, 11640, 11880, 12040,
  11910, 12160, 12080, 12320, 12260, 12410, 12380, 12468.5,
].map((v, i) => ({ at: `2026-11-${String(i + 1).padStart(2, '0')}`, value: v.toFixed(2) }));

const TEST_PEOPLE = [
  { id: 'p1', name: 'Mika Tan', href: '/pay/send' },
  { id: 'p2', name: 'Ana Ruiz', href: '/pay/send' },
  { id: 'p3', name: 'Tom Hale', href: '/pay/send' },
  { id: 'p4', name: 'Sara Lind', href: '/pay/send' },
  { id: 'p5', name: 'Ola Berg', href: '/pay/send' },
];

type Order = { id: string; time: string; market: string; side: 'Buy' | 'Sell'; amount: string; status: 'filled' | 'working' | 'cancelled' };
const TEST_ORDERS: Order[] = [
  { id: 'o1', time: '21 Nov 14:02', market: 'BTC/USDT', side: 'Buy', amount: '0.0150 BTC', status: 'filled' },
  { id: 'o2', time: '21 Nov 11:47', market: 'ETH/USDT', side: 'Sell', amount: '0.4200 ETH', status: 'working' },
  { id: 'o3', time: '20 Nov 18:15', market: 'SOL/USDT', side: 'Buy', amount: '12.000 SOL', status: 'cancelled' },
];
const ORDER_COLUMNS: TableColumn<Order>[] = [
  { id: 'time', header: 'Time', value: (r) => r.time, width: '9rem' },
  { id: 'market', header: 'Market', value: (r) => r.market, width: '7.5rem' },
  { id: 'side', header: 'Side', value: (r) => r.side, width: '4.5rem' },
  { id: 'amount', header: 'Amount', value: (r) => r.amount, numeric: true, width: '8rem' },
  { id: 'status', header: 'Status', cell: (r) => <StatusTag status={r.status} />, align: 'end', width: '7rem' },
];

function Block({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="vk-block" aria-labelledby={`vk-${id}`} data-block={id}>
      <header className="vk-block__head">
        <h2 id={`vk-${id}`}>{title}</h2>
        {note ? <p>{note}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** The hex of a colour the browser resolved, or null when it reports one this page cannot read. */
function readHex(value: string): string | null {
  try {
    return toHex(value);
  } catch {
    return null;
  }
}

const SWATCHES = [
  ['page', 'Page'],
  ['solid-bg', 'Panel'],
  ['solid-bg-raised', 'Raised'],
  ['solid-bg-sunken', 'Well'],
  ['text-1', 'Ink'],
  ['text-2', 'Ink, second'],
  ['text-3', 'Ink, third'],
  ['accent', 'Spark'],
  ['accent-text', 'Spark as text'],
  ['up', 'Gain'],
  ['up-text', 'Gain as text'],
  ['down', 'Loss'],
  ['down-text', 'Loss as text'],
  ['warn-text', 'Warning'],
] as const;

const SWATCH_VALUES = SWATCHES.map(([role]) => `var(--lit-${role})`);

/** Each role, named and printed as the browser resolved it. */
function Swatches() {
  const { probe, colours } = useResolvedColours(SWATCH_VALUES, readHex);
  return (
    <ul className="vk-swatches">
      <span ref={probe} hidden />
      {SWATCHES.map(([role, name], i) => (
        <li key={role} className="vk-swatch">
          <span className="vk-swatch__chip" style={{ background: `var(--lit-${role})` }} />
          <span className="vk-swatch__name">{name}</span>
          <code>{colours?.[i] ?? '—'}</code>
        </li>
      ))}
    </ul>
  );
}

type Measure = { id: string; label: string; fg: string; bg: string; floor: number; sample: 'text' | 'fill' | 'ring' };
const MEASURES: Measure[] = [
  { id: 'text-page', label: 'Chartreuse as text on the page', fg: 'accent-text', bg: 'page', floor: 4.5, sample: 'text' },
  { id: 'text-panel', label: 'Chartreuse as text on a panel', fg: 'accent-text', bg: 'solid-bg', floor: 4.5, sample: 'text' },
  { id: 'fill', label: 'Ink on the chartreuse fill (top)', fg: 'on-accent', bg: 'accent-fill', floor: 4.5, sample: 'fill' },
  { id: 'fill-2', label: 'Ink on the chartreuse fill (bottom)', fg: 'on-accent', bg: 'accent-fill-2', floor: 4.5, sample: 'fill' },
  { id: 'ring', label: 'Chartreuse as a ring on the page', fg: 'accent-text', bg: 'page', floor: 3, sample: 'ring' },
  { id: 'focus', label: 'The focus ring on the page', fg: 'focus', bg: 'page', floor: 3, sample: 'ring' },
];

const MEASURED_ROLES = [
  'accent',
  'accent-text',
  'accent-fill',
  'accent-fill-2',
  'on-accent',
  'page',
  'solid-bg',
  'focus',
  'warn-text',
  'up',
] as const;

const MEASURED_VALUES = MEASURED_ROLES.map((r) => `var(--lit-${r})`);

function Contrast() {
  const resolved = useResolvedColours(MEASURED_VALUES, readHex);
  const { probe } = resolved;
  const colours: Record<string, string> = resolved.colours
    ? Object.fromEntries(MEASURED_ROLES.map((r, i) => [r, resolved.colours![i]!]))
    : {};
  const ready = resolved.colours !== null;
  return (
    <div className="vk-contrast">
      <span ref={probe} hidden />
      <table className="vk-measures">
        <caption className="vk-caption">Contrast of the chartreuse, measured in this browser</caption>
        <thead>
          <tr>
            <th scope="col">Use</th>
            <th scope="col">Sample</th>
            <th scope="col">Ratio</th>
            <th scope="col">AA floor</th>
          </tr>
        </thead>
        <tbody>
          {MEASURES.map((m) => {
            const ratio = ready ? contrastRatio(colours[m.fg]!, colours[m.bg]!) : null;
            return (
              <tr key={m.id} data-measure={m.id}>
                <th scope="row">{m.label}</th>
                <td>
                  <span
                    className="vk-sample"
                    data-sample={m.sample}
                    style={{ ['--fg' as string]: `var(--lit-${m.fg})`, ['--bg' as string]: `var(--lit-${m.bg})` }}
                  >
                    {m.sample === 'ring' ? '' : 'Aa 12.40'}
                  </span>
                </td>
                <td className="vk-num" data-pass={ratio !== null && ratio >= m.floor ? '' : undefined}>
                  {ratio === null ? '…' : `${ratio.toFixed(2)}:1`}
                </td>
                <td className="vk-num">{`${m.floor}:1 ${ratio !== null && ratio >= m.floor ? 'pass' : ''}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="vk-apart">
        <span className="vk-apart__chip" style={{ background: 'var(--lit-accent)' }}>
          Spark
        </span>
        <span className="vk-apart__chip" data-warn="" style={{ background: 'var(--lit-warn-text)' }}>
          Warning
        </span>
        <span className="vk-apart__chip" data-up="" style={{ background: 'var(--lit-up)' }}>
          Gain
        </span>
        <p>
          {ready
            ? `Colour difference (CIEDE2000; 20 and more reads as another colour): spark and warning ${deltaE2000(colours.accent!, colours['warn-text']!).toFixed(1)}, spark and gain ${deltaE2000(colours.accent!, colours.up!).toFixed(1)}.`
            : '…'}
        </p>
      </div>
    </div>
  );
}

function SheetAndToast() {
  const toast = useToast();
  return (
    <div className="vk-row">
      <Dialog>
        <DialogTrigger render={<Button variant="secondary" size={40} data-kit="open-sheet" />}>Open the sheet</DialogTrigger>
        <DialogContent closeLabel="Close">
          <DialogHeader>
            <DialogTitle>Send 250.00 USDT to Mika Tan</DialogTitle>
            <DialogDescription>TEST. Arrives in about a minute. The fee is shown before you confirm.</DialogDescription>
          </DialogHeader>
          <dl className="vk-kv">
            <div>
              <dt>Amount</dt>
              <dd>250.00 USDT</dd>
            </div>
            <div>
              <dt>Fee</dt>
              <dd>0.00 USDT</dd>
            </div>
          </dl>
          <DialogFooter>
            <Button variant="primary" size={48}>
              Send 250.00 USDT
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button
        variant="ghost"
        size={40}
        data-kit="show-toast"
        onClick={() => toast.add({ title: 'Sent 250.00 USDT to Mika Tan', description: 'TEST. Receipt in Activity.', timeout: 0 })}
      >
        Show a toast
      </Button>
    </div>
  );
}

export default function VoltKit() {
  const [range, setRange] = useState('1M');
  const [amount, setAmount] = useState('100');
  const [payWith, setPayWith] = useState<string | null>('USDT');
  return (
    <div className="vk" data-testid="volt-kit">
      <header className="vk-head">
        <p className="vk-eyebrow">Volt kit · TEST figures</p>
        <h1>Every building block, in Volt</h1>
        <p>
          The shipped components, drawn by the shipped tokens. One chartreuse spark on a heavy tinted black, phone first, in dark and in
          light.
        </p>
      </header>

      <Block id="colour" title="Colour roles" note="Stone and ink do the work; the chartreuse is the one spark on a screen.">
        <Swatches />
        <Contrast />
      </Block>

      <Block id="type" title="Type" note="Figures in Archivo at its widest; words in Archivo at its normal width.">
        <dl className="vk-type">
          {(
            [
              ['Figure', 'Archivo, widest, 600', <p className="vk-type__figure">$12,468.50</p>],
              ['Title', 'Archivo, 600', <p className="vk-type__title">Buy crypto in a few steps</p>],
              ['Heading', 'Archivo, 600', <p className="vk-type__heading">Recent activity</p>],
              ['Body', 'Archivo, 400', <p className="vk-type__body">Bitcoin, Ether and more, paid from your USDT or USDC balance.</p>],
              ['Label', 'Archivo, capitals, tracked', <p className="vk-type__micro">Est. total value</p>],
            ] as const
          ).map(([name, spec, sample]) => (
            <div key={name} className="vk-type__row">
              <dt>
                <strong>{name}</strong>
                <small>{spec}</small>
              </dt>
              <dd>{sample}</dd>
            </div>
          ))}
        </dl>
      </Block>

      <Block id="balance" title="The big balance" note="Heavy and wide, its cents a step back.">
        <div className="home-total vk-balance">
          <HeroNumber value="12468.50" decimals={2} prefix="$" />
          <Badge tone="neutral">TEST</Badge>
        </div>
        <ChangeText value="+420.69" suffix=" (+3.49%) today" />
      </Block>

      <Block id="object" title="The money object" note="Cash as matte black metal in front, crypto lit behind it.">
        <div className="vk-object">
          <figure className="vk-state">
            <figcaption>Ready</figcaption>
            <VoltStack portfolio={{ status: 'ready', data: TEST_PORTFOLIO, asOf: 0 }} hidden={false} />
          </figure>
          <figure className="vk-state">
            <figcaption>Loading</figcaption>
            <VoltStack portfolio={{ status: 'loading' }} hidden={false} />
          </figure>
        </div>
      </Block>

      <Block id="buttons" title="Buttons" note="One primary per view. Every variant at rest, disabled and busy.">
        <div className="vk-grid">
          <div className="vk-row">
            <Button variant="primary" size={48}>
              Review buy
            </Button>
            <Button variant="secondary" size={48}>
              Add money
            </Button>
            <Button variant="ghost" size={48}>
              Not now
            </Button>
          </div>
          <div className="vk-row">
            <Button variant="primary" size={40} disabled>
              Review buy
            </Button>
            <Button variant="secondary" size={40} disabled>
              Add money
            </Button>
            <Button variant="secondary" size={40} loading>
              Sending
            </Button>
          </div>
          <div className="vk-row">
            <Button variant="buy" size={40}>
              Buy BTC
            </Button>
            <Button variant="sell" size={40}>
              Sell BTC
            </Button>
          </div>
          <div className="if-home vk-keys">
            <nav className="home-actions" aria-label="Action keys">
              {['Buy', 'Sell', 'Convert', 'Send', 'Receive'].map((label, i) => (
                <Button key={label} variant={i === 0 ? 'primary' : 'secondary'} size={40}>
                  {label}
                </Button>
              ))}
            </nav>
          </div>
        </div>
      </Block>

      <Block id="inputs" title="Inputs" note="The amount you type, and what you pay with.">
        <div className="vk-inputs vk-panel">
          <AmountInput
            label="Amount in USD"
            unit="USD"
            precision={2}
            size="hero"
            value={amount}
            onValueChange={setAmount}
            onMax={() => setAmount('9218.50')}
            maxLabel="Max"
          />
          <label className="vk-select">
            <span>Pay with</span>
            <Select
              items={{ USDT: 'USDT balance', USDC: 'USDC balance' }}
              value={payWith}
              onValueChange={(v) => setPayWith(v as string | null)}
            >
              <SelectTrigger aria-label="Pay with">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USDT">USDT balance</SelectItem>
                <SelectItem value="USDC">USDC balance</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <AmountInput
            label="Amount with an error"
            unit="USDT"
            precision={2}
            value="99999"
            onValueChange={() => {}}
            error="More than your 9,218.50 USDT balance."
          />
        </div>
      </Block>

      <Block id="rows" title="Rows, lists, a table and tags">
        <ul className="vk-list">
          {[
            { asset: 'BTC', name: 'Bitcoin', held: '0.0500 BTC', value: '$3,250.00', change: '+2.41%' },
            { asset: 'ETH', name: 'Ether', held: '0.4200 ETH', value: '$1,302.84', change: '-0.86%' },
            { asset: 'USDT', name: 'Tether USD', held: '9,218.50 USDT', value: '$9,218.50', change: '0.00%' },
          ].map((r) => (
            <li key={r.asset} className="vk-list__row">
              <CoinIcon asset={r.asset} size={40} />
              <span className="vk-list__name">
                <strong>{r.name}</strong>
                <small>{r.held}</small>
              </span>
              <span className="vk-list__value">
                <Money value={r.value} />
                <ChangeText value={r.change} />
              </span>
            </li>
          ))}
        </ul>
        <div className="vk-table">
          <Table label="TEST orders" columns={ORDER_COLUMNS} rows={TEST_ORDERS} getRowId={(r) => r.id} minWidth="36rem" />
        </div>
        <p className="vk-table-note">On a phone the table scrolls sideways; the last columns sit past the edge.</p>
        <div className="vk-row">
          <Badge tone="neutral">TEST</Badge>
          <Badge tone="lime">New</Badge>
          <Badge tone="up">+3.49%</Badge>
          <Badge tone="down">-0.86%</Badge>
          <Badge tone="warn">Check needed</Badge>
          <Badge tone="error">Refused</Badge>
          <StatusTag status="filled" />
          <StatusTag status="working" />
          <StatusTag status="pending" />
          <StatusTag status="failed" />
        </div>
      </Block>

      <Block
        id="bars"
        title="The tab bar and the top bar"
        note="The top bar is this page's own, above. On a phone the pill tab bar floats at the foot of the screen."
      >
        <div className="vk-tabbar">
          <MobileTabs door="Home" language="en" />
        </div>
      </Block>

      <Block id="chart" title="Balance over time" note="One line in the spark, a soft fill under it. New.">
        <div className="vk-chart">
          <div className="vk-chart__head">
            <div>
              <p className="vk-type__micro">Total balance</p>
              <p className="vk-chart__figure">
                <Money value="$12,468.50" />
              </p>
            </div>
            <SegmentedControl
              aria-label="Range"
              size={32}
              value={range}
              onValueChange={setRange}
              items={['1D', '1W', '1M', '1Y'].map((v) => ({ value: v, label: v }))}
            />
          </div>
          <AreaChart soft label="TEST balance, November 2026" asset="USD" points={TEST_SERIES} live />
          <p className="vk-chart__axis" aria-hidden="true">
            <span>1 Nov</span>
            <span>8 Nov</span>
            <span>15 Nov</span>
            <span>21 Nov</span>
          </p>
        </div>
      </Block>

      <Block id="people" title="Quick send" note="The people you send to most, a tap away. New.">
        <QuickSend label="Quick send" people={TEST_PEOPLE} add={{ label: 'Add new', href: '/pay/send' }} />
      </Block>

      <Block id="states" title="Empty, loading and error">
        <div className="vk-states">
          <div className="vk-panel">
            <StateBlock
              kind="empty"
              title="No activity yet"
              body="Your buys, sends and deposits show here."
              action={{ label: 'Add money' }}
            />
          </div>
          <div className="vk-panel">
            <StateBlock kind="loading" rows={3} rowHeight={40} label="Loading" />
          </div>
          <div className="vk-panel">
            <StateBlock kind="error" thing="your balances" onRetry={() => {}} />
          </div>
        </div>
      </Block>

      <Block id="sheet" title="A sheet, and a toast" note="On a phone the sheet rises from the foot; on a computer it is a centred panel.">
        <SheetAndToast />
      </Block>
    </div>
  );
}
