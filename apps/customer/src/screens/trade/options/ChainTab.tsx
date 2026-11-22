import { useMemo, useState } from 'react';
import { EmptyState, Segmented, Select, Tag } from '@intafaced/ui/lit';
import { RefusalBox, Skeleton, Table, sortRows, type Column, type SortState } from '@intafaced/ui/lit/templates';
import { fmtAmount, formatAsOf, type Loadable } from '../rooms/ui';
import type { ListedMarket, OptionsPolicy } from '../rooms/api';
import { asOfOf, useNow } from '../rooms/read';
import { optionsCopy } from './copy';
import { policyGaps, timeLeft } from './model';
import { Freshness, Refusal, unknownValue } from './notices';
import { RefusedRegion } from './shared';

const ALL = 'all';

export const isComplete = (m: ListedMarket): boolean => Boolean(m.optionType && m.strike && m.expiryDatetime && m.contractSize);
export const isOpen = (m: ListedMarket): boolean => m.orderable && m.active && m.sessionOpen;
const expiryDay = (m: ListedMarket) => (m.expiryDatetime ? m.expiryDatetime.slice(0, 10) : null);

/** What each sortable column sorts by. */
const SORTS = [
  { id: 'symbol', value: (m: ListedMarket) => m.symbol },
  { id: 'right', value: (m: ListedMarket) => m.optionType ?? null },
  { id: 'strike', value: (m: ListedMarket) => m.strike ?? null, sortType: 'decimal' as const },
  { id: 'expiry', value: (m: ListedMarket) => m.expiryDatetime ?? null },
];

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

  const unknown = (text: string | null | undefined) => (text ? text : unknownValue());
  const columns: Column<ListedMarket>[] = [
    { key: 'symbol', label: t('Contract'), sortType: 'text', ltr: true, cell: (m) => m.symbol },
    {
      key: 'right',
      label: t('Call or put'),
      sortType: 'text',
      cell: (m) => (m.optionType ? <Tag tone="neutral">{m.optionType === 'call' ? t('Call') : t('Put')}</Tag> : unknownValue()),
    },
    {
      key: 'strike',
      label: t('Strike'),
      align: 'end',
      sortType: 'decimal',
      cell: (m) => unknown(m.strike ? fmtAmount(m.strike, { places: 8 }) : null),
    },
    {
      key: 'expiry',
      label: t('Expires'),
      sortType: 'text',
      cell: (m) => {
        if (!m.expiryDatetime) return unknownValue();
        const left = timeLeft(m.expiryDatetime, now);
        return (
          <span>
            {formatAsOf(Date.parse(m.expiryDatetime), { now })}{' '}
            <span className="lt-hint">{left ? t('in {time}', { time: left }) : t('Expired')}</span>
          </span>
        );
      },
    },
    {
      key: 'size',
      label: t('Contract size'),
      align: 'end',
      cell: (m) => unknown(m.contractSize ? fmtAmount(m.contractSize, { places: 8 }) : null),
    },
    { key: 'settle', label: t('Settles in'), cell: (m) => unknown(m.settle) },
    {
      key: 'status',
      label: t('Status'),
      cell: (m) => (
        <span className="lt-actions">
          <Tag tone="neutral">{m.paper ? t('Paper') : t('Live')}</Tag>
          {!isComplete(m) ? (
            <Tag tone="neutral">{t('Terms incomplete')}</Tag>
          ) : (
            <Tag tone={isOpen(m) ? 'accent' : 'neutral'}>{isOpen(m) ? t('Open') : t('Closed')}</Tag>
          )}
        </span>
      ),
    },
    ...(['Bid', 'Ask', 'IV', 'Delta'] as const).map((name): Column<ListedMarket> => ({
      key: name.toLowerCase(),
      label: t(name),
      align: 'end',
      cell: () => unknownValue(),
    })),
  ];

  const rows = all.filter(
    (m) =>
      (underlying === ALL || m.base === underlying) &&
      (expiry === ALL || expiryDay(m) === expiry) &&
      (right === ALL || m.optionType === right),
  );
  const sorted = sortRows(rows, SORTS, sort);

  const gaps = policy.status === 'ready' ? policyGaps(policy.data) : [];
  const none =
    markets.status === 'ready' && all.length === 0 ? (
      <RefusalBox
        refusal={{
          variant: 'parked',
          title: t('No option contract is listed'),
          body:
            policy.status === 'ready'
              ? [...gaps.map((g) => (g === 'settlement' ? t('Blocker settlement') : t('Blocker fixing'))), t('Blocker terms')].join(' ')
              : t('Blocker generic'),
        }}
      />
    ) : (
      <EmptyState title={t('No contract matches')} body={t('Clear a filter')} />
    );

  if (markets.status === 'refused') return <RefusedRegion code={markets.code} />;

  return (
    <div className="lt-stack">
      <div className="lt-toolbar">
        <Select
          hideLabel
          label={t('Underlying')}
          value={underlying}
          onChange={setUnderlying}
          options={[{ value: ALL, label: t('All underlyings') }, ...underlyings.map((u) => ({ value: u, label: u }))]}
        />
        <Select
          hideLabel
          label={t('Expiry')}
          value={expiry}
          onChange={setExpiry}
          options={[{ value: ALL, label: t('All expiries') }, ...expiries.map((d) => ({ value: d, label: d }))]}
        />
        <Segmented
          label={t('Call or put')}
          value={right}
          onChange={setRight}
          options={[
            { value: ALL, label: t('Both') },
            { value: 'call', label: t('Calls') },
            { value: 'put', label: t('Puts') },
          ]}
        />
        <Freshness asOf={asOfOf(markets)} now={now} />
      </div>
      <p className="lt-hint">{t('No quote feed hint')}</p>
      {markets.status === 'ready' && sorted.length === 0 ? (
        none
      ) : markets.status === 'loading' || markets.status === 'empty' ? (
        <Skeleton shape="rows" />
      ) : markets.status === 'error' ? (
        <Refusal words={{ title: t('Could not load contracts'), body: t('Try again reason') }} onRetry={markets.retry} />
      ) : (
        <div className="lt-scroll-x">
          <Table
            caption={t('Option contracts')}
            mode="pro"
            columns={columns}
            rows={sorted}
            rowKey={(m) => m.symbol}
            sort={sort}
            onSort={setSort}
            onRowSelect={(m) => onSelect(m.symbol)}
            selected={selected ?? undefined}
          />
        </div>
      )}
    </div>
  );
}
