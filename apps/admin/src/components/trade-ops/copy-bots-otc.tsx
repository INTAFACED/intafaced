'use client';

import Link from 'next/link';
import { EmptyState, KeyValue, Table, type TableColumn } from '@intafaced/ui';
import {
  LOOKUP_DENIED_CODE,
  metricText,
  windowText,
  type CustomerLookup,
  type DeskQuote,
  type LookupBot,
  type LookupFollow,
  type OpsMetric,
  type OpsMetrics,
  type QuoteDesk,
  type SettlementException,
} from '@/lib/trade-ops/copy-bots-otc';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ReadProblem } from './blocker-panel';
import { OutcomeNotice } from './outcome-notice';

/**
 * The copy, bots and OTC room (CB-ops-05, CB-ops-04), read only. Every figure is a row svc-trade holds; a count it
 * could not read says "Could not load", never 0. A lookup is audited by svc-trade; nothing here changes a follow, a bot
 * or a quote. Each part keeps its own state: a refused lookup does not hide the module numbers.
 */

export type CopyBotsOtcTab = 'lookup' | 'quotes';

const ROOM = '/trade-ops/copy-bots-otc';
const when = (iso: string) => iso.replace('T', ' ').slice(0, 19);
const mono = (v: string) => <code className="if-num text-xs">{v}</code>;

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="m-0 text-sm font-medium">{title}</h2>
      <p className="m-0 text-xs text-fg-2">{hint}</p>
      {children}
    </section>
  );
}

function ReadAgain({ href }: { href: string }) {
  return (
    <Link href={href} prefetch={false} className="self-start text-sm text-fg underline">
      Read again
    </Link>
  );
}

/** One count's row: its number, or "Could not load" with the code svc-trade gave for that source alone. */
const count = (label: string, metric: OpsMetric) => ({
  label,
  value: metricText(metric),
  ...(metric.value == null && metric.unavailable ? { hint: metric.unavailable } : {}),
});

function Metrics({ metrics, href }: { metrics: Outcome<OpsMetrics>; href: string }) {
  return (
    <Section title="Module metrics" hint="Counts svc-trade reads now. A source it could not read says so; it is never shown as 0.">
      {metrics.kind === 'ok' ? (
        <KeyValue
          layout="inline"
          items={[
            count('Active copiers', metrics.data.activeCopiers),
            count('Active bots', metrics.data.activeBots),
            count('Quotes requested in the window', metrics.data.rfqsRequested),
            count('Quotes settled in the window', metrics.data.rfqsSettled),
            {
              label: 'Window',
              value: `${windowText(metrics.data.window.seconds)}, ${when(metrics.data.window.from)} to ${when(metrics.data.window.to)} UTC`,
            },
            { label: 'As of', value: `${when(metrics.data.asOf)} UTC` },
          ]}
        />
      ) : (
        <>
          <ReadProblem outcome={metrics} title="Module metrics could not be read" />
          <KeyValue
            layout="inline"
            items={[
              { label: 'Active copiers', value: metricText(null) },
              { label: 'Active bots', value: metricText(null) },
              { label: 'Quotes requested in the window', value: metricText(null) },
              { label: 'Quotes settled in the window', value: metricText(null) },
              { label: 'Window', value: 'Not read' },
              { label: 'As of', value: `${when(metrics.asOf)} UTC (when this console asked)` },
            ]}
          />
        </>
      )}
      {metrics.kind === 'ok' ? (
        <p className="m-0 text-xs text-fg-2">
          As of {when(metrics.data.asOf)} UTC, over the last {windowText(metrics.data.window.seconds)}.
        </p>
      ) : null}
      <ReadAgain href={href} />
    </Section>
  );
}

const followCols: TableColumn<LookupFollow>[] = [
  { id: 'leader', header: 'Leader', value: (f) => f.leader },
  { id: 'state', header: 'Status', value: (f) => f.state },
  { id: 'started', header: 'Since (UTC)', value: (f) => when(f.startedAt) },
  { id: 'id', header: 'Follow', value: (f) => f.followId, cell: (f) => mono(f.followId) },
];
const botCols: TableColumn<LookupBot>[] = [
  { id: 'kind', header: 'Kind', value: (b) => b.kind },
  { id: 'symbol', header: 'Market', value: (b) => b.symbol },
  { id: 'side', header: 'Side', value: (b) => b.side },
  { id: 'status', header: 'Status', value: (b) => b.status },
  { id: 'created', header: 'Created (UTC)', value: (b) => when(b.createdAt) },
  { id: 'id', header: 'Bot', value: (b) => b.botId, cell: (b) => mono(b.botId) },
];
const quoteCols: TableColumn<DeskQuote>[] = [
  { id: 'pair', header: 'Pair', value: (q) => q.pair },
  { id: 'side', header: 'Side', value: (q) => q.side },
  { id: 'qty', header: 'Quantity', numeric: true, value: (q) => q.qty },
  { id: 'status', header: 'Status', value: (q) => q.lifecycle },
  { id: 'created', header: 'Requested (UTC)', value: (q) => when(q.createdAt) },
  { id: 'settled', header: 'Settled (UTC)', value: (q) => (q.settledAt ? when(q.settledAt) : '—') },
  { id: 'id', header: 'Quote', value: (q) => q.quoteId, cell: (q) => mono(q.quoteId) },
];
const exceptionCols: TableColumn<SettlementException>[] = [
  { id: 'saga', header: 'Saga key', value: (e) => e.sagaKey, cell: (e) => mono(e.sagaKey) },
  { id: 'reason', header: 'Why', value: (e) => (e.reason === 'not_settled_by_deadline' ? 'Not settled by its deadline' : e.reason) },
  { id: 'accepted', header: 'Accepted (UTC)', value: (e) => when(e.acceptedAt) },
  { id: 'deadline', header: 'Deadline (UTC)', value: (e) => when(e.deadline) },
  { id: 'user', header: 'Customer', value: (e) => e.userId, cell: (e) => mono(e.userId) },
];

