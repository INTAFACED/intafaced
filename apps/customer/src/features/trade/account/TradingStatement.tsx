import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { ScrollTable, Waiting } from '../../more';
import { usePolled } from '../../protocol';
import { useVenueApi } from '../venue/VenueKit';
import { tradingStatementCopy } from './trading-statement-copy';

/**
 * The trading account's statement (`/trade/account`, J-derivatives-26 #7): every trade and every liquidation the venue
 * reports on the person's venue account, each with the fee the venue charged for it as a line of its own, and every line
 * with the venue's own id. Read from the venue through the person's door when the statement is opened; nothing here is a
 * figure of INTAFACED's, and our ledger holds none of it. A venue that reports no liquidations, or a read that fails,
 * says so in place of a statement with lines missing.
 */

/** The venue keeps its records from its own start; the statement asks for all of them. */
const FROM_THE_START = new Date(0).toISOString();
const READ_EVERY_MS = 5_000;

type LineKind = 'trade' | 'trade-fee' | 'builder-fee' | 'liquidation' | 'liquidation-fee';

/** One line of the statement: one record of the venue's, or one fee it charged, under the venue's own id. */
interface Line {
  readonly record: LineKind;
  /** The venue's own id for the record: a fill's id, or a liquidation part's id. */
  readonly ref: string;
  /** The venue's id for the liquidation a part belongs to. */
  readonly liquidationId: string | null;
  readonly at: string;
  readonly market: string;
  readonly side: 'buy' | 'sell' | 'long' | 'short';
  readonly size: string | null;
  readonly price: string | null;
  /** A fee line's amount with its asset, exactly as the venue reports it. */
  readonly amount: string | null;
}

/** A decimal string that is zero ("0", "0.00"): no fee line is written for a fee the venue did not charge. */
const isZero = (value: string) => /^-?0+(\.0+)?$/.test(value);

export function TradingStatement({ owner, venueId, venueName }: { owner: string; venueId: string | undefined; venueName: string }) {
  const { t } = tradingStatementCopy.useCopy();
  const [open, setOpen] = useState(false);
  return (
    <div className="lt-stack" data-testid="trading-statement" data-open={open ? 'yes' : 'no'}>
      <h3>{t('title')}</h3>
      <div className="lt-actions">
        <Button aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? t('close') : t('open')}
        </Button>
      </div>
      {open ? <StatementLines owner={owner} venueId={venueId} venueName={venueName} /> : null}
    </div>
  );
}

function StatementLines({ owner, venueId, venueName }: { owner: string; venueId: string | undefined; venueName: string }) {
  const { t } = tradingStatementCopy.useCopy();
  const api = useVenueApi();
  const read = usePolled(
    async (signal) => {
      const [fills, liquidations] = await Promise.all([
        api.fills(owner, FROM_THE_START, signal, venueId ? { venueId } : {}),
        api.liquidations(owner, signal, venueId),
      ]);
      if (!fills.ok) return fills;
      if (!liquidations.ok) return liquidations;
      return { ok: true as const, data: { fills: fills.data, liquidations: liquidations.data } };
    },
    `trading:statement:${owner}:${venueId ?? ''}`,
    READ_EVERY_MS,
  );
  if (read.failure && !read.data)
    return (
      <p className="lt-refusal" role="alert" data-testid="statement-unread">
        {t('unread', { venue: venueName, detail: read.failure.message })}
      </p>
    );
  if (!read.data) return <Waiting label={t('waiting')} />;
  const { fills, liquidations } = read.data;
  const lines: Line[] = [];
  for (const f of fills.value) {
    const fill = { ref: f.fillId, liquidationId: null, at: f.filledAt, market: f.symbol, side: f.side };
    lines.push({ ...fill, record: 'trade', size: f.amount, price: f.price, amount: null });
    if (!isZero(f.venueFee)) lines.push({ ...fill, record: 'trade-fee', size: null, price: null, amount: `${f.venueFee} ${f.feeAsset}` });
    if (!isZero(f.builderFee))
      lines.push({ ...fill, record: 'builder-fee', size: null, price: null, amount: `${f.builderFee} ${f.feeAsset}` });
  }
  for (const l of liquidations.value) {
    for (const part of l.parts) {
      const closed = { ref: part.partId, liquidationId: l.liquidationId, at: part.liquidatedAt, market: l.symbol, side: l.side };
      lines.push({ ...closed, record: 'liquidation', size: part.size, price: part.price, amount: null });
      // The venue's liquidation fee is always a line, a fee of zero included: it is what the venue charged for the part.
      lines.push({ ...closed, record: 'liquidation-fee', size: null, price: null, amount: `${part.fee} ${part.feeAsset}` });
    }
  }
  // Oldest first; a record's fee follows it (the sort keeps the order lines were written in at the same time).
  lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const asOf = fills.asOf < liquidations.asOf ? fills.asOf : liquidations.asOf;
  const label: { readonly [K in LineKind]: string } = {
    trade: t('trade'),
    'trade-fee': t('tradeFee'),
    'builder-fee': t('builderFee'),
    liquidation: t('liquidation'),
    'liquidation-fee': t('liquidationFee'),
  };
  return (
    <>
      <p className="lt-hint" data-testid="statement-source">
        {t('source', { venue: venueName })} ·{' '}
        <span data-as-of={asOf}>{asOf ? t('asOf', { time: new Date(asOf).toLocaleTimeString() }) : t('asOfUnknown')}</span>
      </p>
      {lines.length === 0 ? (
        <p className="lt-hint" data-testid="statement-empty">
          {t('empty', { venue: venueName })}
        </p>
      ) : (
        <ScrollTable
          label={t('title')}
          headers={[t('hRecord'), t('hTime'), t('hMarket'), t('hSize'), t('hPrice'), t('hAmount'), t('hVenueId')]}
        >
          {lines.map((line) => (
            <tr
              key={`${line.record}:${line.ref}`}
              data-record={line.record}
              data-ref={line.ref}
              data-liquidation={line.liquidationId ?? undefined}
            >
              <td data-cell="record">{label[line.record]}</td>
              <td data-cell="time" data-at={line.at}>
                {new Date(line.at).toLocaleString()}
              </td>
              <td data-cell="market">
                {line.market} · {t(line.side)}
              </td>
              <td className="lt-mono" data-cell="size">
                {line.size}
              </td>
              <td className="lt-mono" data-cell="price">
                {line.price}
              </td>
              <td className="lt-mono" data-cell="amount">
                {line.amount}
              </td>
              <td data-cell="id">{line.liquidationId ? `${line.liquidationId} · ${line.ref}` : line.ref}</td>
            </tr>
          ))}
        </ScrollTable>
      )}
    </>
  );
}
