import { useMemo, useState } from 'react';
import {
  Badge,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
  Table,
  fmtAmount,
  formatAsOf,
  sortRows,
  type Loadable,
  type SortState,
  type TableColumn,
} from '../rooms/ui';
import type { ListedMarket, OptionsPolicy } from '../rooms/api';
import { Freshness } from '../rooms/RoomNotices';
import { asOfOf, useNow } from '../rooms/read';
import { optionsCopy } from './copy';
import { policyGaps, timeLeft } from './model';
import { RefusedRegion } from './shared';

const ALL = 'all';

export const isComplete = (m: ListedMarket): boolean => Boolean(m.optionType && m.strike && m.expiryDatetime && m.contractSize);
export const isOpen = (m: ListedMarket): boolean => m.orderable && m.active && m.sessionOpen;
const expiryDay = (m: ListedMarket) => (m.expiryDatetime ? m.expiryDatetime.slice(0, 10) : null);

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <Select items={Object.fromEntries(options)} value={value} onValueChange={(v) => onChange(v ?? ALL)}>
      <SelectTrigger size={32} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, text]) => (
          <SelectItem key={v} value={v}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ChainTab({
  markets,
  policy,
  selected,
  onSelect,
}: {
  markets: Loadable<ListedMarket[]>;
  policy: Loadable<OptionsPolicy>;
  selected: string | null;
  onSelect: (symbol: string) => void;
}) {
  const { t } = optionsCopy.useCopy();
  const now = useNow(30_000);
  const [underlying, setUnderlying] = useState(ALL);
  const [expiry, setExpiry] = useState(ALL);
  const [right, setRight] = useState(ALL);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'strike', direction: 'asc' });

  const all = markets.status === 'ready' ? markets.data : [];
  const underlyings = useMemo(() => [...new Set(all.map((m) => m.base))].sort(), [all]);
  const expiries = useMemo(() => [...new Set(all.map(expiryDay).filter((d): d is string => d !== null))].sort(), [all]);

  const columns: TableColumn<ListedMarket>[] = [
    {
      id: 'symbol',
      header: t('Contract'),
      width: 200,
      value: (m) => m.symbol,
      sortable: true,
      pin: 'start',
      cell: (m) => <span className="font-mono">{m.symbol}</span>,
    },
    {
      id: 'right',
      header: t('Call or put'),
      width: 90,
      value: (m) => m.optionType ?? null,
      sortable: true,
      cell: (m) => (m.optionType ? <Badge>{m.optionType === 'call' ? t('Call') : t('Put')}</Badge> : null),
    },
    {
      id: 'strike',
      header: t('Strike'),
      width: 90,
      numeric: true,
      sortable: true,
      value: (m) => m.strike ?? null,
      cell: (m) => (m.strike ? fmtAmount(m.strike, { places: 8 }) : null),
    },
    {
      id: 'expiry',
      header: t('Expires'),
      width: 210,
      sortable: true,
      value: (m) => m.expiryDatetime ?? null,
      cell: (m) => {
        if (!m.expiryDatetime) return null;
        const left = timeLeft(m.expiryDatetime, now);
        return (
          <span>
            {formatAsOf(Date.parse(m.expiryDatetime), { now })}{' '}
            <span className="text-fg-2">{left ? t('in {time}', { time: left }) : t('Expired')}</span>
          </span>
        );
      },
    },
    {
      id: 'status',
      header: t('Status'),
      width: 180,
      cell: (m) => (
        <span className="inline-flex flex-wrap gap-1 whitespace-nowrap">
          <Badge variant="outline">{m.paper ? t('Paper') : t('Live')}</Badge>
          {!isComplete(m) ? (
            <Badge tone="warn">{t('Terms incomplete')}</Badge>
          ) : (
            <Badge tone={isOpen(m) ? 'lime' : 'neutral'}>{isOpen(m) ? t('Open') : t('Closed')}</Badge>
          )}
        </span>
      ),
    },
    {
      id: 'size',
      header: t('Contract size'),
      width: 100,
      numeric: true,
      value: (m) => m.contractSize ?? null,
      cell: (m) => (m.contractSize ? fmtAmount(m.contractSize, { places: 8 }) : null),
    },
    { id: 'settle', header: t('Settles in'), width: 80, value: (m) => m.settle ?? null },
    ...(['Bid', 'Ask', 'IV', 'Delta'] as const).map((name): TableColumn<ListedMarket> => ({
      id: name.toLowerCase(),
      header: <span title={t('No quote feed hint')}>{t(name)}</span>,
      headerLabel: t(name),
      width: 56,
      numeric: true,
      value: () => null,
    })),
  ];

  const rows = all.filter(
    (m) =>
      (underlying === ALL || m.base === underlying) &&
      (expiry === ALL || expiryDay(m) === expiry) &&
      (right === ALL || m.optionType === right),
  );
  const sorted = sortRows(rows, columns, sort);

  const gaps = policy.status === 'ready' ? policyGaps(policy.data) : [];
  const none =
    markets.status === 'ready' && all.length === 0 ? (
      <EmptyState
        variant="unavailable"
        title={t('No option contract is listed')}
        reason={
          policy.status === 'ready'
            ? [...gaps.map((g) => (g === 'settlement' ? t('Blocker settlement') : t('Blocker fixing'))), t('Blocker terms')].join(' ')
            : t('Blocker generic')
        }
      />
    ) : (
      <EmptyState title={t('No contract matches')} reason={t('Clear a filter')} />
    );

  if (markets.status === 'refused') return <RefusedRegion code={markets.code} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Filter
          label={t('Underlying')}
          value={underlying}
          options={[[ALL, t('All underlyings')], ...underlyings.map((u): [string, string] => [u, u])]}
          onChange={setUnderlying}
        />
        <Filter
          label={t('Expiry')}
          value={expiry}
          options={[[ALL, t('All expiries')], ...expiries.map((d): [string, string] => [d, d])]}
          onChange={setExpiry}
        />
        <SegmentedControl
          aria-label={t('Call or put')}
          size={32}
          value={right}
          onValueChange={setRight}
          items={[
            { value: ALL, label: t('Both') },
            { value: 'call', label: t('Calls') },
            { value: 'put', label: t('Puts') },
          ]}
        />
        <span className="ml-auto">
          <Freshness asOf={asOfOf(markets)} now={now} />
        </span>
      </div>
      <p className="m-0 text-xs text-fg-2">{t('No quote feed hint')}</p>
      <Table
        label={t('Option contracts')}
        density="dense"
        columns={columns}
        rows={sorted}
        getRowId={(m) => m.symbol}
        status={markets.status === 'loading' || markets.status === 'empty' ? 'loading' : markets.status === 'error' ? 'error' : 'ready'}
        onRetry={markets.status === 'error' ? markets.retry : undefined}
        errorState={<EmptyState variant="refused" title={t('Could not load contracts')} reason={t('Try again reason')} />}
        emptyState={none}
        sort={sort}
        onSortChange={(next) => setSort(next)}
        minWidth={1100}
        selection="single"
        selectedIds={new Set(selected ? [selected] : [])}
        onRowActivate={(m) => onSelect(m.symbol)}
        maxHeight={480}
      />
    </div>
  );
}
