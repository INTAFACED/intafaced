'use client';
/**
 * Raise: how far the round is, in three honest levels. Only committed euros fill the bar. Soft-circled euros (a founder
 * confirmed them after a call) are a lighter extension, and indicated euros (what people said themselves) are a dotted outline.
 * Every other currency is listed on its own and never converted.
 */
import { StateBlock, TooltipProvider, cn } from '@intafaced/ui';
import { founderName, type FounderOwner } from '../founder-names';
import { TIER_HELP, TIER_LABEL, tierOf, type Tier } from './actions';
import { IndicatedAmount } from './inbox-row';
import { formatMoney, formatMoneyCompact, stageLabel } from './format';
import { RAISE_TARGET_EUR } from './policy';
import { investorStageCounts, openEnquiries, otherCurrencies, percentText, raiseBar, tierCounts } from './raise';
import type { Metrics } from './request';
import type { QueueEntry } from './queue';
import { OwnerInitial, Tag } from './ui';

const TIER_ORDER: Record<Tier, number> = { committed: 0, soft_circled: 1, indicated: 2 };

/** Investors for the list under the bar: committed first, then soft-circled, then indicated; the order they arrived in within a level. */
export function orderByTier(entries: readonly QueueEntry[]): QueueEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => TIER_ORDER[tierOf(a.entry.row)] - TIER_ORDER[tierOf(b.entry.row)] || a.index - b.index)
    .map(({ entry }) => entry);
}

export function RaiseBar({ raise }: { raise: Metrics['raise'] }) {
  const bar = raiseBar(raise);
  const label = `Committed ${formatMoney(bar.committed, 'EUR')} of the ${formatMoney(RAISE_TARGET_EUR, 'EUR')} target, ${percentText(bar.committedTenths)}. Soft-circled ${formatMoney(bar.softCircled, 'EUR')}, ${percentText(bar.softTenths)}. Indicated ${formatMoney(bar.indicated, 'EUR')}, self-reported, ${percentText(bar.indicatedTenths)}.`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-fg-2">Target</p>
        <p className="text-xl font-semibold text-fg tabular-nums">{formatMoney(RAISE_TARGET_EUR, 'EUR')}</p>
      </div>
      <div role="img" aria-label={label} className="relative h-4 w-full overflow-hidden rounded-pill bg-field">
        {/* Indicated: a dotted outline out to where it would reach. */}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-pill border border-dotted border-fg-2"
          style={{ width: `${Math.max(bar.dottedEnd / 10, 0)}%` }}
        />
        {/* Soft-circled: a lighter ghost behind the solid fill. */}
        <div aria-hidden="true" className="absolute inset-y-0 left-0 rounded-pill bg-fg/25" style={{ width: `${bar.ghostEnd / 10}%` }} />
        {/* Committed: the only solid fill. */}
        <div aria-hidden="true" className="absolute inset-y-0 left-0 rounded-pill bg-fg" style={{ width: `${bar.fillEnd / 10}%` }} />
      </div>
      <dl className="grid gap-3 text-base min-[600px]:grid-cols-3">
        <div className="flex flex-col gap-0.5">
          <dt className="flex items-center gap-2 text-sm text-fg-2">
            <span aria-hidden="true" className="size-2.5 rounded-xs bg-fg" />
            Committed
          </dt>
          <dd className="text-lg font-semibold text-fg tabular-nums">{formatMoney(bar.committed, 'EUR')}</dd>
          <dd className="text-sm text-fg-2 tabular-nums">
            {percentText(bar.committedTenths)} of target · {TIER_HELP.committed}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="flex items-center gap-2 text-sm text-fg-2">
            <span aria-hidden="true" className="size-2.5 rounded-xs bg-fg/25" />
            Soft-circled
          </dt>
          <dd className="text-lg font-semibold text-fg tabular-nums">{formatMoney(bar.softCircled, 'EUR')}</dd>
          <dd className="text-sm text-fg-2 tabular-nums">
            {percentText(bar.softTenths)} of target · {TIER_HELP.soft_circled}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="flex items-center gap-2 text-sm text-fg-2">
            <span aria-hidden="true" className="size-2.5 rounded-xs border border-dotted border-fg-2" />
            Indicated
          </dt>
          <dd className="text-lg font-semibold text-fg-2 tabular-nums">{formatMoney(bar.indicated, 'EUR')}</dd>
          <dd className="text-sm text-fg-2 tabular-nums">{percentText(bar.indicatedTenths)} of target · self-reported, not confirmed</dd>
        </div>
      </dl>
      <p className="text-xs text-fg-3">Euros only. Nothing here is money received, and no currency is converted into another.</p>
    </div>
  );
}

