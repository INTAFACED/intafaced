/**
 * TEST rooms for the templates gallery: one strong example of each template in every state. Every figure is
 * illustrative and labelled TEST; amounts are decimal strings shaped as `packages/contracts` sends them
 * (`fixtures.test.ts` parses the holdings with the ledger's schema). Dev tool only.
 */
import * as React from 'react';
import { AreaChart, Bars, LineChart, Parts } from '../../components/b2-charts.js';
import { EqualChoice, KeyValue, Segmented, StatusChip, Tabs } from '../../components/b2-basics.js';
import { Table } from '../../components/b2-table.js';
import { Receipt } from '../frame.js';
import { formatMoney } from '../money.js';
import {
  CatalogueTemplate,
  DeskTemplate,
  FlowTemplate,
  MonitorTemplate,
  OverviewTemplate,
  ReadingTemplate,
  RecordListTemplate,
  SettingsTemplate,
} from '../templates.js';
import type { Mode, TemplateId } from '../../contracts.js';
import type { Market, Movement, Refusal, RegionHolds, ReviewData, RoomState } from '../types.js';
import { t } from './copy.js';

export const galleryStates = [
  'ready',
  'stale',
  'partial',
  'loading',
  'empty',
  'refused',
  'gated',
  'money-status',
  'confirm',
  'receipt',
] as const;
export type GalleryState = (typeof galleryStates)[number];

/** The clock every gallery frame uses, so shots repeat byte for byte. */
export const NOW = new Date('2026-10-26T10:47:00Z');

export const HOLDINGS = [
  { assetId: 'GBP', amount: '5460.12' },
  { assetId: 'BTC', amount: '0.0712' },
  { assetId: 'ETH', amount: '0.8' },
  { assetId: 'USDC', amount: '1250.00' },
] as const;

const gbp = (value: string) => ({ value, asset: 'GBP', test: true });

const SENT: Movement = {
  id: 'mv-1',
  title: 'Sent to Aisha Khan',
  direction: 'out',
  amount: gbp('250.00'),
  counterparty: 'to Aisha Khan',
  status: 'pending',
  steps: [
    { label: 'Sent', at: '2026-10-26T10:42:00Z', state: 'done' },
    { label: 'Bank confirmed', state: 'current' },
    { label: 'Arrived', state: 'todo' },
  ],
  reference: 'LGR-7Q2-4F2',
  expectedBy: '2026-10-26T12:00:00Z',
  next: 'Most payments arrive within 2 hours. We’ll tell you when it lands.',
};

const RETURNED: Movement = {
  id: 'mv-2',
  title: 'ETH withdrawal',
  direction: 'out',
  amount: { value: '0.1', asset: 'ETH', test: true },
  counterparty: 'to 0x9f3c…a1b2',
  status: 'failed',
  returned: true,
  steps: [
    { label: 'Requested', at: '2026-10-26T10:40:00Z', state: 'done' },
    { label: 'Sent to network', at: '2026-10-26T10:44:00Z', state: 'failed' },
    { label: 'Returned', at: '2026-10-26T10:51:00Z', state: 'done' },
  ],
  whereNow: 'The 0.1 ETH came back to your balance at 10:51. Nothing was lost.',
  reference: 'LGR-9C1-0AE',
  next: 'You can try again. Check the address first: the network refused this one.',
};

const BOUGHT: Movement = {
  id: 'mv-3',
  title: 'Bought Bitcoin',
  direction: 'move',
  amount: { value: '0.00123395', asset: 'BTC', test: true },
  counterparty: 'for £100.50',
  status: 'pending',
  steps: [
    { label: 'Order placed', at: '2026-10-26T10:45:00Z', state: 'done' },
    { label: 'Filled', state: 'current' },
    { label: 'In your balance', state: 'todo' },
  ],
  reference: 'LGR-4B8-77C',
  next: 'It shows in your balance as soon as the order fills, usually within a minute.',
};

const BOUGHT_DONE: Movement = {
  ...BOUGHT,
  status: 'done',
  steps: [
    { label: 'Order placed', at: '2026-10-26T10:45:00Z', state: 'done' },
    { label: 'Filled', at: '2026-10-26T10:45:00Z', state: 'done' },
    { label: 'In your balance', at: '2026-10-26T10:45:00Z', state: 'done' },
  ],
  next: 'It’s in your balance now.',
};

