/**
 * TEST rooms for the templates gallery: one strong example of each template in every state. Every figure is
 * illustrative and labelled TEST; amounts are decimal strings shaped as `packages/contracts` sends them
 * (`fixtures.test.ts` parses the holdings with the ledger's schema). Dev tool only.
 */
import * as React from 'react';
import { AreaChart, Bars, LineChart, Parts } from '../../components/b2-charts.js';
import { EqualChoice, KeyValue, StatusChip, Tabs } from '../../components/b2-basics.js';
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
import type { Market, Movement, Refusal, ReviewData, RoomState } from '../types.js';
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

const FAILED: Movement = {
  ...SENT,
  id: 'mv-2',
  title: 'ETH withdrawal',
  amount: { value: '0.1', asset: 'ETH', test: true },
  counterparty: 'to 0x9f3c…a1b2',
  status: 'failed',
  steps: [
    { label: 'Requested', at: '2026-10-26T10:40:00Z', state: 'done' },
    { label: 'Sent to network', at: '2026-10-26T10:44:00Z', state: 'failed' },
    { label: 'Returned', at: '2026-10-26T10:51:00Z', state: 'done' },
  ],
  whereNow: '0.1 ETH came back to your balance at 10:51. Nothing was lost.',
  reference: 'LGR-9C1-0AE',
};

const REVIEW: ReviewData = {
  lines: [
    { label: 'You send', value: gbp('250.00') },
    { label: 'Fee', value: gbp('0.00'), note: 'Faster Payments, TEST' },
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

const PARKED: Refusal = {
  variant: 'parked',
  title: 'Bank transfers aren’t connected yet',
  body: 'We can’t take bank transfers until our banking partner is switched on. Card and crypto top-ups still work.',
  reference: 'Ref rail.bank',
  action: { label: 'Use card instead', href: '#card' },
};

const GATE: Refusal = {
  variant: 'refused',
  title: 'Verify your identity first',
  body: 'You need a verified account to see this.',
  action: { label: 'Verify now', href: '#verify' },
};

const PRICES_DOWN: Refusal = {
  variant: 'unreachable',
  title: 'Crypto prices are unavailable right now',
  body: 'Your crypto isn’t in the total until prices come back. Holdings: 0.0712 BTC, 0.8 ETH, 1,250.00 USDC.',
  reference: 'Ref prices.down',
};

function stateFor(
  kind: GalleryState,
  empty: { title: string; body?: string; action?: { label: string; href: string } },
  review: ReviewData = REVIEW,
): RoomState {
  switch (kind) {
    case 'ready':
      return { kind: 'ready' };
    case 'stale':
      return { kind: 'ready', stale: { asOf: '2026-10-26T10:43:00Z', onRefresh: () => {} } };
    case 'partial':
      return { kind: 'ready', partial: { missing: PRICES_DOWN } };
    case 'loading':
      return { kind: 'loading' };
    case 'empty':
      return { kind: 'empty', ...empty };
    case 'refused':
      return { kind: 'refused', refusal: PARKED };
    case 'gated':
      return { kind: 'gated', gate: 'not-verified', refusal: GATE };
    case 'money-status':
      return { kind: 'money-status', movement: FAILED };
    case 'confirm':
      return { kind: 'confirm', review };
    case 'receipt':
      return { kind: 'receipt', movement: SENT };
  }
}

function Test() {
  return <span className="lt-test">TEST</span>;
}

function Money({ value, asset = 'GBP', hero = false }: { value: string; asset?: string; hero?: boolean }) {
  return (
    <p className={hero ? 'lt-figure lt-figure-hero' : 'lt-figure'}>
      {formatMoney({ value, asset })} <Test />
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

function Rows({ rows }: { rows: readonly [string, string, React.ReactNode?][] }) {
  return (
    <KeyValue rows={rows.map(([label, value, note]) => ({ label: t(label), value, note: typeof note === 'string' ? note : undefined }))} />
  );
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
        title: t('Your balance is £0.00'),
        body: t('Add money to get started. Nothing is charged to look around.'),
        action: { label: 'Add money', href: '#add' },
      })}
      hero={
        <>
          <p className="gallery-label">{t('Your money')}</p>
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
              ['Card top-up', '+£200.00'],
              ['Aisha Khan', '−£250.00'],
              ['Bitcoin', '−£150.00'],
            ]}
          />
        </>
      }
      pro={
        <>
          <H>Value over time</H>
          <AreaChart label="Total value, last 24 days, TEST" points={series(12000)} asset="GBP" />
        </>
      }
      watching={
        <>
          <H>Watching</H>
          <Rows
            rows={[
              ['BTC', '£81,040.00'],
              ['ETH', '£2,914.50'],
            ]}
          />
          <Test />
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
  { id: '1', date: '26 Oct', what: 'Card top-up', type: 'Add money', status: 'done' as const, amount: '200.00', ref: 'LGR-1A2-001' },
  { id: '2', date: '25 Oct', what: 'Aisha Khan', type: 'Send', status: 'pending' as const, amount: '-250.00', ref: 'LGR-7Q2-4F2' },
  { id: '3', date: '24 Oct', what: 'Bitcoin', type: 'Buy', status: 'done' as const, amount: '-150.00', ref: 'LGR-3B4-118' },
  { id: '4', date: '23 Oct', what: 'Savings', type: 'Move', status: 'done' as const, amount: '-50.00', ref: 'LGR-8D1-220' },
  { id: '5', date: '21 Oct', what: 'ETH withdrawal', type: 'Withdraw', status: 'failed' as const, amount: '0.00', ref: 'LGR-9C1-0AE' },
];

