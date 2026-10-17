import { useState } from 'react';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import { Refusal } from '../rooms/RoomNotices';
import { Button, Field, Input, Table, fmtAmount, fmtPrice, sortRows, type SortState, type TableColumn } from '../rooms/ui';
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
  const sorted = sortRows(rows, cols, sort);

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

  function columns(): TableColumn<Row>[] {
    const q = quoteOf;
    const when = (iso: string | null | undefined) => {
      const at = atOf(iso);
      return at === null ? null : dayTime(at, timeZone);
    };
    return [
      {
        id: 'id',
        header: t('Quote id'),
        pin: 'start',
        width: 140,
        value: (r) => r.id,
        cell: (r) => (
          <span className="font-mono" title={r.id}>
            {shortId(r.id)}
          </span>
        ),
        sortable: true,
        sortType: 'text',
      },
      { id: 'pair', header: t('Pair'), width: 110, value: (r) => (q(r) ? `${q(r)?.baseAsset}/${q(r)?.quoteAsset}` : null), sortable: true },
      {
        id: 'side',
        header: t('Side'),
        width: 70,
        value: (r) => q(r)?.side ?? null,
        cell: (r) => (q(r) ? (q(r)?.side === 'buy' ? t('Buy') : t('Sell')) : '—'),
      },
      {
        id: 'qty',
        header: t('Quantity'),
        width: 100,
        numeric: true,
        value: (r) => q(r)?.qty ?? null,
        cell: (r) => fmtAmount(q(r)?.qty),
        sortable: true,
      },
      {
        id: 'life',
        header: t('Status'),
        width: 210,
        value: (r) => {
          const quote = q(r);
          return quote ? lifecycleOf(quote) : null;
        },
        cell: (r) => {
          const quote = q(r);
          if (!quote) return r.entry.status === 'loading' ? t('Reading') : r.entry.status === 'refused' ? t('Not found') : t('Unreadable');
          return <LifecycleChip lifecycle={chipOf(quote, now, pendingId)} />;
        },
        sortable: true,
      },
      {
        id: 'price',
        header: t('Quoted price'),
        width: 110,
        numeric: true,
        value: (r) => q(r)?.quotedPrice ?? null,
        cell: (r) => fmtPrice(q(r)?.quotedPrice, null),
        sortable: true,
      },
      {
        id: 'value',
        header: t('Value'),
        width: 110,
        numeric: true,
        value: (r) => q(r)?.userNotional ?? null,
        cell: (r) => fmtAmount(q(r)?.userNotional),
        sortable: true,
      },
      { id: 'cp', header: t('Counterparty'), width: 130, value: (r) => q(r)?.counterparty ?? null },
      {
        id: 'when',
        header: t('Expires or settled'),
        width: 170,
        value: (r) => {
          const quote = q(r);
          if (!quote) return null;
          return lifecycleOf(quote) === 'settled' || lifecycleOf(quote) === 'bound' ? when(quote.acceptedAt) : when(quote.expiresAt);
        },
      },
      {
        id: 'actions',
        header: t('Actions'),
        headerLabel: t('Actions'),
        width: 150,
        align: 'end',
        cell: (r) => (
          <span className="inline-flex gap-1">
            <Button variant="ghost" size={28} onClick={() => onSelect(r.id)} aria-label={t('Open quote', { id: shortId(r.id) })}>
              {t('View')}
            </Button>
            {r.entry.status === 'error' ? (
              <Button variant="ghost" size={28} onClick={() => onRetry(r.id)}>
                {t('Try again')}
              </Button>
            ) : null}
            {r.entry.status === 'refused' || r.entry.status === 'error' ? (
              <Button variant="ghost" size={28} onClick={() => onForget(r.id)} aria-label={t('Forget quote', { id: shortId(r.id) })}>
                {t('Forget')}
              </Button>
            ) : null}
          </span>
        ),
      },
    ];
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void openTyped();
        }}
      >
        <Field label={t('Open by id')} density="dense" className="min-w-64 flex-1">
          <Input value={typed} onValueChange={setTyped} autoComplete="off" spellCheck={false} />
        </Field>
        <Button type="submit" variant="secondary" size={32} loading={opening} disabled={typed.trim() === ''}>
          {t('Open quote button')}
        </Button>
        {typed.trim() === '' ? <p className="m-0 basis-full text-xs text-fg-2">{t('Open by id hint')}</p> : null}
      </form>
      {refusal ? <Refusal words={refusal} size="inline" /> : null}
      <Table
        label={t('Quotes table')}
        density="dense"
        minWidth={1300}
        columns={cols}
        rows={sorted}
        getRowId={(r) => r.id}
        status={anyLoading && rows.every((r) => r.entry.status === 'loading') ? 'loading' : 'ready'}
        loadingRows={3}
        sort={sort}
        onSortChange={setSort}
        selection="single"
        selectedIds={selected ? new Set([selected]) : new Set()}
        onRowActivate={(r) => onSelect(r.id)}
        emptyState={<p className="m-0 p-3 text-sm text-fg-2">{t('No quotes yet')}</p>}
      />
      <p className="m-0 text-xs text-fg-2">{t('Quotes table note')}</p>
    </div>
  );
}