const ORDER: Movement = {
  id: 'mv-4',
  title: 'Buy 0.01 BTC',
  direction: 'move',
  amount: { value: '0.01', asset: 'BTC', test: true },
  counterparty: 'at 81,040.00 USDT, total 811.21 USDT',
  status: 'pending',
  steps: [
    { label: 'Placed', at: '2026-10-26T10:46:00Z', state: 'done' },
    { label: 'Filling', state: 'current' },
    { label: 'Filled', state: 'todo' },
  ],
  reference: 'LGR-0D5-31A',
  next: 'A limit order waits in the book until the price reaches it. You can cancel it from Orders.',
};

const ORDER_DONE: Movement = {
  ...ORDER,
  status: 'done',
  steps: [
    { label: 'Placed', at: '2026-10-26T10:46:00Z', state: 'done' },
    { label: 'Filling', at: '2026-10-26T10:46:00Z', state: 'done' },
    { label: 'Filled', at: '2026-10-26T10:46:00Z', state: 'done' },
  ],
  next: 'The 0.01 BTC is in your spot balance.',
};

const EARNING: Movement = {
  id: 'mv-5',
  title: 'Into USDC flexible',
  direction: 'move',
  amount: { value: '500.00', asset: 'USDC', test: true },
  counterparty: 'at 3.10% a year',
  status: 'pending',
  steps: [
    { label: 'Requested', at: '2026-10-26T10:46:00Z', state: 'done' },
    { label: 'Earning', state: 'current' },
  ],
  reference: 'LGR-2E7-905',
  next: 'Rewards start tomorrow. You can take it out at any time.',
};

const EARNING_DONE: Movement = {
  ...EARNING,
  status: 'done',
  steps: [
    { label: 'Requested', at: '2026-10-26T10:46:00Z', state: 'done' },
    { label: 'Earning', at: '2026-10-26T10:46:00Z', state: 'done' },
  ],
  next: 'It’s earning now. Rewards are paid daily.',
};

const REVIEW: ReviewData = {
  lines: [
    { label: 'You send', value: gbp('250.00') },
    { label: 'Fee', value: gbp('0.00'), note: 'Faster Payments' },
  ],
  total: { label: 'Total', value: gbp('250.00') },
  recipientGets: { label: 'Aisha Khan gets', value: gbp('250.00') },
  arrival: { label: 'Arrives', value: 'Usually within 2 hours' },
  confirmLabel: 'Send £250.00 to Aisha Khan',
  missing: {
    variant: 'refused',
    title: 'Can’t send yet',
    body: 'The fee for this payment isn’t set, so the total can’t be shown.',
    reference: 'Ref fee.unset',
  },
};

const REVIEW_BLANK: ReviewData = {
  ...REVIEW,
  lines: [REVIEW.lines[0]!, { label: 'Fee', value: null }],
};

/** Buying from your own balance: no money leaves to someone else, so no scam warning; the band carries the risk. */
const REVIEW_BUY: ReviewData = {
  lines: [
    { label: 'You pay', value: gbp('100.00') },
    { label: 'Price', value: '£81,040.00 per BTC, TEST', note: 'Holds for 30 seconds' },
    { label: 'Fee', value: gbp('0.50') },
  ],
  total: { label: 'Total', value: gbp('100.50') },
  recipientGets: { label: 'You get', value: { value: '0.00123395', asset: 'BTC', test: true } },
  confirmLabel: 'Buy 0.00123395 BTC for £100.50',
  missing: { variant: 'refused', title: 'Can’t buy yet', body: 'The fee isn’t set, so the total can’t be shown.' },
  legal: [],
};

const REVIEW_ORDER: ReviewData = {
  lines: [
    { label: 'Buy', value: { value: '0.01', asset: 'BTC', test: true } },
    { label: 'Limit price', value: { value: '81040.00', asset: 'USDT', test: true } },
    { label: 'Fee', value: { value: '0.81', asset: 'USDT', test: true }, note: '0.10% of 810.40 USDT' },
  ],
  total: { label: 'Total', value: { value: '811.21', asset: 'USDT', test: true } },
  confirmLabel: 'Place order: buy 0.01 BTC',
  missing: { variant: 'refused', title: 'Can’t place this order yet', body: 'The fee isn’t set.' },
  legal: [],
};

const REVIEW_EARN: ReviewData = {
  lines: [
    { label: 'You put in', value: { value: '500.00', asset: 'USDC', test: true } },
    { label: 'Rate', value: '3.10% a year, TEST', note: 'Changes daily; never guaranteed' },
    { label: 'Fee', value: { value: '0.00', asset: 'USDC', test: true } },
  ],
  total: { label: 'Total', value: { value: '500.00', asset: 'USDC', test: true } },
  arrival: { label: 'Leaving', value: 'At any time' },
  confirmLabel: 'Put 500.00 USDC in USDC flexible',
  missing: { variant: 'refused', title: 'Can’t start yet', body: 'The rate isn’t set.' },
  legal: [],
};

