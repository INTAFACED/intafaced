import { useState } from 'react';
import { Button, ButtonLink, Field, Segmented } from '@intafaced/ui/lit';
import { KeyValue } from '@intafaced/ui/lit/templates';
import { useWallet } from '../../../features/protocol';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import { VENUE_POLL_MS, useVenueApi } from '../../../features/trade/venue/VenueKit';
import type { VenueMarket, VenueUp } from '../../../features/trade/venue-api';
import { displayAmount } from '../../../shared/money';
import { ticketSummary } from './ticket-summary';
import { bpsToPercent } from './venue-risk-logic';
import { futuresVenueCopy } from './venue-copy';
import { ticketPreviewCopy } from './ticket-preview-copy';

/**
 * The order form with no wallet connected: Long or Short, size and leverage, and what the order would come to at the
 * venue's best price and its own fee rates. Nothing here can be sent: its one action connects a wallet (or makes one),
 * after which the desk's own ticket takes its place. A figure the venue does not publish says so; none is guessed.
 */
export function TicketPreview({
  status,
  market,
  side,
  setSide,
}: {
  status: VenueUp;
  market: VenueMarket;
  side: 'buy' | 'sell';
  setSide: (s: 'buy' | 'sell') => void;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const p = ticketPreviewCopy.useCopy().t;
  const wallet = useWallet();
  const venue = useVenueApi();
  const best = usePolled((signal) => venue.bestPrices(market.symbol, signal), `best:${market.symbol}`, VENUE_POLL_MS);
  const [size, setSize] = useState('');
  const [leverage, setLeverage] = useState('');
  const max = market.maxLeverageBps === null ? null : market.maxLeverageBps / 10_000;
  const times = /^\d+$/.test(leverage.trim()) ? Number(leverage.trim()) : null;
  const leverageProblem =
    leverage.trim() === ''
      ? null
      : times === null || times < 1
        ? p('Leverage bad')
        : max !== null && times > max
          ? p('Leverage over', { symbol: market.symbol, max: String(max) })
          : null;
  const usable = leverageProblem === null && times !== null ? times : null;
  const entry = (side === 'buy' ? best.data?.value.ask : best.data?.value.bid) ?? (market.mark.known ? market.mark.value : null);
  const summary = ticketSummary({
    market,
    side,
    size,
    entry,
    position: usable === null ? undefined : { leverageBps: usable * 10_000, marginMode: 'cross' },
    builderFeeBps: status.builder?.feeBps ?? null,
  });
  const quoted = (value: string | null) => (value === null ? p('At review') : `${displayAmount(value)} ${market.quoteAsset}`);
  const fees =
    market.takerFeeBps.known && market.makerFeeBps.known
      ? p('Venue fees', { taker: bpsToPercent(market.takerFeeBps.value), maker: bpsToPercent(market.makerFeeBps.value) })
      : p('Venue fees unpublished');
  const first = wallet.wallets[0];
  return (
    <section className="lt-panel" aria-label={t('Ticket')} data-testid="venue-ticket-preview">
      <h2 className="lt-panel-title">{t('Ticket')}</h2>
      <Segmented
        options={[
          { value: 'buy', label: t('Long') },
          { value: 'sell', label: t('Short') },
        ]}
        value={side}
        onChange={(s) => setSide(s as 'buy' | 'sell')}
        label={t('Ticket')}
      />
      <Field
        label={t('Size', { asset: market.baseAsset })}
        aria-label={t('Size', { asset: market.baseAsset })}
        inputMode="decimal"
        value={size}
        onChange={(e) => setSize(e.target.value)}
      />
      <Field
        label={t('Leverage x')}
        aria-label={t('Leverage x')}
        inputMode="numeric"
        value={leverage}
        hint={max === null ? undefined : t('Max leverage') + `: ${max}x`}
        onChange={(e) => setLeverage(e.target.value)}
      />
      {leverageProblem ? (
        <p className="lt-refusal" role="alert">
          {leverageProblem}
        </p>
      ) : null}
      <div data-testid="venue-ticket-preview-summary">
        <KeyValue
          rows={[
            { label: t('Order value'), value: quoted(summary?.value ?? null) },
            {
              label: summary?.leverage ? t('Margin at', { times: summary.leverage }) : t('Margin'),
              value: quoted(summary?.margin ?? null),
            },
            {
              label: t('Opening fee'),
              value: summary && summary.fee === null ? t('Not published') : quoted(summary?.fee ?? null),
            },
            { label: t('Liquidation price'), value: p('At review') },
          ]}
        />
      </div>
      <p className="lt-note" data-testid="venue-ticket-preview-fees">
        {fees}
      </p>
      <p className="lt-hint">{status.tradesSignedBy === 'session_key' ? p('Next step') : p('Next step wallet')}</p>
      {first ? (
        <Button
          tone="primary"
          data-testid="venue-ticket-preview-go"
          disabled={wallet.status === 'connecting'}
          onClick={() => void wallet.connect(first)}
        >
          {p('Connect go', { name: first.info.name })}
        </Button>
      ) : (
        <ButtonLink tone="primary" href="/wallet/embedded" data-testid="venue-ticket-preview-go">
          {p('Make wallet go')}
        </ButtonLink>
      )}
    </section>
  );
}
