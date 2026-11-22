import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { SwapForm } from './swap/SwapForm';
import { navigate } from '../../app/location';
import { useApi } from '../session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Page, Panel, Stat, Tabs } from '../../shared/ui';
import { Actions, Answer, flag, orNone, Rows, toSource } from './volt/answer';
import { createProtocolApi, type DexQuote } from './api';
import { chainReasonWords, networkLabel, SUBNAV, tabFromSubPath, type ProtocolSnapshot, type Slug } from './blockers';
import { protocolCopy as copy } from './copy';
import { type ChainRef, NetworkPanel, SupportedNetworksPanel } from './NetworkPanels';
import { ChainHome } from './explorer/ChainHome';
import { TokensNav } from './tokens/TokensRoom';
import { PoolsList } from './pools/PoolsList';
import { BridgeRoutes } from './rails/BridgeRoutes';
import { AuditProducts } from './AuditProducts';
import { VenueFunds } from './venue/VenueFunds';
import { LendPanel } from './lend/LendPanel';
import './explorer/explorer.css';
import './protocol.css';

type Translate = ReturnType<typeof copy.forLocale>['t'];

export { Actions, Answer, NoAnswerNote, toSource } from './volt/answer';

const slugs: readonly Slug[] = ['chain', 'dex', 'protocol'];
export function isProtocolSlug(value: string | undefined): value is Slug {
  return slugs.includes(value as Slug);
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
      <p className="muted">{t('quoteNote')}</p>
      <form className="protocol-quote" onSubmit={(event) => void submit(event)}>
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
        <Button type="submit" disabled={!valid || state.status === 'loading'}>
          {state.status === 'loading' ? t('quoting') : t('getQuote')}
        </Button>
      </form>
      {state.status === 'loading' && <Loading label={t('quoting')} />}
      {state.status === 'failed' && (
        <div className="protocol-refuse">
          <p className="protocol-refuse__title">{t('quoteRefused')}</p>
          <Failure result={state.failure} />
        </div>
      )}
      {state.status === 'ready' && <QuoteResult quote={state.data} t={t} />}
    </Panel>
  );
}