const parked = (title: string, body: string, ref: string, action?: Refusal['action']): Refusal => ({
  variant: 'parked',
  title,
  body,
  reference: `Ref ${ref}`,
  action,
});

const GATE: Refusal = {
  variant: 'refused',
  title: 'Verify your identity to send and buy',
  body: 'Your account stays as it is until then.',
  action: { label: 'Verify now', href: '#verify' },
};

const PRICES_DOWN: Refusal = {
  variant: 'unreachable',
  title: 'Crypto prices are unavailable right now',
  body: 'Your crypto isn’t in the total until prices come back. Holdings: 0.0712 BTC, 0.8 ETH, 1,250.00 USDC.',
  reference: 'Ref prices.down',
};

const BTC_PRICE_DOWN: Refusal = {
  variant: 'unreachable',
  title: 'The Bitcoin price is unavailable right now',
  body: 'Buying and selling pause until it’s back. What you hold is safe: 0.0712 BTC.',
  reference: 'Ref prices.down',
};

/** What one gallery room says in each state: its own copy, never another room's. */
interface RoomCopy {
  empty: { title: string; body?: string; action?: { label: string; href: string } };
  refused: Refusal;
  partial: { missing: Refusal; regions?: RegionHolds };
  staleRegions?: RegionHolds;
  review?: ReviewData;
  status?: Movement;
  receipt?: Movement;
}

function stateFor(kind: GalleryState, copy: RoomCopy): RoomState {
  switch (kind) {
    case 'ready':
      return { kind: 'ready' };
    case 'stale':
      return { kind: 'ready', stale: { asOf: '2026-10-26T10:43:00Z', onRefresh: () => {}, regions: copy.staleRegions } };
    case 'partial':
      return { kind: 'ready', partial: copy.partial };
    case 'loading':
      return { kind: 'loading' };
    case 'empty':
      return { kind: 'empty', ...copy.empty };
    case 'refused':
      return { kind: 'refused', refusal: copy.refused };
    case 'gated':
      return { kind: 'gated', gate: 'not-verified', refusal: GATE };
    case 'money-status':
      return { kind: 'money-status', movement: copy.status ?? RETURNED };
    case 'confirm':
      return { kind: 'confirm', review: copy.review ?? REVIEW };
    case 'receipt':
      return { kind: 'receipt', movement: copy.receipt ?? SENT };
  }
}

function Test() {
  return <span className="lt-test">TEST</span>;
}

/** A row value that is an illustrative figure: the figure and its TEST label stay together. */
function tv(value: string, dir?: 'up' | 'down') {
  return (
    <>
      <bdi dir="ltr" data-dir={dir}>
        {value}
      </bdi>{' '}
      <Test />
    </>
  );
}

function Money({ value, asset = 'GBP', hero = false }: { value: string; asset?: string; hero?: boolean }) {
  return (
    <p className={hero ? 'lt-figure lt-figure-hero' : 'lt-figure'}>
      <bdi dir="ltr">{formatMoney({ value, asset })}</bdi> <Test />
    </p>
  );
}

function Keys({ labels }: { labels: readonly string[] }) {
  return (
    <div className="lt-actions" data-gallery="keys">
      {labels.map((l, i) => (
        <a key={l} className={i === 0 ? 'lt-button lt-button-primary' : 'lt-button lt-button-secondary'} href={`#${l}`}>
          {t(l)}
        </a>
      ))}
    </div>
  );
}

function Rows({ rows }: { rows: readonly [string, React.ReactNode, string?][] }) {
  return <KeyValue rows={rows.map(([label, value, note]) => ({ label: t(label), value, note }))} />;
}

function H({ children }: { children: string }) {
  return <h2 className="gallery-h">{t(children)}</h2>;
}

const series = (base: number, n = 24, amp = 0.04) =>
  Array.from({ length: n }, (_, i) => ({
    at: `2026-10-${String(2 + i).padStart(2, '0')}`,
    // TEST curve: a fixed shape, no randomness, so shots repeat.
    value: (base * (1 + amp * Math.sin(i / 2.3) + (amp / 2) * Math.cos(i / 1.1) + (i * amp) / n)).toFixed(2),
  }));

/** Drawing only: a line's colour says which way it went over the period it shows. */
const toneOf = (points: readonly { value: string }[]) =>
  parseFloat(points[points.length - 1]!.value) >= parseFloat(points[0]!.value) ? ('up' as const) : ('down' as const);

interface Ctx {
  mode: Mode;
  state: GalleryState;
  market: Market;
}

