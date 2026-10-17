import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useApi } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Page, Panel, Stat, Tabs } from '../../shared/ui';
import { createProtocolApi, type DexQuote } from './api';
import {
  blockersFor,
  networkLabel,
  SUBNAV,
  tabFromSubPath,
  type Blocker,
  type ProtocolAction,
  type ProtocolSnapshot,
  type Slug,
  type Source,
} from './blockers';
import { protocolCopy as copy } from './copy';
import { BASE_SEPOLIA_DEPLOYMENT } from './deployments';
import './protocol.css';

type Translate = ReturnType<typeof copy.forLocale>['t'];
type Resource<T> = ReturnType<typeof useResource<T>>;

const slugs: readonly Slug[] = ['chain', 'dex', 'protocol'];
export function isProtocolSlug(value: string | undefined): value is Slug {
  return slugs.includes(value as Slug);
}

function toSource<T>(value: Resource<T>): Source<T> {
  const { resource } = value;
  return resource.status === 'loading'
    ? { status: 'loading' }
    : resource.status === 'ready'
      ? { status: 'ok', data: resource.data }
      : { status: 'down', reason: resource.failure.reason, message: resource.failure.message };
}

/** Render one service answer: spinner while it is in flight (the API client times out at 15s), a typed refuse when it fails. */
function Answer<T>({ value, source, t, children }: { value: Resource<T>; source: string; t: Translate; children: (data: T) => ReactNode }) {
  const { resource, reload } = value;
  if (resource.status === 'loading') return <Loading label={t('checking', { source })} />;
  if (resource.status === 'failed')
    return (
      <div className="protocol-refuse" data-source={source}>
        <p className="protocol-refuse__title">{t('unreachableTitle', { source })}</p>
        <Failure result={resource.failure} retry={reload} />
      </div>
    );
  return <>{children(resource.data)}</>;
}

const flag = (t: Translate, value: boolean) => (value ? t('yes') : t('no'));
const orNone = (t: Translate, value: string | number | null | undefined) =>
  value === null || value === undefined ? t('notReturned') : String(value);