function QuoteResult({ quote, t }: { quote: DexQuote; t: Translate }) {
  return (
    <div className="protocol-quote__result">
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
      {quote.degraded && <p className="muted">{t('degraded')}</p>}
      {quote.singleVenue && <p className="muted">{t('singleVenue')}</p>}
      {quote.route.legs.length > 0 && (
        <DataTable label={t('route')} headers={[t('hdr_venue'), t('hdr_kind'), t('hdr_qty'), t('hdr_amount'), t('hdr_price')]}>
          {quote.route.legs.map((leg, index) => (
            <tr key={`${leg.venue}-${index}`}>
              <td>{leg.venue}</td>
              <td>{leg.kind}</td>
              <td className="numeric">{leg.qty}</td>
              <td className="numeric">{leg.quoteAmount}</td>
              <td className="numeric">{leg.effectivePrice}</td>
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

/**
 * The /chain, /dex and /protocol rooms while INTACHAIN is parked. Parked means "blocked with a named reason you can open
 * and inspect": every section reads the live service where one answers, every service that does not answer shows a typed
 * refuse, and every action the room implies is present, disabled, and names its first real blocker.
 * Nothing here is labelled INTACHAIN mainnet or audited; the INTACHAIN line on Chain home reads "not launched" with its blocker.
 */
export function ParkedProtocolRoom({ slug, subPath }: { slug: Slug; subPath?: string }) {
  const { language } = usePreferences();
  const { t } = copy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const key = `protocol-room:${slug}`;
  const chain = useResource((signal) => api.chainStatus(signal), `${key}:chain`),
    audit = useResource((signal) => api.auditStatus(signal), `${key}:audit`),
    indexer = useResource((signal) => api.indexerStatus(signal), `${key}:indexer`),
    dex = useResource((signal) => api.dexHealth(signal), `${key}:dex`),
    health = useResource((signal) => api.health(signal), `${key}:health`);
  const snapshot: ProtocolSnapshot = {
    chain: toSource(chain),
    audit: toSource(audit),
    indexer: toSource(indexer),
    dex: toSource(dex),
    health: toSource(health),
  };
  // The URL is the source of truth for the tab, so deep links and tab clicks agree.
  const tab = tabFromSubPath(slug, subPath);
  const tabs = SUBNAV[slug];
  const actions = tabs.find((entry) => entry.id === tab)?.actions ?? [];
  const label =
    chain.resource.status === 'loading'
      ? { name: t('networkChecking'), note: '' }
      : networkLabel(chain.resource.status === 'ready' ? chain.resource.data.configuredChainId : null);
  const title = slug === 'chain' ? t('titleChain') : slug === 'dex' ? t('titleDex') : t('titleProtocol');
  const description = slug === 'chain' ? t('descChain') : slug === 'dex' ? t('descDex') : t('descProtocol');

  const chainRef: ChainRef =
    chain.resource.status === 'ready'
      ? { status: 'ready', chainId: chain.resource.data.configuredChainId }
      : chain.resource.status === 'failed'
        ? { status: 'failed', failure: chain.resource.failure, reload: chain.reload }
        : { status: 'loading' };
  const chainStatusPanel = (
    <Panel title={t('tab_status')}>
      <Answer value={chain} source={t('src_chain')} t={t} shell={{ label: t('tab_status'), headers: [t('hdr_check'), t('hdr_result')] }}>
        {(c) => (
          <Rows
            t={t}
            rows={[
              [t('network'), label.name],
              [t('networkNote'), label.note],
              [t('configuredChain'), c.configuredChainId],
              [t('observedChain'), orNone(t, c.observedChainId)],
              [t('reachable'), flag(t, c.reachable)],
              [t('latestBlock'), orNone(t, c.blockNumber)],
              [t('suiteDeployed'), flag(t, c.suiteDeployed)],
              [t('tokenFactoryDeployed'), flag(t, c.tokenFactoryDeployed)],
              [t('usable'), flag(t, c.usable)],
              [t('launchUsable'), flag(t, c.launchUsable)],
              ...(c.refusalCode || c.reason ? ([[t('refusalReason'), chainReasonWords(c.refusalCode)]] as const) : []),
            ]}
          />
        )}
      </Answer>
    </Panel>
  );
  const auditPanel = (
    <Panel title={t('auditTitle')}>
      <Answer value={audit} source={t('src_audit')} t={t} shell={{ label: t('auditTitle'), headers: [t('hdr_field'), t('hdr_value')] }}>
        {(a) => (
          <Rows
            t={t}
            rows={[
              [t('auditedFlag'), t('auditedFalse')],
              [t('auditKind'), t('internalOnly')],
              [t('auditPackage'), a.id],
              [t('auditPath'), a.packagePath],
              [t('auditHash'), a.artifactHash],
              [t('auditSigned'), a.signedBy ?? t('unsigned')],
            ]}
          />
        )}
      </Answer>
    </Panel>
  );
  const venuePanel = (
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
            <p className="muted">{t('venueNote')}</p>
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
  );

  let body: ReactNode = null;
  if (slug === 'chain' && tab === 'status')
    body = (
      <>
        <ChainHome chain={chainRef} />
        {chainStatusPanel}
        <NetworkPanel chain={chainRef} t={t} />
      </>
    );
  else if (tab === 'audit')
    body = (
      <>
        <AuditProducts api={api} />
        {auditPanel}
      </>
    );
  else if (slug === 'dex' && tab === 'swap') body = <SwapForm />;
  else if (slug === 'dex' && tab === 'pools')
    body = (
      <>
        <PoolsList />
        <Panel title={t('poolsTitle')}>
          <Answer value={dex} source={t('src_dex')} service={t('svc_dex')} t={t}>
            {(d) => <Rows t={t} rows={[[t('ammWired'), flag(t, d.ammVenueWired)]]} />}
          </Answer>
        </Panel>
      </>
    );
  else if (slug === 'dex' && tab === 'positions')
    body = (
      <Panel title={t('positionsTitle')}>
        <EmptyState title={t('positionsEmpty')} />
      </Panel>
    );
  else if (slug === 'dex' && tab === 'lend') body = <LendPanel api={api} t={t} />;
  else if (slug === 'dex' && tab === 'venue')
    body = (
      <>
        {venuePanel}
        <VenueFunds api={api} t={t} />
        <QuoteDesk api={api} t={t} />
        <SupportedNetworksPanel t={t} chain={chainRef} />
      </>
    );
  else if (slug === 'protocol' && tab === 'overview')
    body = (
      <>
        {chainStatusPanel}
        <Panel title={t('tab_overview')}>
          <Answer value={health} source={t('src_health')} t={t}>
            {(h) => (
              <Rows
                t={t}
                rows={[
                  [t('relayEnabled'), flag(t, h.relayEnabled)],
                  [t('factoryConfigured'), flag(t, h.factoryConfigured)],
                ]}
              />
            )}
          </Answer>
        </Panel>
      </>
    );
  else if (slug === 'protocol' && tab === 'rails')
    body = (
      <Panel title={t('railsTitle')}>
        <p className="muted">{t('railsNote')}</p>
        <div className="protocol-rails">
          <Stat label={t('railBase')} value={t('railBaseState')} />
          <Stat label={t('railIntachain')} value={t('railIntachainState')} />
          <Stat label={t('railBridge')} value={t('railBridgeState')} />
        </div>
      </Panel>
    );
  if (slug === 'protocol' && tab === 'rails')
    body = (
      <>
        {body}
        <BridgeRoutes api={transport} t={t} />
      </>
    );

  return (
    <div className="legacy-room protocol-room" lang={copy.forLocale(language).renderedLocale}>
      <Page
        title={title}
        description={description}
        eyebrow={
          <>
            <span>{t('bannerLine')}</span>
            <span className="badge protocol-pill">{t('bannerPill')}</span>
          </>
        }
      >
        <Tabs
          label={t('subnav')}
          items={tabs.map((entry) => entry.id)}
          value={tab}
          onChange={(id) => navigate(id === tabs[0]!.id ? `/${slug}` : `/${slug}/${id}`)}
          labels={Object.fromEntries(tabs.map((entry) => [entry.id, t(`tab_${entry.id}` as 'tab_status')]))}
        />
        {slug === 'dex' && <TokensNav />}
        {body}
        <Actions actions={actions} snapshot={snapshot} t={t} />
      </Page>
    </div>
  );
}

/** Same room from a pathname such as `/chain/validators`. Returns nothing for any other path. */
export function ParkedProtocolRoomAt({ path }: { path: string }) {
  const [, slug, ...rest] = path.split('/');
  return isProtocolSlug(slug) ? <ParkedProtocolRoom slug={slug} subPath={rest.join('/')} /> : null;
}