function base(c: Ctx, title: string, legal: RoomStateExtras = {}) {
  return {
    title: t(title),
    mode: c.mode,
    market: c.market,
    notices: legal.notices,
    inFlight: c.state === 'ready' || c.state === 'stale' ? [SENT] : [],
    legal: legal.legal,
    onRiskSummary: () => {},
    now: NOW,
  };
}

type RoomStateExtras = {
  legal?: Parameters<typeof OverviewTemplate>[0]['legal'];
  notices?: Parameters<typeof OverviewTemplate>[0]['notices'];
};

// ---- the eight rooms ----------------------------------------------------------------------------------------

function Overview(c: Ctx) {
  const partial = c.state === 'partial';
  return (
    <OverviewTemplate
      {...base(c, 'Home', { legal: ['crypto-risk-band'] })}
      state={stateFor(c.state, {
        empty: {
          title: t('Your balance is £0.00'),
          body: t('Add money to get started. Nothing is charged to look around.'),
          action: { label: 'Add money', href: '#add' },
        },
        refused: parked(
          t('Your balance can’t be shown yet'),
          t('Home isn’t connected to your account yet. Your money is safe, and nothing has moved.'),
          'home.ledger',
        ),
        partial: { missing: PRICES_DOWN, regions: { watching: t('Prices unavailable') } },
      })}
      hero={
        <>
          <p className="gallery-label">{t(partial ? 'Your cash' : 'Your money')}</p>
          <Money value={partial ? '5460.12' : '12480.36'} hero />
          {partial ? null : (
            <Parts
              label="Your money by protection"
              total="12480.36"
              asset="GBP"
              parts={[
                { label: t('Cash, protected by FSCS'), value: '5460.12' },
                { label: t('Crypto, not protected'), value: '5770.24' },
                { label: t('Stablecoins, not protected'), value: '1250.00' },
              ]}
            />
          )}
        </>
      }
      actions={<Keys labels={['Add', 'Send', 'Buy', 'Swap']} />}
      needsYou={
        <>
          <H>Needs you</H>
          <Rows
            rows={[
              ['Confirm your email', 'Do it now'],
              ['Add a backup passkey', '2 of 3 done'],
            ]}
          />
        </>
      }
      sections={
        <>
          <H>Recent activity</H>
          <Rows
            rows={[
              ['Card top-up', tv('+£200.00', 'up')],
              ['Aisha Khan', tv('−£250.00', 'down')],
              ['Bitcoin', tv('−£150.00', 'down')],
            ]}
          />
        </>
      }
      pro={
        <>
          <H>Value, last 24 days</H>
          <AreaChart label="Total value, last 24 days, TEST" points={series(12000)} asset="GBP" tone={toneOf(series(12000))} />
          <Test />
        </>
      }
      watching={
        <>
          <H>Watching</H>
          <Rows
            rows={[
              ['BTC', tv('£81,040.00')],
              ['ETH', tv('£2,914.50')],
            ]}
          />
        </>
      }
      rooms={
        <Tabs
          label="Home rooms"
          current="#home"
          items={[
            { label: t('Overview'), href: '#home' },
            { label: t('Notifications'), href: '#n' },
            { label: t('Coin'), href: '#c' },
          ]}
        />
      }
    />
  );
}

const ACTIVITY = [
  // The same movement as the status card: the original amount, one status, newest first, and no direction colour
  // (it left and came back, as its card says).
  {
    id: '5',
    date: '26 Oct',
    what: 'ETH withdrawal',
    type: 'Withdraw',
    status: 'failed' as const,
    amount: '-0.1',
    asset: 'ETH',
    ref: 'LGR-9C1-0AE',
  },
  {
    id: '1',
    date: '26 Oct',
    what: 'Card top-up',
    type: 'Add money',
    status: 'done' as const,
    amount: '200.00',
    asset: 'GBP',
    ref: 'LGR-1A2-001',
  },
  {
    id: '2',
    date: '25 Oct',
    what: 'Aisha Khan',
    type: 'Send',
    status: 'pending' as const,
    amount: '-250.00',
    asset: 'GBP',
    ref: 'LGR-7Q2-4F2',
  },
  { id: '3', date: '24 Oct', what: 'Bitcoin', type: 'Buy', status: 'done' as const, amount: '-150.00', asset: 'GBP', ref: 'LGR-3B4-118' },
  { id: '4', date: '23 Oct', what: 'Savings', type: 'Move', status: 'done' as const, amount: '-50.00', asset: 'GBP', ref: 'LGR-8D1-220' },
];

