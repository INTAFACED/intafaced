import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { ScrollTable } from '../../more';
import { refusalCopy } from '../../../data/refusals';
import { sha256Hex, statementRange } from '../../../screens/trade/desk/ledger';
import type { VenueStatementJob, VenueUp } from '../venue-api';
import { useVenueApi } from '../venue/VenueKit';
import { tradingAccountCopy } from './trading-account-copy';

/** One liquidation part as the statement file lists it. */
type LiquidationRow = {
  id: string;
  ref: string;
  market: string;
  side: string;
  amount: string;
  price: string;
  fee: string;
  feeAsset: string;
};
type Made =
  | { at: 'idle' }
  | { at: 'busy' }
  | { at: 'refused'; text: string }
  | { at: 'made'; job: VenueStatementJob; csv: string | null; liquidations: LiquidationRow[] };

/** The file's rows, by column name. The venue's ids, symbols and decimals hold no comma or quote. */
function fileRows(csv: string): Record<string, string>[] {
  const [head, ...lines] = csv.trimEnd().split('\n');
  const cols = (head ?? '').split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [cols[i] ?? '', v])));
}

const utcToday = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The trading account's statement (J-derivatives-26 #7): one file of the venue account's orders, trades, liquidations and
 * money movements for the days picked, built by svc-trade from the venue's own records and fingerprinted. Each
 * liquidation part the file lists is shown with the venue's fee and its part and liquidation ids, read from the file only
 * once its fingerprint is checked. Asking again for the same days is the same job and the same file; nothing moves.
 */
export function TradingStatement({ status, owner }: { status: VenueUp; owner: string }) {
  const { t } = tradingAccountCopy.useCopy();
  const venue = useVenueApi();
  const name = status.venue.displayName;
  const [asOf, setAsOf] = useState(() => new Date());
  const [fromDay, setFromDay] = useState(() => utcToday(new Date()));
  const [toDay, setToDay] = useState(() => utcToday(new Date()));
  const [made, setMade] = useState<Made>({ at: 'idle' });

  async function make() {
    const now = made.at === 'made' ? asOf : new Date();
    setAsOf(now);
    const picked = statementRange(fromDay, toDay, now);
    if (!picked.ok) return setMade({ at: 'refused', text: t(picked.why === 'order' ? 'statementOrder' : 'statementDays') });
    setMade({ at: 'busy' });
    const { from, to, requestKey } = picked.range;
    const job = await venue.statement({ owner, from, to, requestKey: `venue:${owner.toLowerCase()}:${requestKey}` });
    if (!job.ok) return setMade({ at: 'refused', text: job.code ? refusalCopy(job.code).title : t('statementRefused') });
    if (job.data.status !== 'finished') return setMade({ at: 'made', job: job.data, csv: null, liquidations: [] });
    const file = await venue.statementFile(job.data.id);
    // Only the file the job fingerprinted is shown or saved.
    if (!file.ok || file.data.sha256 !== job.data.sha256 || (await sha256Hex(file.data.csv)) !== job.data.sha256)
      return setMade({ at: 'refused', text: t('statementMismatch') });
    const liquidations = fileRows(file.data.csv)
      .filter((r) => r.record === 'liquidation')
      .map((r) => ({
        id: r.id ?? '',
        ref: r.source_ref ?? '',
        market: r.market ?? '',
        side: r.side ?? '',
        amount: r.amount ?? '',
        price: r.price ?? '',
        fee: r.fee ?? '',
        feeAsset: r.fee_asset ?? '',
      }));
    setMade({ at: 'made', job: job.data, csv: file.data.csv, liquidations });
  }

  function save(job: VenueStatementJob, csv: string) {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `statement-${job.from.slice(0, 10)}-${utcToday(new Date(Date.parse(job.to) - 1))}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const job = made.at === 'made' ? made.job : null;
  return (
    <div className="lt-stack" data-testid="trading-statement">
      <h3>{t('statementTitle')}</h3>
      <p className="lt-hint">{t('statementIntro', { venue: name })}</p>
      <div className="lt-grid">
        <Field label={t('statementFrom')} type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} />
        <Field label={t('statementTo')} type="date" value={toDay} onChange={(event) => setToDay(event.target.value)} />
      </div>
      <div>
        <Button disabled={made.at === 'busy'} onClick={() => void make()}>
          {t('statementMake')}
        </Button>
      </div>
      {made.at === 'refused' ? (
        <p className="lt-refusal" role="alert">
          {made.text}
        </p>
      ) : null}
      {job ? (
        <p role="status" data-testid="statement-job" data-job={job.id}>
          {job.status === 'finished' && job.rows
            ? t('statementReady', {
                orders: job.rows.orders,
                trades: job.rows.trades,
                liquidations: job.rows.liquidations ?? 0,
                movements: job.rows.movements,
                venue: name,
                id: job.id,
              })
            : job.status === 'failed'
              ? t('statementFailed', { reason: job.error ? refusalCopy(job.error).title : t('statementRefused') })
              : t('statementPending')}
        </p>
      ) : null}
      {made.at === 'made' && made.liquidations.length > 0 ? (
        <div data-testid="statement-liquidations">
          <p>{t('statementLiquidations', { count: made.liquidations.length, venue: name })}</p>
          <ScrollTable
            label={t('statementLiquidationsLabel')}
            headers={[t('hMarket'), t('hSize'), t('hPrice'), t('hFee'), t('hPartId'), t('hLiquidationId')]}
          >
            {made.liquidations.map((row) => (
              <tr key={row.id} data-part={row.id}>
                <td data-cell="market">
                  {row.market} · {row.side}
                </td>
                <td className="lt-mono" data-cell="size">
                  {row.amount}
                </td>
                <td className="lt-mono" data-cell="price">
                  {row.price}
                </td>
                <td className="lt-mono" data-cell="fee">
                  {row.fee} {row.feeAsset}
                </td>
                <td data-cell="id">{row.id}</td>
                <td data-cell="liquidation">{row.ref}</td>
              </tr>
            ))}
          </ScrollTable>
        </div>
      ) : null}
      {made.at === 'made' && made.csv !== null ? (
        <div>
          <Button tone="secondary" onClick={() => save(made.job, made.csv ?? '')}>
            {t('statementDownload')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
