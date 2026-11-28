import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { ScrollTable } from '../../more';
import { refusalCopy } from '../../../data/refusals';
import { sha256Hex, statementRange } from '../../../screens/trade/desk/ledger';
import type { VenueStatementJob, VenueUp } from '../venue-api';
import { useVenueApi } from '../venue/VenueKit';
import { tradingAccountCopy } from './trading-account-copy';
import { useSession } from '../../session';
import { BANK_OWN_MOVES_LIST } from '@intafaced/contracts/bank-own-moves-procedures';
import { BANK_PAY_YOURSELF_SUMMARY } from '@intafaced/contracts/bank-pay-yourself-procedures';

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
/**
 * One line of the statement as the room lists it (J-derivatives-25 #12): a move, fill or fee, from the source that
 * recorded it (the venue, or the partner for its own leg of a move), with that source's reference and, for a leg on
 * chain, its transaction. `fee` is null where the source reports none: shown as "not known", never 0.
 */
export type StatementEntry = {
  key: string;
  record: string;
  time: string;
  what: string;
  amount: string;
  fee: string | null;
  source: string;
  ref: string;
  chainTx: string | null;
};
type Made =
  | { at: 'idle' }
  | { at: 'busy' }
  | { at: 'refused'; text: string }
  | { at: 'made'; job: VenueStatementJob; csv: string | null; liquidations: LiquidationRow[]; entries: StatementEntry[] };

/** The file's rows, by column name. The venue's ids, symbols and decimals hold no comma or quote. */
function fileRows(csv: string): Record<string, string>[] {
  const [head, ...lines] = csv.trimEnd().split('\n');
  const cols = (head ?? '').split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [cols[i] ?? '', v])));
}

const utcToday = (at: Date) => at.toISOString().slice(0, 10);

/** The file's every move, fill and fee, with the venue's reference: orders are not moves, so they stay in the file only. */
export function venueEntries(rows: readonly Record<string, string>[], venue: string): StatementEntry[] {
  return rows
    .filter((r) => r.record && r.record !== 'order')
    .map((r, i) => ({
      key: `venue:${r.record}:${r.id ?? i}`,
      record: r.record ?? '',
      time: r.time ?? '',
      what: r.market ? `${r.market}${r.side ? ` · ${r.side}` : ''}` : (r.asset ?? ''),
      amount: `${r.amount ?? ''}${r.asset ? ` ${r.asset}` : ''}`.trim(),
      fee: r.fee ? `${r.fee} ${r.fee_asset ?? ''}`.trim() : null,
      source: r.source || venue,
      ref: r.source_ref ?? '',
      // A withdrawal's reference is the chain transaction that paid it, where the venue reports one.
      chainTx: r.record === 'withdrawal' && /^0x[0-9a-f]{64}$/i.test(r.source_ref ?? '') ? (r.source_ref ?? null) : null,
    }));
}

const inRange = (iso: string | null | undefined, from: string, to: string) =>
  !!iso && Date.parse(iso) >= Date.parse(from) && Date.parse(iso) < Date.parse(to);

/**
 * The trading account's statement (J-derivatives-26 #7): one file of the venue account's orders, trades, liquidations and
 * money movements for the days picked, built by svc-trade from the venue's own records and fingerprinted. Each
 * liquidation part the file lists is shown with the venue's fee and its part and liquidation ids, read from the file only
 * once its fingerprint is checked. Asking again for the same days is the same job and the same file; nothing moves.
 */