function RecordList(c: Ctx) {
  return (
    <RecordListTemplate
      {...base(c, 'Activity')}
      state={stateFor(c.state, {
        empty: { title: t('No activity yet'), body: t('Your payments will show here.'), action: { label: 'Add money', href: '#add' } },
        refused: parked(
          t('Your activity can’t load yet'),
          t('The statement service isn’t connected yet. Every payment is still recorded, and will show here once it is.'),
          'activity.statements',
        ),
        partial: {
          missing: {
            variant: 'unreachable',
            title: t('Payment details can’t load right now'),
            body: t('The list is complete. Each payment’s details will come back shortly.'),
            reference: 'Ref activity.detail',
          },
          regions: { detail: t('Details unavailable') },
        },
      })}
      filters={
        <div className="lt-actions">
          {['All types', 'Last 30 days', 'Any status'].map((f) => (
            <button key={f} type="button" className="lt-button lt-button-secondary">
              {t(f)}
            </button>
          ))}
        </div>
      }
      tools={
        <button type="button" className="lt-button lt-button-secondary">
          {t('Columns')}
        </button>
      }
      export={
        <button type="button" className="lt-button lt-button-secondary">
          {t('Export')}
        </button>
      }
      list={
        <>
          <Table
            caption="Activity, TEST"
            mode={c.mode}
            rows={ACTIVITY}
            rowKey={(r) => r.id}
            rowHref={(r) => `#activity/${r.id}`}
            selected="2"
            columns={[
              { key: 'date', label: t('Date'), cell: (r) => r.date },
              { key: 'what', label: t('What'), cell: (r) => t(r.what) },
              { key: 'type', label: t('Type'), cell: (r) => t(r.type), pro: true },
              {
                key: 'status',
                label: t('Status'),
                cell: (r) => (
                  <StatusChip
                    status={r.status}
                    returned={r.status === 'failed'}
                    label={r.status === 'failed' ? t('Returned') : undefined}
                  />
                ),
              },
              { key: 'ref', label: t('Ledger ref'), cell: (r) => r.ref, pro: true, ltr: true },
              {
                key: 'amount',
                label: t('Amount'),
                cell: (r) => (
                  <span data-dir={r.status === 'failed' ? undefined : r.amount.startsWith('-') ? 'down' : 'up'}>
                    {formatMoney({ value: r.amount, asset: r.asset }, { signed: true })}
                  </span>
                ),
                align: 'end',
                ltr: true,
              },
            ]}
          />
          <Test />
        </>
      }
      detail={<Receipt movement={SENT} />}
    />
  );
}

function Monitor(c: Ctx) {
  const price = series(80000, 24, 0.05);
  return (
    <MonitorTemplate
      {...base(c, 'Bitcoin', { legal: ['crypto-risk-band'] })}
      state={stateFor(c.state, {
        empty: {
          title: t('You don’t hold any Bitcoin'),
          body: t('Buy some to see your position here.'),
          action: { label: 'Buy Bitcoin', href: '#buy' },
        },
        refused: parked(
          t('Bitcoin isn’t open yet'),
          t('Buying and selling Bitcoin opens when our crypto partner is switched on in your region.'),
          'rail.crypto',
        ),
        partial: {
          missing: BTC_PRICE_DOWN,
          regions: {
            figures: t('Price unavailable'),
            chart: t('Chart unavailable until the price is back'),
            actions: t('Buying and selling pause until the price is back'),
          },
        },
        staleRegions: { actions: t('Refresh the price to buy or sell') },
        review: REVIEW_BUY,
        status: BOUGHT,
        receipt: BOUGHT_DONE,
      })}
      figures={[
        <>
          <p className="gallery-label">{t('Price')}</p>
          <Money value="81040.00" />
          <span className="gallery-change" data-dir="up">
            <bdi dir="ltr">+2.14%</bdi> {t('today')}
          </span>
        </>,
        <>
          <p className="gallery-label">{t('You hold')}</p>
          <Money value="0.0712" asset="BTC" />
        </>,
        <>
          <p className="gallery-label">{t('Worth')}</p>
          <Money value="5770.05" />
        </>,
        <>
          <p className="gallery-label">{t('24h volume')}</p>
          <Money value="1438200000.00" />
        </>,
      ]}
      actions={<EqualChoice choices={[{ label: t('Buy') }, { label: t('Sell') }]} />}
      chart={
        <>
          <p className="gallery-label">
            {t('Price, last 24 days')} <Test />
          </p>
          <LineChart label="Bitcoin price, last 24 days, TEST" points={price} asset="GBP" tone={toneOf(price)} live={c.state === 'ready'} />
        </>
      }
      pro={
        <>
          <p className="gallery-label">
            {t('Daily volume, last 14 days')} <Test />
          </p>
          <Bars label="Daily volume, TEST" asset="GBP" bars={series(1.4e9, 14, 0.3).map((p) => ({ label: p.at, value: p.value }))} />
        </>
      }
      panels={
        <>
          <H>About Bitcoin</H>
          <Rows
            rows={[
              ['Network', 'Bitcoin'],
              ['Typical withdrawal time', '30 to 60 minutes'],
            ]}
          />
        </>
      }
      explain={
        <p>
          {t(
            'The price is what one Bitcoin costs in pounds now. What you hold is worth that price times your amount; it changes when the price does.',
          )}
        </p>
      }
      related={
        <>
          <H>Documents</H>
          <Rows
            rows={[
              ['White paper', 'Open'],
              ['Sustainability', 'Open'],
            ]}
          />
        </>
      }
    />
  );
}

