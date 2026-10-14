'use client';
/**
 * People: everyone, for lookups. Search, filters and sorts as before, restyled. The search matches name and email (and the name
 * a merged-away contact had); the server does not search organisations, so this box does not either.
 */
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StateBlock, TooltipProvider, cn } from '@intafaced/ui';
import { crmDate, crmRelative } from '@/lib/crm-browser';
import { describeDue } from '@/lib/crm-due';
import {
  DEFAULT_CRM_SORT,
  MIXED_CURRENCY_NOTE,
  SORT_PRESETS,
  ariaSort,
  hasMixedCurrencies,
  nextSort,
  sortEnquiries,
  sortValue,
  type CrmSort,
  type CrmSortKey,
} from '@/lib/crm-list';
import { founderName, type FounderOwner } from '../founder-names';
import { IndicatedAmount } from './inbox-row';
import { audienceLabel, stageLabel, stagesFor } from './format';
import type { QueueEntry } from './queue';
import { OwnerInitial, Tag, TextField } from './ui';

export { DEFAULT_CRM_SORT };

const AUDIENCE_ITEMS: Record<string, string> = {
  all: 'All audiences',
  investor: 'Investors',
  trader: 'Traders',
  merchant: 'Merchants',
  academy: 'Academy',
  partner: 'Partners',
};
const stageItems = (audience: string): Record<string, string> => ({
  all: 'All stages',
  ...Object.fromEntries(
    (audience ? stagesFor(audience) : ['new', 'qualified', 'diligence', 'terms', 'invited', 'onboarding', 'closed']).map((stage) => [
      stage,
      stageLabel(stage),
    ]),
  ),
});
const sortItems = Object.fromEntries(SORT_PRESETS.map((preset) => [preset.value, preset.label]));

const COLUMNS = '@min-[760px]:grid-cols-[minmax(0,1.6fr)_96px_96px_96px_minmax(0,1.3fr)_44px_96px]';

function PeopleRow({
  entry,
  founder,
  now,
  selected,
  disabled,
  onOpen,
}: {
  entry: QueueEntry;
  founder: string;
  now: number;
  selected: boolean;
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  const { row } = entry;
  const stated = row.audience === 'investor' && row.indicativeContribution.status === 'stated' ? row.indicativeContribution : null;
  const due = row.nextAction ? describeDue(row.nextAction.dueAt, now) : null;
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
          '@min-[760px]:min-h-10 @min-[760px]:py-1.5 max-[600px]:min-h-[64px]',
          'transition-colors duration-(--if-t-fast) ease-if hover:bg-hover disabled:cursor-wait',
          'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lime',
          selected && 'bg-raised hover:bg-raised',
          COLUMNS,
        )}
      >
        <span className="block min-w-0 truncate" title={entry.contact?.email}>
          <span className="font-medium">{entry.contact?.name ?? 'Open enquiry'}</span>
          <span className="text-fg-2"> · {entry.organisation ?? entry.contact?.email}</span>
          {entry.alias ? <span className="text-fg-3"> · also: {entry.alias}</span> : null}
          {entry.partial ? <span className="ml-1.5 text-2xs text-fg-3">Partial</span> : null}
        </span>
        <span className="justify-self-end @min-[760px]:hidden">
          <Tag dot>{stageLabel(row.stage)}</Tag>
        </span>
        <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-fg-2 @min-[760px]:contents">
          <span className="@min-[760px]:col-start-2 @min-[760px]:row-start-1">
            <Tag>{audienceLabel(row.audience)}</Tag>
          </span>
          <span className="tabular-nums @min-[760px]:col-start-3 @min-[760px]:row-start-1 @min-[760px]:text-right">
            {stated ? <IndicatedAmount amount={stated.amount} currency={stated.currency} /> : <span className="text-fg-3">—</span>}
          </span>
          <span className="hidden @min-[760px]:col-start-4 @min-[760px]:row-start-1 @min-[760px]:block">
            <Tag dot>{stageLabel(row.stage)}</Tag>
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 @min-[760px]:col-start-5 @min-[760px]:row-start-1">
            {row.nextAction ? (
              <>
                <span className="min-w-0 truncate text-fg" title={row.nextAction.description}>
                  {row.nextAction.description}
                </span>
                <span className={cn('shrink-0 whitespace-nowrap', due?.overdue ? 'font-medium text-lime' : 'text-fg-2')}>
                  {due?.overdue ?? due?.when.replace(/^Due /, 'due ')}
                </span>
              </>
            ) : (
              <span className="text-fg-2">
                {row.closedDisposition ? row.closedDisposition.charAt(0).toUpperCase() + row.closedDisposition.slice(1) : 'Closed'}
              </span>
            )}
          </span>
          <span className="@min-[760px]:col-start-6 @min-[760px]:row-start-1">
            <OwnerInitial name={founder} />
          </span>
          <span className="@min-[760px]:col-start-7 @min-[760px]:row-start-1 @min-[760px]:text-right" title={crmDate(row.createdAt)}>
            {crmRelative(row.createdAt, now)}
          </span>
        </span>
      </button>
    </li>
  );
}

export type PeopleFilters = { audience: string; stage: string; owner: string; query: string };

