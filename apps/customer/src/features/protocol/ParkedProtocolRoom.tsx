import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { navigate } from '../../app/location';
import { useApi } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Page, Panel, Stat, Tabs } from '../../shared/ui';
import { createProtocolApi, type DexQuote } from './api';
import { BLOCKER_REFUSAL } from '@intafaced/contracts/protocol-blockers';
import { ServiceOffNotice } from '../../shared/service-off';
import {
  blockersFor,
  chainReasonWords,
  isServiceNotConnected,
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
import { ContractsPanel, type ChainRef, NetworkPanel, SupportedNetworksPanel } from './NetworkPanels';
import './protocol.css';

type Translate = ReturnType<typeof copy.forLocale>['t'];
type Resource<T> = ReturnType<typeof useResource<T>>;

const slugs: readonly Slug[] = ['chain', 'dex', 'protocol'];
export function isProtocolSlug(value: string | undefined): value is Slug {
  return slugs.includes(value as Slug);
}

export function toSource<T>(value: Resource<T>): Source<T> {
  const { resource } = value;
  return resource.status === 'loading'
    ? { status: 'loading' }
    : resource.status === 'ready'
      ? { status: 'ok', data: resource.data }
      : { status: 'down', reason: resource.failure.reason, message: resource.failure.message, code: resource.failure.code };
}

/** The gateway's answer when the service did not reply: a crash, a restart or a service that is not running. */
const NO_ANSWER_CODE = 'edge.upstream_unavailable';
/**
 * The retry window: the room asks again on its own, and a person may ask again too. After this many no-answer replies in a
 * row, a second attempt is no longer worth offering, so the room says the service is not running here and hides Try again.
 */
export const NO_ANSWER_ATTEMPTS = 3;
export const NO_ANSWER_RETRY_MS = 4000;

/** The service did not reply. Inside the retry window it offers Try again; once the window has closed it says the service is not running here. */
export function NoAnswerNote({ service, closed, reload, t }: { service: string; closed: boolean; reload: () => void; t: Translate }) {
  return closed ? (
    <div data-testid="failure" className="failure" role="status">
      <h3>{t('serviceNotRunning', { service })}</h3>
      <p>{t('serviceNotRunningBody')}</p>
    </div>
  ) : (
    <div data-testid="failure" className="failure" role="status">
      <h3>{t('serviceNoAnswer', { service })}</h3>
      <p>{t('serviceNoAnswerBody')}</p>
      <Button variant="secondary" onClick={reload}>
        {t('tryAgain')}
      </Button>
    </div>
  );
}

/** True once the retry window has run out of attempts. Any other answer starts the count again. */
function useNoAnswerWindow<T>({ resource, reload }: Resource<T>): boolean {
  const [failures, setFailures] = useState(0);
  const latest = useRef(reload);
  latest.current = reload;
  const noAnswer = resource.status === 'failed' && resource.failure.code === NO_ANSWER_CODE;
  const counted = useRef<unknown>(null);
  useEffect(() => {
    if (resource.status === 'loading' || counted.current === resource) return;
    counted.current = resource;
    setFailures((count) => (noAnswer ? count + 1 : 0));
  }, [resource, noAnswer]);
  useEffect(() => {
    if (!noAnswer || failures === 0 || failures >= NO_ANSWER_ATTEMPTS) return;
    const timer = setTimeout(() => latest.current(), NO_ANSWER_RETRY_MS);
    return () => clearTimeout(timer);
  }, [noAnswer, failures]);
  return failures >= NO_ANSWER_ATTEMPTS;
}

/**
 * Render one service answer: spinner while it is in flight (the API client times out at 15s), a typed refuse when it fails.
 * With a `shell`, a failed answer keeps the table's column headers and says why the table is empty.
 * The gateway's "not connected" answer (edge.upstream_unwired) hides Try again, because a second attempt cannot change it.
 * A plain 502 (edge.upstream_unavailable) only says the service did not answer, which may be a crash or a restart, so it
 * is worded that way and keeps Try again; it is never dressed up as "not connected". If the retry window passes with no reply
 * (see NO_ANSWER_ATTEMPTS), the room says the service is not running here and Try again goes.
 */
export function Answer<T>({
  value,
  source,
  t,
  children,
  shell,
  service,
}: {
  value: Resource<T>;
  source: string;
  /** The service behind this answer, named in the "not connected" sentence. Defaults to Protocol. */
  service?: string;
  t: Translate;
  children: (data: T) => ReactNode;
  shell?: { label: string; headers: readonly ReactNode[] };
}) {
  const { resource, reload } = value;
  const windowClosed = useNoAnswerWindow(value);
  if (resource.status === 'loading') return <Loading label={t('checking', { source })} />;
  if (resource.status === 'failed') {
    const notConnected = isServiceNotConnected(resource.failure.code);
    const words = t('serviceNotConnected', { service: service ?? t('svc_protocol') });
    const noAnswer = !notConnected && resource.failure.code === NO_ANSWER_CODE;
    const reason = notConnected ? (
      <div data-testid="failure" className="failure" role="status">
        <p>{words}</p>
      </div>
    ) : noAnswer ? (
      <NoAnswerNote service={service ?? t('svc_protocol')} closed={windowClosed} reload={reload} t={t} />
    ) : (
      <Failure result={resource.failure} retry={reload} />
    );
    if (shell)
      return (
        <div className="protocol-refuse" data-source={source}>
          <DataTable label={shell.label} headers={shell.headers}>
            <tr>
              <td colSpan={shell.headers.length}>{notConnected ? <EmptyState title={words} /> : reason}</td>
            </tr>
          </DataTable>
        </div>
      );
    return (
      <div className="protocol-refuse" data-source={source}>
        <p className="protocol-refuse__title">{t('unreachableTitle', { source })}</p>
        {reason}
      </div>
    );
  }
  return <>{children(resource.data)}</>;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const flag = (t: Translate, value: boolean) => (value ? t('yes') : t('no'));
const orNone = (t: Translate, value: string | number | null | undefined) =>
  value === null || value === undefined ? t('notReturned') : String(value);

export function Actions({ actions, snapshot, t }: { actions: readonly ProtocolAction[]; snapshot: ProtocolSnapshot; t: Translate }) {
  if (actions.length === 0) return null;
  return (
    <Panel title={t('actionsTitle')}>
      <p className="muted">{t('actionsNote')}</p>
      <ul className="protocol-actions">
        {actions.map((action) => {
          const found = blockersFor(action, snapshot);
          const first = found[0] as Blocker;
          // Two checks can wait on the same source and read the same sentence (venue and finality both need the indexer):
          // the list says each sentence once.
          const listed = [...new Map(found.map((entry) => [capital(t(entry.key, entry.params)), entry.code] as const)).entries()];
          const reason = t(first.key, first.params);
          // On its own (button title) the sentence starts a capital; after "Blocked:" it reads on from the colon.
          const standalone = capital(reason);
          const refusal = BLOCKER_REFUSAL[first.code];
          return (
            <li key={action} data-action={action}>
              <Button variant="secondary" disabled aria-disabled="true" title={standalone}>
                {t(`act_${action}`)}
              </Button>
              {refusal ? (
                // An outside dependency (the allowlist): the shell's one service-off sentence and code.
                <ServiceOffNotice code={refusal} action={t(`act_${action}`)} className="protocol-actions__reason" role="note" />
              ) : (
                // Our own gap or a plain state: its reason, never an allowlist code.
                <p className="protocol-actions__reason" role="note">
                  {t('blockedBy', { reason })}
                </p>
              )}
              {listed.length > 1 && (
                <details>
                  <summary>{t('allBlockers')}</summary>
                  <ol>
                    {listed.map(([sentence, code]) => (
                      <li key={sentence} data-blocker={code}>
                        {sentence}
                      </li>
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
        {chainStatusPanel}
        <NetworkPanel chain={chainRef} t={t} />
      </>
    );
  else if (slug === 'chain' && tab === 'blocks')
    body = (
      <Panel title={t('tab_blocks')}>
        <p className="muted">{t('blocksNote')}</p>
        <DataTable label={t('tab_blocks')} headers={[t('hdr_block'), t('hdr_time'), t('hdr_status')]}>
          <tr>
            <td colSpan={3}>
              <EmptyState title={t('blocksEmpty')} />
            </td>
          </tr>
        </DataTable>
        <Answer value={indexer} source={t('src_indexer')} service={t('svc_indexer')} t={t}>
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
        <DataTable label={t('poolsTitle')} headers={[t('hdr_pool'), t('hdr_pair'), t('hdr_liquidity')]}>
          <tr>
            <td colSpan={3}>
              <EmptyState title={t('poolsEmpty')} />
            </td>
          </tr>
        </DataTable>
        <Answer value={dex} source={t('src_dex')} service={t('svc_dex')} t={t}>
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
  else if (slug === 'dex' && tab === 'venue')
    body = (
      <>
        {venuePanel}
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
  else if (slug === 'protocol' && tab === 'contracts') body = <ContractsPanel chain={chainRef} t={t} />;
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