function Flow(c: Ctx) {
  return (
    <FlowTemplate
      {...base(c, 'Send money')}
      state={stateFor(c.state, {
        empty: {
          title: t('No one to send to yet'),
          body: t('Add a payee to send money.'),
          action: { label: 'Add a payee', href: '#payee' },
        },
        refused: parked(
          t('Bank transfers aren’t connected yet'),
          t('We can’t send to bank accounts until our banking partner is switched on. Sending to another account here still works.'),
          'rail.bank',
          { label: t('Send to an account here'), href: '#internal' },
        ),
        partial: {
          missing: {
            variant: 'unreachable',
            title: t('We can’t check the payee’s name right now'),
            body: t('You can still send. Before you confirm, we’ll show that the name wasn’t checked.'),
            reference: 'Ref payee-check.down',
          },
          regions: { step: t('Name check unavailable') },
        },
        review: c.state === 'refused' ? REVIEW_BLANK : REVIEW,
        status: RETURNED,
        receipt: SENT,
      })}
      steps={{ labels: [t('Who and how much'), t('Payee check'), t('Purpose'), t('Review')], current: 1 }}
      step={
        <>
          <H>Payee check</H>
          <p>{t('The name on the account matches Aisha Khan.')}</p>
          <StatusChip status="done" label={t('Name matches')} />
          <div className="gallery-gap">
            <Money value="250.00" hero />
          </div>
        </>
      }
      advanced={
        <Rows
          rows={[
            ['Schedule', 'Send now'],
            ['Reference', 'Rent'],
          ]}
        />
      }
      actions={
        <div className="lt-actions">
          <button type="button" className="lt-button lt-button-secondary">
            {t('Back')}
          </button>
          <button type="button" className="lt-button lt-button-primary">
            {t('Continue')}
          </button>
        </div>
      }
      summary={
        <>
          <H>Summary</H>
          <Rows
            rows={[
              ['To', 'Aisha Khan'],
              ['Amount', tv('£250.00')],
              ['Fee', tv('£0.00')],
            ]}
          />
        </>
      }
      help={
        <a className="lt-link" href="#help">
          {t('Talk to a person')}
        </a>
      }
    />
  );
}

function Settings(c: Ctx) {
  const partial = c.state === 'partial';
  return (
    <SettingsTemplate
      {...base(c, 'API keys')}
      state={stateFor(c.state, {
        empty: {
          title: t('No API keys yet'),
          body: t('Create a key to connect a trading tool. Each key does only what you allow.'),
          action: { label: 'Create a key', href: '#create' },
        },
        refused: parked(
          t('API keys aren’t available yet'),
          t('The developer API opens when it passes its security review. Your account works as usual without it.'),
          'api.review',
        ),
        partial: {
          missing: {
            variant: 'unreachable',
            title: t('Key activity can’t load right now'),
            body: t('Your keys and what they can do are shown. When each was last used will come back shortly.'),
            reference: 'Ref api.activity',
          },
        },
      })}
      index={
        <nav aria-label="Settings sections" className="gallery-index lt-scroll-row">
          {['Profile', 'Security', 'API keys', 'Display', 'Notifications', 'Limits'].map((s) => (
            <a key={s} href={`#${s}`} aria-current={s === 'API keys' ? 'page' : undefined}>
              {t(s)}
            </a>
          ))}
        </nav>
      }
      sections={
        <>
          <H>Your keys</H>
          <Rows
            rows={[
              ['Trading key', 'Trade, no withdrawals', partial ? t('Last used: unavailable') : t('Last used today at 07:12')],
              ['Read-only key', 'Read only', partial ? t('Last used: unavailable') : t('Last used 20 Oct')],
            ]}
          />
          {c.mode === 'pro' ? (
            <>
              <H>Allowed addresses</H>
              <Rows rows={[['Trading key', '203.0.113.7']]} />
            </>
          ) : null}
        </>
      }
      explain={
        <p>
          {t(
            'A key lets a tool act for you. Give each key only what the tool needs: a key that can’t withdraw can’t move your money out, even if it leaks.',
          )}
        </p>
      }
    />
  );
}

