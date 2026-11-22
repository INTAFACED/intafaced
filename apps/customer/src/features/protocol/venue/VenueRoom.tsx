// volt-room: /dex/venue
import { useState, type FormEvent } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import type { createProtocolApi, DexQuote } from '../api';
import type { protocolCopy } from '../copy';
import { SupportedNetworksPanel } from '../NetworkPanels';
import { TokensNav } from '../tokens/TokensRoom';
import { Answer, flag, orNone, Rows } from '../volt/answer';
import { Banner, useProtocolTab } from '../volt/frame';
import { DataTable, Failure, Loading, Panel, Tabs } from '../volt/parts';
import { VenueFunds } from './VenueFunds';

type Translate = ReturnType<typeof protocolCopy.forLocale>['t'];

/**
 * /dex/venue on the monitor template: whether the order book and the AMM and outside venues are wired (the indexer's and
 * the DEX's answers), moving funds between the wallet and the venue, a quote across the venues, the supported networks, and
 * the tab's actions, each disabled with the blocker it waits on.
 */
export function VenueRoom() {
  const tab = useProtocolTab('dex', 'venue');
  const { t, api, indexer, dex, chain } = tab.room;
  return (
    <div lang={tab.lang}>
      <MonitorTemplate
        title={tab.title}
        description={tab.description}
        state={{ kind: 'ready' }}
        mode="pro"
        figures={[]}
        actions={
          <>
            {tab.sections}
            <TokensNav />
          </>
        }
        panels={
          <>
            <Banner />
            <Panel title={t('venueTitle')}>
              <Answer value={indexer} source={t('src_indexer')} service={t('svc_indexer')} t={t}>
                {(i) => (
                  <>
                    <Rows
                      t={t}
                      rows={[
                        [t('clobKind'), i.clob.kind],
                        [t('clobLive'), flag(t, i.clob.live)],
                      ]}
                    />
                    <p className="lt-hint">{t('venueNote')}</p>
                  </>
                )}
              </Answer>
              <Answer value={dex} source={t('src_dex')} service={t('svc_dex')} t={t}>
                {(d) => (
                  <Rows
                    t={t}
                    rows={[
                      [t('ammWired'), flag(t, d.ammVenueWired)],
                      [t('externalWired'), flag(t, d.externalVenueWired)],
                      [t('internalBook'), flag(t, d.internalBook.enabled)],
                    ]}
                  />
                )}
              </Answer>
            </Panel>
            <VenueFunds api={api} t={t} />
            <QuoteDesk api={api} t={t} />
            <SupportedNetworksPanel t={t} chain={chain} />
            {tab.actions}
          </>
        }
      />
    </div>
  );
}

function QuoteDesk({ api, t }: { api: ReturnType<typeof createProtocolApi>; t: Translate }) {
  const [symbol, setSymbol] = useState(''),
    [side, setSide] = useState<'buy' | 'sell'>('buy'),
    [qty, setQty] = useState('');
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; data: DexQuote }
    | { status: 'failed'; failure: Extract<ApiResult<DexQuote>, { ok: false }> }
  >({
    status: 'idle',
  });
  const valid = symbol.trim() !== '' && /^\d+(\.\d{1,18})?$/.test(qty.trim());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || state.status === 'loading') return;
    setState({ status: 'loading' });
    const result = await api.dexQuote({ symbol: symbol.trim(), side, qty: qty.trim() });
    setState(result.ok ? { status: 'ready', data: result.data } : { status: 'failed', failure: result });
  }
  return (
    <Panel title={t('quoteTitle')}>
      <p className="lt-hint">{t('quoteNote')}</p>
      <form className="lt-stack" onSubmit={(event) => void submit(event)}>
        <Field
          label={t('symbol')}
          hint={t('symbolHint')}
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
          autoComplete="off"
        />
        <Tabs
          label={t('side')}
          items={['buy', 'sell']}
          value={side}
          onChange={(value) => setSide(value === 'sell' ? 'sell' : 'buy')}
          labels={{ buy: t('buy'), sell: t('sell') }}
        />
        <Field
          label={t('quantity')}
          hint={t('quantityHint')}
          value={qty}
          inputMode="decimal"
          onChange={(event) => setQty(event.target.value)}
          autoComplete="off"
        />
        <Button tone="primary" type="submit" disabled={!valid || state.status === 'loading'}>
          {state.status === 'loading' ? t('quoting') : t('getQuote')}
        </Button>
      </form>
      {state.status === 'loading' && <Loading label={t('quoting')} />}
      {state.status === 'failed' && (
        <div className="lt-refusal">
          <p className="lt-refusal-title">{t('quoteRefused')}</p>
          <Failure result={state.failure} />
        </div>
      )}
      {state.status === 'ready' && <QuoteResult quote={state.data} t={t} />}
    </Panel>
  );
}

function QuoteResult({ quote, t }: { quote: DexQuote; t: Translate }) {
  return (
    <div className="lt-stack">
      <Rows
        t={t}
        rows={[
          [t('routeKind'), quote.route.kind],
          [t('filled'), quote.route.filledQty],
          [t('unfilled'), quote.route.unfilledQty],
          [t('totalQuote'), quote.route.totalQuoteAmount],
          [t('executable'), quote.executable ? t('executableYes') : t('executableNo')],
          [t('nonExecutable'), orNone(t, quote.nonExecutableReason)],
        ]}
      />
      {quote.degraded && <p className="lt-hint">{t('degraded')}</p>}
      {quote.singleVenue && <p className="lt-hint">{t('singleVenue')}</p>}
      {quote.route.legs.length > 0 && (
        <DataTable label={t('route')} headers={[t('hdr_venue'), t('hdr_kind'), t('hdr_qty'), t('hdr_amount'), t('hdr_price')]}>
          {quote.route.legs.map((leg, index) => (
            <tr key={`${leg.venue}-${index}`}>
              <td>{leg.venue}</td>
              <td>{leg.kind}</td>
              <td className="lt-mono">{leg.qty}</td>
              <td className="lt-mono">{leg.quoteAmount}</td>
              <td className="lt-mono">{leg.effectivePrice}</td>
            </tr>
          ))}
        </DataTable>
      )}
      {quote.unavailable.length > 0 && (
        <>
          <h3>{t('venuesUnavailable')}</h3>
          <ul>
            {quote.unavailable.map((entry) => (
              <li key={entry.venueId}>
                {entry.venueId}: {entry.reason}. {entry.detail}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