function RecordList(c: Ctx) {
  return (
    <RecordListTemplate
      {...base(c, 'Activity')}
      state={stateFor(c.state, {
        title: t('No activity yet'),
        body: t('Your payments will show here.'),
        action: { label: 'Add money', href: '#add' },
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
                cell: (r) => <StatusChip status={r.status} label={r.status === 'failed' ? 'Failed, refunded' : undefined} />,
              },
              { key: 'ref', label: t('Ledger ref'), cell: (r) => r.ref, pro: true, ltr: true },
              {
                key: 'amount',
                label: t('Amount'),
                cell: (r) => formatMoney({ value: r.amount, asset: 'GBP' }, { signed: true }),
                align: 'end',
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
  return (
    <MonitorTemplate
      {...base(c, 'Bitcoin', { legal: ['crypto-risk-band'] })}
      state={stateFor(c.state, {
        title: t('You don’t hold any Bitcoin'),
        body: t('Buy some to see your position here.'),
        action: { label: 'Buy Bitcoin', href: '#buy' },
      })}
      figures={[
        <>
          <p className="gallery-label">{t('Price')}</p>
          <Money value="81040.00" />
          <span className="gallery-change" data-dir="up">
            +2.14% {t('today')}
          </span>
        </>,
        <>
          <p className="gallery-label">{t('You hold')}</p>
          <Money value="0.0712" asset="BTC" />
        </>,
        <>
          <p className="gallery-label">{t('Worth')}</p>
          <Money value="5770.24" />
        </>,
        <>
          <p className="gallery-label">{t('24h volume')}</p>
          <Money value="1820400000.00" asset="USD" />
        </>,
      ]}
      actions={<EqualChoice choices={[{ label: t('Buy') }, { label: t('Sell') }]} />}
      chart={
        <LineChart
          label="Bitcoin price, last 24 days, TEST"
          points={series(80000, 24, 0.05)}
          asset="GBP"
          tone="up"
          live={c.state === 'ready'}
        />
      }
      pro={<Bars label="Daily volume, TEST" asset="USD" bars={series(1.8e9, 14, 0.3).map((p) => ({ label: p.at, value: p.value }))} />}
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
  const review = c.state === 'refused' ? REVIEW_BLANK : REVIEW;
  return (
    <FlowTemplate
      {...base(c, 'Send money')}
      state={stateFor(
        c.state,
        { title: t('No one to send to yet'), body: t('Add a payee to send money.'), action: { label: 'Add a payee', href: '#payee' } },
        review,
      )}
      steps={{ labels: [t('Who and how much'), t('Payee check'), t('Purpose'), t('Review')], current: 1 }}
      step={
        <>
          <H>Payee check</H>
          <p>{t('The name on the account matches Aisha Khan.')}</p>
          <StatusChip status="done" label={t('Name matches')} />
          <div style={{ marginBlockStart: 16 }}>
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
              ['Amount', '£250.00'],
              ['Fee', '£0.00'],
            ]}
          />
          <Test />
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
  return (
    <SettingsTemplate
      {...base(c, 'Security')}
      state={stateFor(c.state, { title: t('No devices signed in'), body: t('Sign in on a device to see it here.') })}
      index={
        <nav aria-label="Settings sections" className="gallery-index">
          {['Profile', 'Security', 'Display', 'Notifications', 'Limits', 'Close account'].map((s) => (
            <a key={s} href={`#${s}`} aria-current={s === 'Security' ? 'page' : undefined}>
              {t(s)}
            </a>
          ))}
        </nav>
      }
      sections={
        <>
          <H>Sign-in</H>
          <Rows
            rows={[
              ['Two-step sign-in', 'On'],
              ['Passkeys', '2 devices'],
              ['Withdrawal allowlist', 'Off'],
            ]}
          />
          {c.mode === 'pro' ? (
            <>
              <H>API keys</H>
              <Rows
                rows={[
                  ['Trading key', 'Created 12 Oct'],
                  ['Read-only key', 'Created 3 Oct'],
                ]}
              />
            </>
          ) : null}
          <H>Devices</H>
          <Rows
            rows={[
              ['iPhone, London', 'This device'],
              ['Chrome on Mac', '07:12'],
            ]}
          />
        </>
      }
      explain={
        <p>
          {t(
            'Two-step sign-in asks for a second proof when you sign in on a new device, so a stolen password alone can’t open your account.',
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
        {figure} <Test />
      </p>
      <p className="gallery-risk">{t(risk)}</p>
      <span className="gallery-chip">{t('Not regulated')}</span>
    </article>
  );
  return (
    <CatalogueTemplate
      {...base(c, 'Earn', { legal: ['crypto-risk-band'] })}
      state={stateFor(c.state, {
        title: t('No products in your region yet'),
        body: t('We’ll show products here when they open where you live.'),
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
              { key: 'rate', label: t('Rate a year'), cell: (r) => r.rate, align: 'end' },
              { key: 'term', label: t('Leaving'), cell: (r) => t(r.term) },
              { key: 'fee', label: t('Fee'), cell: (r) => t(r.fee), align: 'end' },
            ]}
          />
        ) : (
          <div className="gallery-grid">
            {card('ETH staking', '2.40% a year', 'Staked ETH takes 7 days to leave and can be cut if a validator misbehaves.')}
            {card('BTC fixed 30 days', '1.20% a year', 'Locked for 30 days. The value in pounds moves with the price.')}
            {card('USDC flexible', '3.10% a year', 'Your USDC is lent out. You could lose it if a borrower fails.')}
          </div>
        )
      }
    />
  );
}

function Desk(c: Ctx) {
  const book = (
    <Rows
      rows={[
        ['81,052.10', '0.214'],
        ['81,048.00', '0.051'],
        ['81,040.00', 'Last'],
        ['81,036.50', '0.330'],
        ['81,031.20', '0.118'],
      ]}
    />
  );
  return (
    <DeskTemplate
      {...base(c, 'Spot BTC-USDT', { legal: ['crypto-risk-band'] })}
      state={stateFor(c.state, {
        title: t('No one is trading this market right now'),
        body: t('Prices will show when the first orders arrive.'),
      })}
      instrument={
        <div className="lt-actions" style={{ alignItems: 'baseline' }}>
          <strong>BTC-USDT</strong>
          <Money value="81040.00" asset="USDT" />
          <span className="gallery-change" data-dir="up">
            +2.14%
          </span>
        </div>
      }
      pairs={
        <Rows
          rows={[
            ['BTC-USDT', '81,040.00'],
            ['ETH-USDT', '2,914.50'],
            ['SOL-USDT', '142.18'],
          ]}
        />
      }
      chart={
        <LineChart
          label="BTC-USDT, last 24 hours, TEST"
          points={series(81000, 48, 0.01)}
          asset="USDT"
          tone="up"
          live={c.state === 'ready'}
        />
      }
      book={book}
      tape={
        <Rows
          rows={[
            ['10:46:58', '81,040.00'],
            ['10:46:51', '81,041.20'],
          ]}
        />
      }
      ticket={
        <>
          <EqualChoice choices={[{ label: t('Buy') }, { label: t('Sell') }]} />
          <Rows
            rows={[
              ['Available', '1,250.00 USDT'],
              ['Fee', '0.10%'],
              ['Total', '—'],
            ]}
          />
          <button type="button" className="lt-button lt-button-primary" style={{ inlineSize: '100%' }}>
            {t('Review order')}
          </button>
        </>
      }
      orders={
        <Rows
          rows={[
            ['Limit buy 0.01 BTC', 'Open'],
            ['Market sell 0.005 BTC', 'Filled'],
          ]}
        />
      }
    />
  );
}

function Reading(c: Ctx) {
  return (
    <ReadingTemplate
      {...base(c, 'Fees')}
      state={stateFor(c.state, { title: t('Nothing published yet'), body: t('Our fee schedule will show here once it is published.') })}
      meta={<p className="gallery-label">{t('Updated 20 Oct 2026 · 3 min read')}</p>}
      toc={
        <nav className="gallery-index" aria-label="On this page">
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
              'Sending pounds to a UK bank account is free. We show every fee before you confirm, and the total you pay never changes after you press Send.',
            )}
          </p>
          <h2>{t('Buying crypto')}</h2>
          <p>
            {t(
              'Each buy shows the price, our spread and the fee as separate lines, and how long the quote holds. The fee figures here are TEST until the schedule is published.',
            )}
          </p>
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
