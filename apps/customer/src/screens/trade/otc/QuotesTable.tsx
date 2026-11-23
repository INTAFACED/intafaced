import { useState } from 'react';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import { Button, Field } from '@intafaced/ui/lit';
import { Skeleton, Table, sortRows, type Column, type SortState } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPrice } from '../rooms/ui';
import { Refusal, unknownValue } from '../options/notices';
import type { Words } from '../rooms/refusals';
import type { QuoteEntry } from './data';
import { atOf, chipOf, lifecycleOf } from './model';
import { otcCopy } from './copy';
import { LifecycleChip } from './QuoteCard';

interface Row {
  id: string;
  entry: QuoteEntry;
}

const quoteOf = (row: Row) => (row.entry.status === 'ready' ? row.entry.quote : null);

/** "TEST-quote-…0001": enough to tell quotes apart in a row; the full id is in the detail. */
const shortId = (id: string) => (id.length <= 14 ? id : `${id.slice(0, 6)}…${id.slice(-6)}`);

export function QuotesTable({
  ids,
  entries,
  selected,
  now,
  pendingId,
  onSelect,
  onOpenById,
  onForget,
  onRetry,
}: {
  ids: readonly string[];
  entries: Readonly<Record<string, QuoteEntry>>;
  selected: string | null;
  now: number;
  /** Id of the quote a request on this device is still unconfirmed for, if any. */
  pendingId: string | null;
  onSelect: (id: string) => void;
  onOpenById: (id: string) => Promise<{ ok: true } | { ok: false; words: Words }>;
  onForget: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const { t } = otcCopy.useCopy();
  const { timeZone } = usePreferences();
  const [typed, setTyped] = useState('');
  const [opening, setOpening] = useState(false);
  const [refusal, setRefusal] = useState<Words | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);

  const rows: Row[] = ids.map((id) => ({ id, entry: entries[id] ?? { status: 'loading' } }));
  const anyLoading = rows.some((row) => row.entry.status === 'loading');
  const cols = columns();
  const sorted = sortRows(rows, sorts(), sort);

  async function openTyped() {
    const id = typed.trim();
    if (!id) return;
    setOpening(true);
    setRefusal(null);
    const result = await onOpenById(id);
    setOpening(false);
    if (result.ok) {
      setTyped('');
      onSelect(id);
    } else setRefusal(result.words);
  }

  const when = (iso: string | null | undefined) => {
    const at = atOf(iso);
    return at === null ? null : dayTime(at, timeZone);
  };
  const whenOf = (r: Row) => {
    const quote = quoteOf(r);
    if (!quote) return null;
    return lifecycleOf(quote) === 'settled' || lifecycleOf(quote) === 'bound' ? when(quote.acceptedAt) : when(quote.expiresAt);
  };
  const shown = (text: string | null | undefined) => (text ? text : unknownValue());

  /** What each sortable column sorts by. */
  function sorts() {
    const q = quoteOf;
    return [
      { id: 'id', value: (r: Row) => r.id, sortType: 'text' as const },
      { id: 'pair', value: (r: Row) => (q(r) ? `${q(r)?.baseAsset}/${q(r)?.quoteAsset}` : null) },
      { id: 'qty', value: (r: Row) => q(r)?.qty ?? null, sortType: 'decimal' as const },
      { id: 'price', value: (r: Row) => q(r)?.quotedPrice ?? null, sortType: 'decimal' as const },
      { id: 'value', value: (r: Row) => q(r)?.userNotional ?? null, sortType: 'decimal' as const },
      { id: 'life', value: (r: Row) => (q(r) ? lifecycleOf(q(r)!) : null) },
    ];
  }

  function columns(): Column<Row>[] {
    const q = quoteOf;
    return [
      { key: 'id', label: t('Quote id'), ltr: true, sortType: 'text', cell: (r) => <span title={r.id}>{shortId(r.id)}</span> },
      {
        key: 'pair',
        label: t('Pair'),
        sortType: 'text',
        cell: (r) => shown(q(r) ? `${q(r)?.baseAsset}/${q(r)?.quoteAsset}` : null),
      },
      { key: 'side', label: t('Side'), cell: (r) => (q(r) ? (q(r)?.side === 'buy' ? t('Buy') : t('Sell')) : '—') },
      { key: 'qty', label: t('Quantity'), align: 'end', sortType: 'decimal', cell: (r) => fmtAmount(q(r)?.qty) },
      { key: 'price', label: t('Quoted price'), align: 'end', sortType: 'decimal', cell: (r) => fmtPrice(q(r)?.quotedPrice, null) },
      { key: 'value', label: t('Value'), align: 'end', sortType: 'decimal', cell: (r) => fmtAmount(q(r)?.userNotional) },
      { key: 'cp', label: t('Counterparty'), cell: (r) => shown(q(r)?.counterparty ?? null) },
      { key: 'when', label: t('Expires or settled'), cell: (r) => shown(whenOf(r)) },
      {
        key: 'life',
        label: t('Status'),
        sortType: 'text',
        cell: (r) => {
          const quote = q(r);
          if (!quote) return r.entry.status === 'loading' ? t('Reading') : r.entry.status === 'refused' ? t('Not found') : t('Unreadable');
          return <LifecycleChip lifecycle={chipOf(quote, now, pendingId)} />;
        },
      },
      {
        key: 'actions',
        label: t('Actions'),
        align: 'end',
        cell: (r) => (
          <span className="lt-actions">
            <Button tone="quiet" onClick={() => onSelect(r.id)} aria-label={t('Open quote', { id: shortId(r.id) })}>
              {t('Open')}
            </Button>
            {r.entry.status === 'error' ? (
              <Button tone="quiet" onClick={() => onRetry(r.id)}>
                {t('Try again')}
              </Button>
            ) : null}
            {r.entry.status === 'refused' || r.entry.status === 'error' ? (
              <Button tone="quiet" onClick={() => onForget(r.id)} aria-label={t('Forget quote', { id: shortId(r.id) })}>
                {t('Forget')}
              </Button>
            ) : null}
          </span>
        ),
      },
    ];
  }

  return (
    <div className="lt-stack">
      {anyLoading && rows.every((r) => r.entry.status === 'loading') && rows.length > 0 ? (
        <Skeleton shape="rows" count={3} />
      ) : (
        <div className="lt-scroll-x">
          <Table
            caption={t('Quotes table')}
            mode="pro"
            columns={cols}
            rows={sorted}
            rowKey={(r) => r.id}
            sort={sort}
            onSort={setSort}
            onSelect={onSelect}
            selected={selected ?? undefined}
            empty={<p className="lt-hint">{t('No quotes')}</p>}
          />
        </div>
      )}
      <p className="lt-hint">{t('Quotes table note')}</p>
      {/* The list above is the way in; a quote that isn't listed opens by its reference. */}
      <form
        className="lt-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void openTyped();
        }}
      >
        <Field
          label={t('Open by id')}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" aria-busy={opening || undefined} disabled={typed.trim() === '' || opening}>
          {t('Open quote button')}
        </Button>
      </form>
      {typed.trim() === '' ? <p className="lt-hint">{t('Open by id hint')}</p> : null}
      {refusal ? <Refusal words={refusal} /> : null}
    </div>
  );
}
