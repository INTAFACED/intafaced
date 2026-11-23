import { useState } from 'react';
import { BANK_OWN_MOVES_LIST } from '@intafaced/contracts/bank-own-moves-procedures';
import type { OwnMoveView } from '@intafaced/contracts/bank-trading-account-reads';
import { Button } from '@intafaced/ui/lit';
import { ScrollTable, Waiting } from '../../more';
import { displayAmount } from '../../../shared/money';
import { useSession } from '../../session';
import { usePolled } from '../../protocol';
import type { VenueFill } from '../venue-api';
import { VENUE_POLL_MS } from '../venue/poll';
import { useVenueApi } from '../venue/VenueKit';
import { statementCopy } from './statement-copy';

/**
 * The trading account statement (J-derivatives-25 #12): every move between the person's spending and trading money and
 * every fill on their venue accounts, each with its fee and the reference its own source gave it. A move's partner leg
 * carries the partner's reference and the chain transaction of its transfer; its deposit leg the chain transaction the
 * wallet sent; a fill the venue's own id for it. Each fee is the one its source reports, or "not known", never 0.
 * Nothing here is a figure INTAFACED keeps for the person's money, and nothing is read from our ledger.
 */

type T = ReturnType<typeof statementCopy.useCopy>['t'];

interface Venue {
  readonly id: string | undefined;
  readonly name: string;
}

/** The venue lists its fills from a time on: the statement asks from the start. */
const ALL_FILLS_SINCE = new Date(0).toISOString();
const MOVES_EVERY_MS = 3_000;
/** The most moves svc-bank lists in one answer (`ownMoves.list`). */
const MOVES_LIMIT = 100;

export function TradingStatement({ owner, venues, revision }: { owner: string; venues: readonly Venue[]; revision: number }) {
  const { t } = statementCopy.useCopy();
  const [open, setOpen] = useState(false);
  return (
    <section className="lt-stack" aria-label={t('title')} data-testid="trading-statement" data-open={open ? 'yes' : 'no'}>
      <h2>{t('title')}</h2>
      <p className="lt-hint">{t('lead')}</p>
      <div className="lt-actions">
        <Button tone="secondary" onClick={() => setOpen((was) => !was)}>
          {open ? t('close') : t('open')}
        </Button>
      </div>
      {open ? (
        <>
          <Moves venueName={venues[0]?.name ?? ''} revision={revision} t={t} />
          {venues.map((venue) => (
            <Fills key={venue.id ?? 'venue'} owner={owner} venue={venue} revision={revision} t={t} />
          ))}
        </>
      ) : null}
    </section>
  );
}

function When({ iso, t }: { iso: string | null; t: T }) {
  if (!iso) return <span data-when="">{t('notSent')}</span>;
  return (
    <time dateTime={iso} data-when={iso}>
      {new Date(iso).toLocaleString()}
    </time>
  );
}

function Moves({ venueName, revision, t }: { venueName: string; revision: number; t: T }) {
  const { api, userId } = useSession();
  const moves = usePolled(
    (signal) => api.call(BANK_OWN_MOVES_LIST, { limit: MOVES_LIMIT }, { signal }),
    `statement:moves:${userId}:${revision}`,
    MOVES_EVERY_MS,
  );
  return (
    <div className="lt-stack" data-testid="statement-moves">
      <h3>{t('movesTitle')}</h3>
      {moves.failure && !moves.data ? (
        <p className="lt-refusal" role="alert">
          {t('readFailed', { detail: moves.failure.message })}
        </p>
      ) : !moves.data ? (
        <Waiting label={t('movesTitle')} />
      ) : moves.data.length === 0 ? (
        <p className="lt-hint" data-empty="">
          {t('movesNone')}
        </p>
      ) : (
        <ScrollTable label={t('movesTitle')} headers={[t('hWhen'), t('hWhat'), t('hAmount'), t('hReference'), t('hFee')]}>
          {moves.data.map((move) => (
            <MoveRows key={move.id} move={move} venueName={venueName} t={t} />
          ))}
        </ScrollTable>
      )}
    </div>
  );
}