function Catalogue(c: Ctx) {
  const card = (name: string, figure: string, risk: string) => (
    <article key={name} className="gallery-card">
      <h3>{t(name)}</h3>
      <p className="lt-figure">
        <bdi>{t(figure)}</bdi> <Test />
      </p>
      <p className="gallery-risk">{t(risk)}</p>
      <span className="gallery-chip">{t('Not regulated')}</span>
    </article>
  );
  return (
    <CatalogueTemplate
      {...base(c, 'Earn', { legal: ['crypto-risk-band'] })}
      state={stateFor(c.state, {
        empty: { title: t('No products in your region yet'), body: t('We’ll show products here when they open where you live.') },
        refused: parked(
          t('Earn isn’t open yet'),
          t('Earn opens when our lending partner is switched on. Your crypto stays in your balance until then.'),
          'earn.partner',
        ),
        partial: {
          missing: {
            variant: 'unreachable',
            title: t('Today’s rates can’t load right now'),
            body: t('Products are listed without rates until they’re back. Nothing you’ve put in is affected.'),
            reference: 'Ref earn.rates',
          },
          regions: { featured: t('Rate unavailable'), items: t('Rates unavailable') },
        },
        review: REVIEW_EARN,
        status: EARNING,
        receipt: EARNING_DONE,
      })}
      filters={
        <Tabs
          label="Product types"
          current="#all"
          items={[
            { label: t('All'), href: '#all' },
            { label: t('Flexible'), href: '#flex' },
            { label: t('Fixed term'), href: '#fixed' },
          ]}
        />
      }
      featured={card('USDC flexible', '3.10% a year', 'Your USDC is lent out. You could lose it if a borrower fails.')}
      items={
        c.mode === 'pro' ? (
          <Table
            caption="Earn products, TEST"
            mode="pro"
            rowKey={(r) => r.name}
            rows={[
              { name: 'USDC flexible', rate: '3.10%', term: 'Any time', fee: '0.00%' },
              { name: 'ETH staking', rate: '2.40%', term: '7 days to leave', fee: '10% of rewards' },
              { name: 'BTC fixed 30 days', rate: '1.20%', term: '30 days', fee: '0.00%' },
            ]}
            columns={[
              { key: 'name', label: t('Product'), cell: (r) => t(r.name) },
              { key: 'rate', label: t('Rate a year'), cell: (r) => tv(r.rate), align: 'end' },
              { key: 'term', label: t('Leaving'), cell: (r) => t(r.term) },
              { key: 'fee', label: t('Fee'), cell: (r) => tv(t(r.fee)), align: 'end' },
            ]}
          />
        ) : (
          <div className="gallery-grid">
            {card('ETH staking', '2.40% a year', 'Staked ETH takes 7 days to leave and can be cut if a validator misbehaves.')}
            {card('BTC fixed 30 days', '1.20% a year', 'Locked for 30 days. The value in pounds moves with the price.')}
          </div>
        )
      }
    />
  );
}

