import { useEffect, useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { DecimalInput, Sheet, Skeleton, Table, type Column } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import type { CopiedMarket, CopiedPosition, CopySkip, RoomApi } from './api';
import { roomCopy } from './copy';
import type { Follow } from './FollowDetail';
import type { WriteGuard } from './guard';
import { InfoNote, RefusalNote } from './parts';

const POSITION_STATE: Record<CopiedPosition['status'], string> = {
  buying: 'Buying',
  open: 'Open',
  closing: 'Closing',
  closed: 'Closed',
};

/** While a copied buy or a close is still on its way, the list is read again this often, at most this many times. */
const SETTLING_REREAD_MS = 2_000;
const SETTLING_REREADS = 30;
const isZero = (amount: string) => /^0*(\.0*)?$/.test(amount);

/** The follow's copied positions, each with a close of the whole position or of a part (CB-copy-09/10). */
export function CopiedPositions({ follow, api, guard }: { follow: Follow; api: RoomApi; guard: WriteGuard }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.copiedPositions(follow.followId, signal), `copied:${follow.followId}`);
  const [closing, setClosing] = useState<CopiedPosition | null>(null);
  const [part, setPart] = useState<CopiedPosition | null>(null);
  const [amount, setAmount] = useState('');
  // The part the service refused as more than is open: what was asked, of which position, and what was open then.
  const [tooMuch, setTooMuch] = useState<{ position: CopiedPosition; qty: string } | null>(null);
  const asked = useRef<{ position: CopiedPosition; qty: string } | null>(null);
  // A re-read keeps the last list on screen instead of blanking it while it loads.
  const last = useRef<CopiedPosition[] | null>(null);
  const lastMarkets = useRef<CopiedMarket[] | null>(null);
  if (resource.status === 'ready') {
    last.current = resource.data.positions;
    lastMarkets.current = resource.data.markets;
  }
  const rows = last.current;
  const marketRows = lastMarkets.current;
  const settling = resource.status === 'ready' && resource.data.positions.some((p) => p.status === 'buying' || p.status === 'closing');
  // A close whose outcome stays unknown stops the re-reads after a while; its Close sends the same order again.
  const rereads = useRef(0);
  useEffect(() => {
    if (!settling) {
      rereads.current = 0;
      return;
    }
    if (rereads.current >= SETTLING_REREADS) return;
    const timer = window.setTimeout(() => {
      rereads.current += 1;
      reload();
    }, SETTLING_REREAD_MS);
    return () => window.clearTimeout(timer);
  }, [settling, resource, reload]);

  const close = (position: CopiedPosition, qty?: string) => {
    setClosing(null);
    setPart(null);
    setTooMuch(null);
    asked.current = qty ? { position, qty } : null;
    rereads.current = 0;
    void guard
      .run(
        { kind: 'copy', id: `${follow.followId}:${position.positionId}`, symbol: position.market, operation: qty ? 'close-part' : 'close' },
        () => api.closePosition(follow.followId, position.positionId, qty),
        () => undefined,
      )
      .then(() => reload());
  };
  // The service's own check: more than is open is refused by its code and nothing is closed.
  const { failure, setFailure } = guard;
  useEffect(() => {
    if (failure?.code !== 'trade.copy_close_qty_exceeds') return;
    setTooMuch(asked.current);
    setFailure(null);
  }, [failure, setFailure]);

  const columns: Column<CopiedPosition>[] = [
    { key: 'market', label: t('Market'), cell: (r) => r.market },
    { key: 'bought', label: t('Amount'), align: 'end', cell: (r) => displayAmount(r.bought) },
    { key: 'open', label: t('Open'), align: 'end', cell: (r) => displayAmount(r.open) },
    { key: 'status', label: t('State'), cell: (r) => t(POSITION_STATE[r.status] as 'Open') },
    { key: 'share', label: t('Leader profit share'), cell: () => t('Not set by the platform') },
    {
      key: 'actions',
      label: t('Action'),
      cell: (r) => {
        const busy = guard.busy || guard.locked;
        // A close still settling can be sent again: the service resends that same order, never a second sell.
        const closeOff = busy || (isZero(r.open) && r.status !== 'closing');
        const partOff = busy || isZero(r.open);
        return (
          <span className="lt-actions">
            <Button disabled={closeOff} onClick={() => setClosing(r)}>
              {t('Close')}
            </Button>
            <Button
              disabled={partOff}
              onClick={() => {
                setAmount('');
                setPart(r);
              }}
            >
              {t('Close part')}
            </Button>
          </span>
        );
      },
    },
  ];
  // One market's position by average entry: what all its copied buys' fills paid over what they filled (sells never move it).
  const marketColumns: Column<CopiedMarket>[] = [
    { key: 'market', label: t('Market'), cell: (r) => r.market },
    { key: 'fills', label: t('Fills'), align: 'end', cell: (r) => (r.fills === null ? t('Not known') : String(r.fills)) },
    { key: 'filled', label: t('Bought'), align: 'end', cell: (r) => (r.filled === null ? t('Not known') : displayAmount(r.filled)) },
    { key: 'open', label: t('Open'), align: 'end', cell: (r) => displayAmount(r.open) },
    {
      key: 'entry',
      label: t('Average entry'),
      align: 'end',
      cell: (r) => (r.averageEntry === null ? t('Not set') : displayAmount(r.averageEntry)),
    },
    { key: 'funding', label: t('Funding'), cell: (r) => (r.funding === null ? t('Not set') : displayAmount(r.funding)) },
  ];
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  const reportedBy = rows?.find((r) => r.reportedBy)?.reportedBy ?? null;
  const none = <NoPositions title={t('No copied positions')} body={t('A position appears here when a copied buy fills.')} />;
  return (
    <>
      <Table
        caption={t('Copied position by market')}
        mode="pro"
        columns={marketColumns}
        rows={marketRows ?? []}
        rowKey={(r) => r.market}
        empty={marketRows === null ? <Skeleton shape="rows" /> : none}
      />
      {reportedBy ? (
        <InfoNote>
          <span data-testid="copied-positions-source">
            {t(reportedBy.test ? 'TEST · As {venue} reports them, at {time}.' : 'As {venue} reports them, at {time}.', {
              venue: reportedBy.venue,
              time: new Date(reportedBy.asOf).toLocaleTimeString(),
            })}
          </span>
        </InfoNote>
      ) : null}
      {tooMuch ? (
        <InfoNote tone="warn">
          {t('That is more than is open.')}{' '}
          {t('You asked to close {qty} of {market}; {open} is open. Nothing was sent.', {
            qty: displayAmount(tooMuch.qty),
            market: tooMuch.position.market,
            open: displayAmount(tooMuch.position.open),
          })}
        </InfoNote>
      ) : null}
      <Table
        caption={t('Copied positions')}
        mode="pro"
        columns={columns}
        rows={rows ?? []}
        rowKey={(r) => r.positionId}
        empty={rows === null ? <Skeleton shape="rows" /> : none}
      />
      <InfoNote>{t('A close sells at the market price, within your slippage limit. Prices can move and fees apply.')}</InfoNote>
      <Sheet open={closing !== null} role="alertdialog" title={t('Close this position?')} onClose={() => setClosing(null)}>
        {closing ? (
          <>
            <p className="lt-description">
              {isZero(closing.open)
                ? t('The close of {amount} in {market} is still settling. Closing again sends that same order, never a second one.', {
                    amount: displayAmount(closing.closing),
                    market: closing.market,
                  })
                : t('Sells the {amount} still open in {market} at the market price. The follow carries on.', {
                    amount: displayAmount(closing.open),
                    market: closing.market,
                  })}
            </p>
            <div className="lt-actions">
              <Button onClick={() => setClosing(null)}>{t('Not now')}</Button>
              <Button tone="primary" data-autofocus="" onClick={() => close(closing)}>
                {t('Close')}
              </Button>
            </div>
          </>
        ) : null}
      </Sheet>
      <Sheet open={part !== null} closeButton={false} title={t('Close part of this position')} onClose={() => setPart(null)}>
        {part ? (
          <form
            className="lt-body"
            onSubmit={(event) => {
              event.preventDefault();
              if (amount.trim()) close(part, amount.trim());
            }}
          >
            <p className="lt-description">
              {t('{amount} is open in {market}. The part you close is sold at the market price.', {
                amount: displayAmount(part.open),
                market: part.market,
              })}
            </p>
            <label className="lt-field">
              <span>{t('Amount')}</span>
              <DecimalInput required value={amount} onValueChange={setAmount} precision={18} />
            </label>
            <div className="lt-actions">
              <Button onClick={() => setPart(null)}>{t('Not now')}</Button>
              <Button type="submit" tone="primary" disabled={!amount.trim()}>
                {t('Close')}
              </Button>
            </div>
          </form>
        ) : null}
      </Sheet>
    </>
  );
}