/** One move, a row for each leg: the partner's transfer to the wallet, then the wallet's own deposit to the venue. */
function MoveRows({ move, venueName, t }: { move: OwnMoveView; venueName: string; t: T }) {
  const amount = `${displayAmount(move.amount, 2)} ${move.assetId}`;
  return (
    <>
      <tr data-move={move.id} data-leg="partner">
        <td>
          <When iso={move.sentAt} t={t} />
        </td>
        <td data-cell="what">{t('legPartner', { partner: move.partner })}</td>
        <td className="lt-mono" data-cell="amount" data-value={move.amount}>
          {amount}
        </td>
        <td data-cell="reference">
          <div className="lt-mono" data-ref="partner" data-value={move.partnerRef ?? ''}>
            {t('refPartner', { ref: move.partnerRef ?? t('notKnown') })}
          </div>
          <div className="lt-mono" data-ref="chain" data-value={move.deliveryTx ?? ''}>
            {t('refChain', { tx: move.deliveryTx ?? t('notKnown') })}
          </div>
        </td>
        <td className="lt-mono" data-cell="fee" data-value={move.partnerFee ?? ''}>
          {move.partnerFee === null ? t('notKnown') : t('feeAmount', { fee: displayAmount(move.partnerFee, 2), asset: move.assetId })}
        </td>
      </tr>
      <tr data-move={move.id} data-leg="deposit">
        <td>
          <When iso={move.depositAt} t={t} />
        </td>
        <td data-cell="what">{t('legDeposit', { venue: venueName })}</td>
        <td className="lt-mono" data-cell="amount" data-value={move.amount}>
          {amount}
        </td>
        <td data-cell="reference">
          <div className="lt-mono" data-ref="chain" data-value={move.depositTx ?? ''}>
            {t('refChain', { tx: move.depositTx ?? t('notKnown') })}
          </div>
        </td>
        <td className="lt-mono" data-cell="fee" data-value="">
          {t('notKnown')}
        </td>
      </tr>
    </>
  );
}

/** Every fill the venue reports on the account, with the venue's own id for it and the fees it charged on it. */
function Fills({ owner, venue, revision, t }: { owner: string; venue: Venue; revision: number; t: T }) {
  const api = useVenueApi();
  const fills = usePolled(
    (signal) => api.fills(owner, ALL_FILLS_SINCE, signal, venue.id ? { venueId: venue.id } : {}),
    `statement:fills:${owner}:${venue.id ?? ''}:${revision}`,
    VENUE_POLL_MS,
  );
  const rows: readonly VenueFill[] | null = fills.data?.value ?? null;
  return (
    <div className="lt-stack" data-testid="statement-fills" data-venue={venue.name}>
      <h3>{t('fillsTitle', { venue: venue.name })}</h3>
      <p className="lt-hint" data-testid="statement-fills-source">
        {t('fillsSource', { venue: venue.name })}
        {fills.data ? (
          <>
            {' · '}
            <span data-as-of={fills.data.asOf}>{t('asOf', { time: new Date(fills.data.asOf).toLocaleTimeString() })}</span>
          </>
        ) : null}
      </p>
      {fills.failure && !fills.data ? (
        <p className="lt-refusal" role="alert">
          {t('readFailed', { detail: fills.failure.message })}
        </p>
      ) : rows === null ? (
        <Waiting label={t('fillsTitle', { venue: venue.name })} />
      ) : rows.length === 0 ? (
        <p className="lt-hint" data-empty="">
          {t('fillsNone')}
        </p>
      ) : (
        <ScrollTable
          label={t('fillsTitle', { venue: venue.name })}
          headers={[t('hWhen'), t('hMarket'), t('hSide'), t('hSize'), t('hPrice'), t('hFee'), t('hReference')]}
        >
          {rows.map((fill) => (
            <tr key={fill.fillId} data-fill={fill.fillId}>
              <td>
                <When iso={fill.filledAt} t={t} />
              </td>
              <td data-cell="market">{fill.symbol}</td>
              <td data-cell="side" data-value={fill.side}>
                {t(fill.side)}
              </td>
              <td className="lt-mono" data-cell="size" data-value={fill.amount}>
                {fill.amount}
              </td>
              <td className="lt-mono" data-cell="price" data-value={fill.price}>
                {fill.price}
              </td>
              <td className="lt-mono" data-cell="fee">
                <div data-fee="venue" data-value={fill.venueFee} data-asset={fill.feeAsset}>
                  {t('venueFee', { fee: fill.venueFee, asset: fill.feeAsset })}
                </div>
                <div data-fee="builder" data-value={fill.builderFee} data-asset={fill.feeAsset}>
                  {t('builderFee', { fee: fill.builderFee, asset: fill.feeAsset })}
                </div>
              </td>
              <td className="lt-mono" data-cell="reference" data-value={fill.fillId}>
                {t('refVenue', { id: fill.fillId })}
              </td>
            </tr>
          ))}
        </ScrollTable>
      )}
    </div>
  );
}