export function TradingStatement({ status, owner }: { status: VenueUp; owner: string }) {
  const { t } = tradingAccountCopy.useCopy();
  const venue = useVenueApi();
  const { api } = useSession();
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
    if (job.data.status !== 'finished') return setMade({ at: 'made', job: job.data, csv: null, liquidations: [], entries: [] });
    const file = await venue.statementFile(job.data.id);
    // Only the file the job fingerprinted is shown or saved.
    if (!file.ok || file.data.sha256 !== job.data.sha256 || (await sha256Hex(file.data.csv)) !== job.data.sha256)
      return setMade({ at: 'refused', text: t('statementMismatch') });
    const rows = fileRows(file.data.csv);
    // The partner's own legs of the moves in the range, from the partner's records through svc-bank: the move in's
    // partner send to the wallet, and the move out's pay-in the partner credited. Unread, the statement is refused
    // rather than shown with a gap.
    const [moves, payIns] = await Promise.all([
      api.call(BANK_OWN_MOVES_LIST, { limit: 100 }),
      api.call(BANK_PAY_YOURSELF_SUMMARY, undefined),
    ]);
    if (!moves.ok || !payIns.ok) return setMade({ at: 'refused', text: t('statementPartnerUnread') });
    const { from: jobFrom, to: jobTo } = job.data;
    const partnerEntries: StatementEntry[] = [
      ...moves.data
        .filter((m) => m.deliveryTx && inRange(m.sentAt ?? m.createdAt, jobFrom, jobTo))
        .map((m) => ({
          key: `partner:move-in:${m.id}`,
          record: 'partner_to_wallet',
          time: m.sentAt ?? m.createdAt,
          what: m.assetId,
          amount: `${m.amount} ${m.assetId}`,
          fee: m.partnerFee === null ? null : `${m.partnerFee} ${m.assetId}`,
          source: m.partner,
          ref: m.partnerRef ?? m.id,
          chainTx: m.deliveryTx,
        })),
      ...payIns.data.credits
        .filter((c) => c.from.toLowerCase() === owner.toLowerCase() && inRange(c.seenAt, jobFrom, jobTo))
        .map((c) => ({
          key: `partner:pay-in:${c.key}`,
          record: 'wallet_to_partner',
          time: c.availableAt ?? c.seenAt,
          what: 'USDC',
          amount: `${c.amount} USDC`,
          fee: payIns.data.partnerFee === null ? null : `${payIns.data.partnerFee} USDC`,
          source: partnerOf(moves.data) ?? t('statementPartner'),
          ref: c.key,
          chainTx: c.txHash,
        })),
    ];
    const entries = [...venueEntries(rows, name), ...partnerEntries].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const liquidations = rows
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
    setMade({ at: 'made', job: job.data, csv: file.data.csv, liquidations, entries });
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
      {made.at === 'made' && made.csv !== null ? (
        <div data-testid="statement-entries">
          <p>{t('statementEntries', { count: made.entries.length })}</p>
          <ScrollTable
            label={t('statementEntriesLabel')}
            headers={[t('hWhen'), t('hRecord'), t('hWhat'), t('hAmount'), t('hFee'), t('hSource'), t('hReference'), t('hChainTx')]}
          >
            {made.entries.map((e) => (
              <tr key={e.key} data-record={e.record} data-ref={e.ref}>
                <td data-cell="time">{e.time ? new Date(e.time).toLocaleString() : ''}</td>
                <td data-cell="record">{t(recordWord(e.record))}</td>
                <td data-cell="what">{e.what}</td>
                <td className="lt-mono" data-cell="amount">
                  {e.amount}
                </td>
                <td className="lt-mono" data-cell="fee">
                  {e.fee ?? t('statementFeeUnknown')}
                </td>
                <td data-cell="source">{e.source}</td>
                <td data-cell="ref">{e.ref}</td>
                <td data-cell="chain">{e.chainTx ?? ''}</td>
              </tr>
            ))}
          </ScrollTable>
        </div>
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

/** The partner's name as its own records give it. */
function partnerOf(moves: readonly { partner: string }[]): string | null {
  return moves.find((m) => m.partner && m.partner !== 'not known')?.partner ?? null;
}

type RecordWord =
  'recTrade' | 'recLiquidation' | 'recDeposit' | 'recTransfer' | 'recWithdrawal' | 'recPartnerToWallet' | 'recWalletToPartner' | 'recOther';
function recordWord(record: string): RecordWord {
  switch (record) {
    case 'trade':
      return 'recTrade';
    case 'liquidation':
      return 'recLiquidation';
    case 'deposit':
      return 'recDeposit';
    case 'transfer_in':
      return 'recTransfer';
    case 'withdrawal':
      return 'recWithdrawal';
    case 'partner_to_wallet':
      return 'recPartnerToWallet';
    case 'wallet_to_partner':
      return 'recWalletToPartner';
    default:
      return 'recOther';
  }
}