export function OtherCurrencies({ raise }: { raise: Metrics['raise'] }) {
  const rows = otherCurrencies(raise);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="raise-other" className="flex flex-col gap-2">
      <h3 id="raise-other" className="text-md font-semibold text-fg">
        Other currencies <span className="ml-2 text-sm font-normal text-fg-2">Not converted</span>
      </h3>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[420px] border-collapse text-base">
          <thead>
            <tr className="border-b border-line text-left text-2xs tracking-wide text-fg-3 uppercase">
              <th scope="col" className="px-3 py-1.5 font-medium">
                Currency
              </th>
              <th scope="col" className="px-3 py-1.5 text-right font-medium">
                Committed
              </th>
              <th scope="col" className="px-3 py-1.5 text-right font-medium">
                Soft-circled
              </th>
              <th scope="col" className="px-3 py-1.5 text-right font-medium">
                Indicated
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.currency} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-medium text-fg">
                  {row.currency}
                </th>
                <td className="px-3 py-2 text-right tabular-nums text-fg">{formatMoney(row.committed, row.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-fg">{formatMoney(row.softCircled, row.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-fg-2">{formatMoney(row.indicated, row.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function sourceWords(source: { campaignId: string | null; sourceKey: string | null }): string {
  if (source.campaignId) return 'Known campaign';
  if (source.sourceKey) return 'Unrecognised link code';
  return 'Source unknown';
}

/** The totals the old Reports popover held, as plain text (a number that looks like a link must be one, so these are not styled as links). */
export function CountsPanel({ metrics }: { metrics: Metrics }) {
  const { totals } = metrics;
  const n = (value: number) => value.toLocaleString('en-GB');
  return (
    <section aria-labelledby="raise-counts" className="flex flex-col gap-3">
      <h3 id="raise-counts" className="text-md font-semibold text-fg">
        Counts
      </h3>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-base min-[600px]:grid-cols-4">
        {[
          ['Open enquiries', n(openEnquiries(metrics.byStage))],
          ['All enquiries', n(totals.opportunities)],
          ['Unfinished questionnaires', n(totals.incompleteSubmissions)],
          ['Follow-ups overdue', n(totals.overdueTasks)],
          ['Call invitations recorded', n(totals.manualCallInvitations)],
          ['Call bookings recorded', n(totals.manualCallBookings)],
          ['Submissions', n(totals.submissions)],
          ['Contacts after merging', n(totals.canonicalContacts)],
        ].map(([name, value]) => (
          <div key={name} className="flex flex-col">
            <dt className="text-sm text-fg-2">{name}</dt>
            <dd className="font-medium text-fg tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <details className="rounded-sm border border-line px-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-base font-medium text-fg outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime">
          Where enquiries come from
        </summary>
        <ul className="flex flex-col gap-2 pb-3">
          {metrics.bySource.map((source, index) => (
            <li key={index} className="text-sm">
              <span className="font-medium text-fg">
                {sourceWords(source)} · {source.count}
              </span>
              {source.sourceKey ? <code className="ml-2 break-all text-xs text-fg-2">{source.sourceKey}</code> : null}
              <span className="block text-xs text-fg-3">This shows which link was used, not who used it.</span>
            </li>
          ))}
        </ul>
        {metrics.sourceGroupsTruncated ? <p className="pb-3 text-xs text-fg-3">Showing the first 200 sources; there are more.</p> : null}
        <p className="pb-3 text-xs text-fg-3">
          Deck tracking: not connected. Our Papermark plan does not let us import deck views, so we cannot see who opened the deck.
        </p>
      </details>
    </section>
  );
}

export function RaiseRow({
  entry,
  founder,
  selected,
  disabled,
  onOpen,
}: {
  entry: QueueEntry;
  founder: string;
  selected: boolean;
  disabled?: boolean;
  onOpen: (id: string) => void;
}) {
  const { row } = entry;
  const tier = tierOf(row);
  const committed = row.audience === 'investor' ? row.commitment : null;
  const stated = row.audience === 'investor' && row.indicativeContribution.status === 'stated' ? row.indicativeContribution : null;
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        data-enquiry-id={row.id}
        aria-current={selected ? 'true' : undefined}
        disabled={disabled}
        onClick={() => onOpen(row.id)}
        className={cn(
          'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left text-base text-fg',
          '@min-[640px]:min-h-10 @min-[640px]:grid-cols-[minmax(0,1.6fr)_104px_104px_96px_28px] @min-[640px]:py-1.5 max-[600px]:min-h-14',
          'transition-colors duration-(--if-t-fast) ease-if hover:bg-hover disabled:cursor-wait',
          'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lime',
          selected && 'bg-raised hover:bg-raised',
        )}
      >
        <span className="block min-w-0 truncate" title={entry.contact?.email}>
          <span className="font-medium">{entry.contact?.name ?? 'Open enquiry'}</span>
          {entry.organisation ? <span className="text-fg-2"> · {entry.organisation}</span> : null}
        </span>
        <span className="justify-self-end @min-[640px]:order-last @min-[640px]:justify-self-auto">
          <OwnerInitial name={founder} />
        </span>
        <span className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm @min-[640px]:contents">
          <span className="@min-[640px]:col-start-2 @min-[640px]:row-start-1">
            <Tag title={TIER_HELP[tier]}>{TIER_LABEL[tier]}</Tag>
          </span>
          <span className="tabular-nums @min-[640px]:col-start-3 @min-[640px]:row-start-1 @min-[640px]:text-right">
            {committed ? (
              <span className="text-fg">{formatMoneyCompact(committed.amount, committed.currency)}</span>
            ) : stated ? (
              <IndicatedAmount amount={stated.amount} currency={stated.currency} />
            ) : (
              <span className="text-fg-3">No amount</span>
            )}
          </span>
          <span className="@min-[640px]:col-start-4 @min-[640px]:row-start-1">
            <Tag dot>{stageLabel(row.stage)}</Tag>
          </span>
        </span>
      </button>
    </li>
  );
}

export function RaiseView({
  metrics,
  metricsError,
  onRetry,
  stage,
  onStage,
  entries,
  entriesLoading,
  owners,
  selectedId,
  busy,
  onOpen,
}: {
  metrics: Metrics | null;
  metricsError: string;
  onRetry: () => void;
  stage: string;
  onStage: (stage: string) => void;
  entries: QueueEntry[] | null;
  entriesLoading: boolean;
  owners: FounderOwner[];
  selectedId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
}) {
  if (!metrics) {
    return metricsError ? (
      <StateBlock kind="error" thing="the raise figures" onRetry={onRetry} />
    ) : (
      <StateBlock kind="loading" rows={4} rowHeight={48} label="Loading the raise figures" />
    );
  }
  const stages = investorStageCounts(metrics.byStage);
  const tiers = tierCounts(metrics.raise.counts);
  const ordered = entries ? orderByTier(entries) : null;
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-8">
        <RaiseBar raise={metrics.raise} />
        <OtherCurrencies raise={metrics.raise} />
        <section aria-labelledby="raise-investors" className="flex flex-col gap-3">
          <h3 id="raise-investors" className="text-md font-semibold text-fg">
            Investors
          </h3>
          <div role="group" aria-label="Investors by stage" className="flex flex-wrap gap-2">
            <StageButton
              selected={stage === ''}
              onClick={() => onStage('')}
              label="All"
              count={stages.reduce((sum, entry) => sum + entry.count, 0)}
            />
            {stages.map((entry) => (
              <StageButton
                key={entry.stage}
                selected={stage === entry.stage}
                onClick={() => onStage(stage === entry.stage ? '' : entry.stage)}
                label={stageLabel(entry.stage)}
                count={entry.count}
              />
            ))}
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-2 tabular-nums">
            {tiers.map((tier) => (
              <span key={tier.label}>
                {tier.label} <span className="font-medium text-fg">{tier.count}</span>
              </span>
            ))}
          </p>
          {ordered === null ? (
            <StateBlock kind="loading" rows={4} rowHeight={40} label={entriesLoading ? 'Loading the investors' : undefined} />
          ) : ordered.length === 0 ? (
            <StateBlock kind="empty" title="No investors at this stage." />
          ) : (
            <div className="@container overflow-hidden rounded-md border border-line">
              <ul>
                {ordered.map((entry) => (
                  <RaiseRow
                    key={entry.row.id}
                    entry={entry}
                    founder={founderName(owners, entry.row.ownerUserId)}
                    selected={selectedId === entry.row.id}
                    disabled={busy}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
            </div>
          )}
        </section>
        <CountsPanel metrics={metrics} />
      </div>
    </TooltipProvider>
  );
}

function StageButton({ selected, onClick, label, count }: { selected: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-9 items-center gap-2 rounded-pill border px-3 text-sm font-medium transition-colors duration-(--if-t-fast) ease-if max-[600px]:min-h-11',
        'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime',
        selected ? 'border-fg bg-raised text-fg' : 'border-line-strong text-fg-2 hover:border-line-stronger hover:text-fg',
      )}
    >
      {label}
      <span className="tabular-nums text-fg-3">{count}</span>
    </button>
  );
}