function Lookup({ customer, lookup, href }: { customer: string; lookup: Outcome<CustomerLookup> | null; href: string }) {
  return (
    <Section
      title="Customer lookup"
      hint="A whole email address or an account id. svc-trade records every lookup in its operator audit, with who read whom."
    >
      <form method="get" action={ROOM} role="search" className="flex flex-wrap items-end gap-3">
        <input
          type="search"
          name="customer"
          aria-label="Find a customer"
          defaultValue={customer}
          autoComplete="off"
          className="h-8 min-w-[18rem] border border-line bg-transparent px-2 text-sm text-fg"
        />
        <button type="submit" className="h-8 border border-line px-3 text-sm text-fg hover:bg-surface-2">
          Look up
        </button>
      </form>
      {lookup === null ? (
        <EmptyState variant="empty" size="inline" title="No customer looked up" reason="Type an email address or an account id." />
      ) : lookup.kind === 'ok' ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-xs text-fg-2">
            Account {mono(lookup.data.userId)}, read {when(lookup.data.readAt)} UTC.
          </p>
          <Table
            label="Follows"
            density="dense"
            columns={followCols}
            rows={lookup.data.follows}
            getRowId={(f) => f.followId}
            emptyState={<EmptyState variant="empty" size="inline" title="This customer follows no leader" />}
          />
          <Table
            label="Bots"
            density="dense"
            columns={botCols}
            rows={lookup.data.bots}
            getRowId={(b) => b.botId}
            emptyState={<EmptyState variant="empty" size="inline" title="This customer has no bots" />}
          />
          <Table
            label="Customer quotes"
            density="dense"
            columns={quoteCols}
            rows={lookup.data.quotes}
            getRowId={(q) => q.quoteId}
            emptyState={<EmptyState variant="empty" size="inline" title="This customer has asked for no quotes" />}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {lookup.kind === 'refused' && lookup.code === LOOKUP_DENIED_CODE ? (
            <p className="m-0 text-sm font-medium">You don’t have the lookup permission, so svc-trade showed nothing.</p>
          ) : null}
          <OutcomeNotice outcome={lookup} />
        </div>
      )}
      {lookup !== null ? <ReadAgain href={href} /> : null}
    </Section>
  );
}

function Quotes({ desk, href }: { desk: Outcome<QuoteDesk>; href: string }) {
  if (desk.kind !== 'ok')
    return (
      <div className="flex flex-col gap-2">
        <ReadProblem outcome={desk} title="The quote desk could not be read" />
        <ReadAgain href={href} />
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <Section title="Quotes" hint={`Open, accepted and settled quotes, newest first. Read ${when(desk.data.asOf)} UTC.`}>
        {desk.data.quotes.length === 0 ? (
          <p className="m-0 text-sm text-fg-2">No quotes.</p>
        ) : (
          <Table label="Quotes" density="dense" columns={quoteCols} rows={desk.data.quotes} getRowId={(q) => q.quoteId} />
        )}
      </Section>
      <Section
        title="Settlement exceptions"
        hint="Accepted quotes not settled by their deadline. The saga key names the settlement to look into; nothing here retries it."
      >
        {desk.data.exceptions.length === 0 ? (
          <p className="m-0 text-sm text-fg-2">No settlement exceptions.</p>
        ) : (
          <Table
            label="Settlement exceptions"
            density="dense"
            columns={exceptionCols}
            rows={desk.data.exceptions}
            getRowId={(e) => e.quoteId}
          />
        )}
      </Section>
      <ReadAgain href={href} />
    </div>
  );
}

export function CopyBotsOtcRoom(props: {
  tab: CopyBotsOtcTab;
  customer: string;
  metrics: Outcome<OpsMetrics>;
  lookup: Outcome<CustomerLookup> | null;
  desk: Outcome<QuoteDesk> | null;
}) {
  const lookupHref = props.customer ? `${ROOM}?customer=${encodeURIComponent(props.customer)}` : ROOM;
  const deskHref = `${ROOM}?tab=quotes`;
  const here = props.tab === 'quotes' ? deskHref : lookupHref;
  const tabs: { id: CopyBotsOtcTab; label: string; href: string }[] = [
    { id: 'lookup', label: 'Customer lookup', href: lookupHref },
    { id: 'quotes', label: 'Quote desk', href: deskHref },
  ];
  return (
    <div className="flex flex-col gap-6">
      <Metrics metrics={props.metrics} href={here} />
      <div role="tablist" aria-label="Copy, bots and OTC" className="flex gap-2 border-b border-line">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            prefetch={false}
            role="tab"
            aria-selected={props.tab === t.id}
            className={`px-3 py-1 text-sm ${props.tab === t.id ? 'border-b-2 border-fg text-fg' : 'text-fg-2'}`}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <div role="tabpanel" aria-label={props.tab === 'quotes' ? 'Quote desk' : 'Customer lookup'}>
        {props.tab === 'quotes' && props.desk ? (
          <Quotes desk={props.desk} href={deskHref} />
        ) : (
          <Lookup customer={props.customer} lookup={props.lookup} href={lookupHref} />
        )}
      </div>
    </div>
  );
}