export function PeopleView({
  entries,
  loading,
  error,
  filters,
  onFilters,
  sort,
  onSort,
  owners,
  selectedId,
  busy,
  onOpen,
  onRetry,
  hasNext,
  hasPrevious,
  onNext,
  onPrevious,
  now,
}: {
  entries: QueueEntry[] | null;
  loading: boolean;
  error: string;
  filters: PeopleFilters;
  onFilters: (next: Partial<PeopleFilters>) => void;
  sort: CrmSort;
  onSort: (sort: CrmSort) => void;
  owners: FounderOwner[];
  selectedId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onRetry: () => void;
  hasNext: boolean;
  hasPrevious: boolean;
  onNext: () => void;
  onPrevious: () => void;
  now: number;
}) {
  const ownerItems: Record<string, string> = {
    all: 'Both founders',
    ...Object.fromEntries(owners.map((owner) => [owner.userId, owner.displayName])),
  };
  const contacts = new Map((entries ?? []).flatMap((entry) => (entry.contact ? [[entry.row.contactId, entry.contact] as const] : [])));
  const sorted = entries
    ? sortEnquiries(
        entries.map((entry) => entry.row),
        contacts,
        sort,
      )
    : [];
  const byId = new Map((entries ?? []).map((entry) => [entry.row.id, entry]));
  const ordered = sorted.flatMap((row) => {
    const entry = byId.get(row.id);
    return entry ? [entry] : [];
  });
  const paginated = hasNext || hasPrevious;
  const head = (key: CrmSortKey, text: string, className?: string) => (
    <button
      type="button"
      aria-sort={ariaSort(sort, key)}
      onClick={() => onSort(nextSort(sort, key))}
      className={cn(
        'inline-flex items-center gap-1 text-left text-2xs font-medium tracking-wide text-fg-3 uppercase hover:text-fg',
        className,
      )}
    >
      {text}
      <span aria-hidden="true">{sort.key === key ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
    </button>
  );
  const triggerClass = 'max-[600px]:h-11 w-full min-[600px]:w-44';
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        <form
          role="search"
          className="grid grid-cols-1 gap-2 min-[600px]:grid-cols-[minmax(220px,1fr)_auto_auto_auto_auto]"
          onSubmit={(event) => event.preventDefault()}
        >
          <TextField
            type="search"
            aria-label="Search"
            placeholder="Search name or email"
            maxLength={160}
            value={filters.query}
            onChange={(event) => onFilters({ query: event.target.value })}
          />
          <Select
            items={AUDIENCE_ITEMS}
            value={filters.audience || 'all'}
            onValueChange={(value) => onFilters({ audience: value === 'all' ? '' : (value as string), stage: '' })}
          >
            <SelectTrigger aria-label="Audience" className={triggerClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(AUDIENCE_ITEMS).map(([value, name]) => (
                <SelectItem key={value} value={value}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={stageItems(filters.audience)}
            value={filters.stage || 'all'}
            onValueChange={(value) => onFilters({ stage: value === 'all' ? '' : (value as string) })}
          >
            <SelectTrigger aria-label="Stage" className={triggerClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(stageItems(filters.audience)).map(([value, name]) => (
                <SelectItem key={value} value={value}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={ownerItems}
            value={filters.owner || 'all'}
            onValueChange={(value) => onFilters({ owner: value === 'all' ? '' : (value as string) })}
          >
            <SelectTrigger aria-label="Owner" className={triggerClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ownerItems).map(([value, name]) => (
                <SelectItem key={value} value={value}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={sortItems}
            value={sortValue(sort)}
            onValueChange={(value) => onSort(SORT_PRESETS.find((preset) => preset.value === value)?.sort ?? DEFAULT_CRM_SORT)}
          >
            <SelectTrigger aria-label="Sort by" className={triggerClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_PRESETS.map((preset) => (
                <SelectItem key={preset.value} value={preset.value}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </form>
        {entries && hasMixedCurrencies(entries.map((entry) => entry.row)) ? (
          <p className="text-xs text-fg-3">{MIXED_CURRENCY_NOTE}</p>
        ) : null}
        {paginated ? (
          <p className="text-xs text-fg-3">
            Sorting applies to the people loaded on this page only. Use Next and Previous to see the others.
          </p>
        ) : null}
        {entries === null ? (
          error ? (
            <StateBlock kind="error" thing="the people list" onRetry={onRetry} />
          ) : (
            <StateBlock kind="loading" rows={6} rowHeight={40} label={loading ? 'Loading people' : undefined} />
          )
        ) : ordered.length === 0 ? (
          <StateBlock kind="empty" title="Nothing matches these filters." />
        ) : (
          <div className="@container overflow-hidden rounded-md border border-line">
            <div className={cn('hidden items-center gap-x-3 border-b border-line px-3 py-1.5 @min-[760px]:grid', COLUMNS)}>
              {head('name', 'Person')}
              <span className="text-2xs font-medium tracking-wide text-fg-3 uppercase">Audience</span>
              {head('amount', 'Indicated', 'justify-end')}
              <span className="text-2xs font-medium tracking-wide text-fg-3 uppercase">Stage</span>
              {head('due', 'Next action')}
              <span className="text-2xs font-medium tracking-wide text-fg-3 uppercase">Owner</span>
              {head('received', 'Received', 'justify-end')}
            </div>
            <ul>
              {ordered.map((entry) => (
                <PeopleRow
                  key={entry.row.id}
                  entry={entry}
                  founder={founderName(owners, entry.row.ownerUserId)}
                  now={now}
                  selected={selectedId === entry.row.id}
                  disabled={busy}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </div>
        )}
        {paginated ? (
          <div className="flex gap-2">
            <Button variant="secondary" size={32} className="max-[600px]:h-11" disabled={loading || !hasPrevious} onClick={onPrevious}>
              Previous
            </Button>
            <Button variant="secondary" size={32} className="max-[600px]:h-11" disabled={loading || !hasNext} onClick={onNext}>
              Next
            </Button>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