function Actions({ actions, snapshot, t }: { actions: readonly ProtocolAction[]; snapshot: ProtocolSnapshot; t: Translate }) {
  if (actions.length === 0) return null;
  return (
    <Panel title={t('actionsTitle')}>
      <p className="muted">{t('actionsNote')}</p>
      <ul className="protocol-actions">
        {actions.map((action) => {
          const found = blockersFor(action, snapshot);
          const first = found[0] as Blocker;
          const reason = t(first.key, first.params);
          return (
            <li key={action} data-action={action}>
              <Button variant="secondary" disabled aria-disabled="true" title={reason}>
                {t(`act_${action}`)}
              </Button>
              <p className="protocol-actions__reason" role="note">
                {t('blockedBy', { reason })}
              </p>
              {found.length > 1 && (
                <details>
                  <summary>{t('allBlockers')}</summary>
                  <ol>
                    {found.map((entry) => (
                      <li key={entry.code}>{t(entry.key, entry.params)}</li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Rows({ rows, t }: { rows: ReadonlyArray<readonly [string, ReactNode]>; t: Translate }) {
  void t;
  return (
    <dl className="protocol-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="numeric">{value}</dd>
        </div>
      ))}
    </dl>
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
          [t('executable'), flag(t, quote.executable)],
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
 * Nothing here is labelled INTACHAIN, mainnet or audited.
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
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const tab = chosen ?? tabFromSubPath(slug, subPath);
  const tabs = SUBNAV[slug];
  const actions = tabs.find((entry) => entry.id === tab)?.actions ?? [];
  const configuredChainId = chain.resource.status === 'ready' ? chain.resource.data.configuredChainId : null;
  const label = networkLabel(configuredChainId);
  const title = slug === 'chain' ? t('titleChain') : slug === 'dex' ? t('titleDex') : t('titleProtocol');
  const description = slug === 'chain' ? t('descChain') : slug === 'dex' ? t('descDex') : t('descProtocol');

  const chainStatusPanel = (
    <Panel title={t('tab_status')}>
      <Answer value={chain} source="protocol.chainStatus" t={t}>
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
              ...(c.refusalCode || c.reason ? ([[t('refusalReason'), `${c.refusalCode ?? ''} ${c.reason ?? ''}`.trim()]] as const) : []),
            ]}
          />
        )}
      </Answer>
    </Panel>
  );
  const auditPanel = (
    <Panel title={t('auditTitle')}>
      <Answer value={audit} source="protocol.auditStatus" t={t}>
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
      <Answer value={indexer} source="indexer.status" t={t}>
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
      <Answer value={dex} source="dex.health" t={t}>
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
  if (slug === 'chain' && tab === 'status') body = chainStatusPanel;
  else if (slug === 'chain' && tab === 'blocks')
    body = (
      <Panel title={t('tab_blocks')}>
        <p className="muted">{t('blocksNote')}</p>
        <Answer value={indexer} source="indexer.status" t={t}>
          {(i) => (
            <>
              <Rows
                t={t}
                rows={[
                  [t('chainSource'), i.chainSource],
                  [t('indexedHeight'), orNone(t, i.indexedHeight)],
                  [t('finalizedHeight'), orNone(t, i.finalizedHeight)],
                  [t('finalityDepth'), i.finalityDepth],
                  [t('behindBy'), orNone(t, i.behindBy)],
                  [t('ingest'), flag(t, i.ingestEnabled)],
                  [t('halted'), i.halted ? t('haltedAt', { reason: i.halted.reason, at: i.halted.at }) : t('notHalted')],
                  [t('lastError'), i.lastError ? `${i.lastError.code ?? ''} ${i.lastError.message}`.trim() : t('noLastError')],
                ]}
              />
              {i.finalizedHeight === null && <p className="muted">{t('notFinal')}</p>}
            </>
          )}
        </Answer>
      </Panel>
    );
  else if (slug === 'chain' && tab === 'validators')
    body = (
      <Panel title={t('validatorsTitle')}>
        <DataTable label={t('validatorsTitle')} headers={[t('hdr_validator'), t('hdr_stake'), t('hdr_status')]}>
          <tr>
            <td colSpan={3}>
              <EmptyState title={t('validatorsEmpty')} />
            </td>
          </tr>
        </DataTable>
      </Panel>
    );
  else if (tab === 'audit') body = auditPanel;
  else if (slug === 'dex' && tab === 'swap') body = <QuoteDesk api={api} t={t} />;
  else if (slug === 'dex' && tab === 'pools')
    body = (
      <Panel title={t('poolsTitle')}>
        <p className="muted">{t('poolsNote')}</p>
        <Answer value={dex} source="dex.health" t={t}>
          {(d) => <Rows t={t} rows={[[t('ammWired'), flag(t, d.ammVenueWired)]]} />}
        </Answer>
      </Panel>
    );
  else if (slug === 'dex' && tab === 'positions')
    body = (
      <Panel title={t('positionsTitle')}>
        <EmptyState title={t('positionsEmpty')} />
      </Panel>
    );
  else if (slug === 'dex' && tab === 'venue') body = venuePanel;
  else if (slug === 'protocol' && tab === 'overview')
    body = (
      <>
        {chainStatusPanel}
        <Panel title={t('tab_overview')}>
          <Answer value={health} source="protocol.health" t={t}>
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
  else if (slug === 'protocol' && tab === 'contracts')
    body = (
      <Panel title={t('contractsTitle')}>
        <p className="muted">{t('contractsNote')}</p>
        <DataTable label={t('contractsTitle')} headers={[t('hdr_contract'), t('hdr_suite'), t('hdr_address')]}>
          {BASE_SEPOLIA_DEPLOYMENT.contracts.map((contract) => (
            <tr key={contract.address}>
              <td>{contract.name}</td>
              <td>{contract.suite}</td>
              <td className="numeric">{contract.address}</td>
            </tr>
          ))}
        </DataTable>
      </Panel>
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

  return (
    <div className="legacy-room protocol-room" lang={copy.forLocale(language).renderedLocale}>
      <Page title={title} description={description} eyebrow={`${label.name}, ${t('banner')}`}>
        <Tabs
          label={t('subnav')}
          items={tabs.map((entry) => entry.id)}
          value={tab}
          onChange={setChosen}
          labels={Object.fromEntries(tabs.map((entry) => [entry.id, t(`tab_${entry.id}` as 'tab_status')]))}
        />
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