function Desk(c: Ctx) {
  const pro = (rows: readonly [string, string, ('up' | 'down')?][]) => (
    <Rows rows={rows.map(([a, b, dir]) => [a, tv(b, dir)] as [string, React.ReactNode])} />
  );
  const chart = series(81000, 48, 0.01);
  return (
    <DeskTemplate
      {...base(c, 'Spot BTC-USDT', { legal: ['crypto-risk-band'] })}
      state={stateFor(c.state, {
        empty: { title: t('No one is trading this market right now'), body: t('Prices will show when the first orders arrive.') },
        refused: parked(
          t('Spot trading isn’t open yet'),
          t('This market opens when trading is switched on in your region. You can still buy and sell from an asset’s page.'),
          'trade.spot',
          { label: t('Go to Bitcoin'), href: '#btc' },
        ),
        partial: {
          missing: {
            variant: 'unreachable',
            title: t('Prices for BTC-USDT are unavailable right now'),
            body: t('Trading pauses until they’re back. Your open orders stay in the book.'),
            reference: 'Ref prices.down',
          },
          regions: {
            instrument: t('Price unavailable'),
            pairs: t('Prices unavailable'),
            chart: t('Chart unavailable until prices are back'),
            book: t('Order book unavailable'),
            tape: t('Trades unavailable'),
            ticket: t('Trading pauses until prices are back'),
          },
        },
        staleRegions: { ticket: t('Refresh prices to trade') },
        review: REVIEW_ORDER,
        status: ORDER,
        receipt: ORDER_DONE,
      })}
      instrument={
        <div className="lt-actions gallery-baseline">
          <strong>BTC-USDT</strong>
          <Money value="81040.00" asset="USDT" />
          <span className="gallery-change" data-dir="up">
            <bdi dir="ltr">+2.14%</bdi> {t('24h')}
          </span>
        </div>
      }
      pairs={pro([
        ['BTC-USDT', '81,040.00', 'up'],
        ['ETH-USDT', '2,914.50', 'down'],
        ['SOL-USDT', '142.18', 'up'],
      ])}
      chart={
        <>
          <p className="gallery-label">
            {t('Last 24 hours')} <Test />
          </p>
          <LineChart label="BTC-USDT, last 24 hours, TEST" points={chart} asset="USDT" tone={toneOf(chart)} live={c.state === 'ready'} />
        </>
      }
      book={pro([
        ['Ask 81,052.10', '0.214', 'down'],
        ['Ask 81,048.00', '0.051', 'down'],
        ['Bid 81,036.50', '0.330', 'up'],
        ['Bid 81,031.20', '0.118', 'up'],
      ])}
      tape={pro([
        ['10:46:58 buy', '81,040.00', 'up'],
        ['10:46:51 sell', '81,041.20', 'down'],
      ])}
      ticket={
        <div className="gallery-ticket">
          <Segmented
            label={t('Side')}
            value="buy"
            options={[
              { value: 'buy', label: t('Buy') },
              { value: 'sell', label: t('Sell') },
            ]}
          />
          <label className="lt-field">
            <span>{t('Amount in BTC')}</span>
            <input inputMode="decimal" placeholder="0.00" />
          </label>
          <Rows
            rows={[
              ['Available', tv('1,250.00 USDT')],
              ['Fee', tv('0.10%')],
              ['Total', '—'],
            ]}
          />
          <button type="button" className="lt-button lt-button-primary" disabled aria-describedby="ticket-hint">
            {t('Review order')}
          </button>
          <p className="lt-hint" id="ticket-hint">
            {t('Enter an amount to review your order.')}
          </p>
        </div>
      }
      orders={pro([
        ['Limit buy 0.01 BTC, open', '81,000.00'],
        ['Market sell 0.005 BTC, filled', '81,012.40'],
      ])}
    />
  );
}

function Reading(c: Ctx) {
  return (
    <ReadingTemplate
      {...base(c, 'Fees')}
      state={stateFor(c.state, {
        empty: { title: t('Nothing published yet'), body: t('Our fee schedule will show here once it is published.') },
        refused: parked(
          t('The fee schedule isn’t published yet'),
          t('Every fee shows on the review screen before you confirm. The full schedule appears here once it’s approved.'),
          'fees.schedule',
        ),
        partial: {
          missing: {
            variant: 'unreachable',
            title: t('Related guides can’t load right now'),
            body: t('This page is complete. Links to related guides will come back shortly.'),
            reference: 'Ref help.related',
          },
          regions: { related: t('Related guides unavailable') },
        },
      })}
      meta={<p className="gallery-label">{t('Updated 20 Oct 2026 · 3 min read')}</p>}
      toc={
        <nav className="gallery-index lt-scroll-row" aria-label="On this page">
          {['Sending money', 'Buying crypto', 'Withdrawing'].map((s) => (
            <a key={s} href={`#${s}`}>
              {t(s)}
            </a>
          ))}
        </nav>
      }
      body={
        <article className="gallery-article">
          <h2>{t('Sending money')}</h2>
          <p>
            {t(
              'We show every fee before you confirm, and the total you pay never changes after you press Send. The fee for each kind of payment appears here once the schedule is published.',
            )}
          </p>
          <h2>{t('Buying crypto')}</h2>
          <p>{t('Each buy shows the price, our spread and the fee as separate lines, and how long the quote holds.')}</p>
        </article>
      }
      related={
        <Rows
          rows={[
            ['Fee tiers', 'Open'],
            ['How we set prices', 'Open'],
          ]}
        />
      }
      contact={
        <a className="lt-link" href="#help">
          {t('Talk to a person')}
        </a>
      }
    />
  );
}

export const ROOMS: Readonly<Record<TemplateId, (c: Ctx) => React.ReactElement>> = {
  overview: Overview,
  'record-list': RecordList,
  monitor: Monitor,
  flow: Flow,
  settings: Settings,
  catalogue: Catalogue,
  desk: Desk,
  reading: Reading,
};