/** An empty list, said in words. */
function NoPositions({ title, body }: { title: string; body: string }) {
  return (
    <div className="lt-empty">
      <p className="lt-empty-title">{title}</p>
      <p className="lt-empty-body">{body}</p>
    </div>
  );
}

const SKIP_WORDS: Record<string, string> = {
  paused: 'You had paused this follow',
  stopped: 'You had stopped this follow',
  lead_stopped: 'The leader was stopped by the platform',
  platform_paused: 'Paused by the platform',
  risk_control: 'One of your risk controls held it back',
  insufficient_funds: 'Your balance did not cover it',
  max_copy_total: 'It would have gone past your limits',
  copy_slippage_exceeded: 'The price moved past your slippage limit',
  per_contract_cap: 'It would have gone past your most per contract',
  daily_cap: 'It would have gone past your most per day; copying resumes the next day',
  position_closed: 'Nothing you copied was left open to close',
  not_lead_order: 'The leader marked that order as not a lead trade, so it is not copied',
  refused: 'The copy was refused',
};
/** The words for a skip reason id; an id this screen does not know reads as a plain refusal, never as the id. */
export const skipWords = (reason: string) => SKIP_WORDS[reason] ?? 'The copy was refused';

/** Leader trades this follow did not copy, newest first, each with its reason in words (CB-copy-11). */
export function SkippedCopies({ follow, api }: { follow: Follow; api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.skipLog(follow.followId, signal), `skips:${follow.followId}`);
  const columns: Column<CopySkip>[] = [
    { key: 'at', label: t('When'), cell: (r) => new Date(r.at).toLocaleString() },
    { key: 'reason', label: t('Why it was not copied'), cell: (r) => t(skipWords(r.reason) as 'Open') },
  ];
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  return (
    <Table
      caption={t('Skipped copies')}
      mode="pro"
      columns={columns}
      rows={resource.status === 'ready' ? resource.data.items : []}
      rowKey={(r) => r.leaderFillId}
      empty={
        resource.status === 'loading' ? (
          <Skeleton shape="rows" />
        ) : (
          <NoPositions title={t('Nothing skipped')} body={t('Every leader trade so far was copied.')} />
        )
      }
    />
  );
}
