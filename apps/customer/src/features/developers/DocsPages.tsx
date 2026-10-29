import { useState } from 'react';
import { StateBlock } from '@intafaced/ui';
import { useSession } from '../session/session';
import { readServerClock, type ServerClockReading } from '../../shared/server-clock';
import { docsCopy } from './developers-docs-copy';
import { developersCopy } from './developers-copy';
import { connectivityEndpointsLabel, connectivityStateLabel, dataTermLabel } from './developers-labels';
import { liveCopy } from './developers-live-copy';
import { DATA_PRODUCTS, DATA_TERMS, connectivityOptions, hostTable } from './developers-model';
import { hostsView, readDataTerms, readDeveloperHosts, termsView } from './developers-values';
import { useRead } from './use-read';
import {
  CALL_COST,
  NEVER_ON_A_KEY,
  PRODUCTS,
  REST_REFERENCE,
  SIGN_WINDOW_SECONDS,
  STREAM_DOOR_PATH,
  STREAM_REFERENCE,
  permissionTable,
  routeLine,
  scopeText,
  streamName,
  withinWindow,
  type Product,
} from './developers-reference';
import '../public/public-pages.css';
import './developers-docs.css';

type Copy = ReturnType<typeof docsCopy.useCopy>['t'];

function Page({ id, title, lead, children }: { id: string; title: string; lead: string; children: React.ReactNode }) {
  const { t } = docsCopy.useCopy();
  return (
    <div className="pub-page" data-testid={`developers-${id}`}>
      <header className="pub-heading">
        <h1>{title}</h1>
        <p className="muted">{lead}</p>
      </header>
      {children}
      <a className="text-link" href="/developers">
        ← {t('back')}
      </a>
    </div>
  );
}

export function RestPage({ title }: { title: string }) {
  const { t } = docsCopy.useCopy();
  return (
    <Page id="rest" title={title} lead={t('restLead')}>
      <section className="pub-card" aria-labelledby="dev-rest-rules">
        <h2 id="dev-rest-rules">{t('restRulesTitle')}</h2>
        <ul>
          {(['restUrls', 'restJson', 'restTimes', 'restIds', 'restSymbols', 'restDecimals', 'restErrors'] as const).map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </section>
      <section className="pub-notice" role="status">
        <p>{t('restPaging')}</p>
      </section>
    </Page>
  );
}

const productKey = (product: Product) => `product_${product}` as const;

export function ReferencePage({ title }: { title: string }) {
  const { t } = docsCopy.useCopy();
  return (
    <Page id="reference" title={title} lead={t('referenceLead')}>
      {PRODUCTS.map((product) => {
        const routes = REST_REFERENCE.filter((route) => route.product === product);
        const streams = STREAM_REFERENCE.filter((stream) => stream.product === product);
        return (
          <section className="pub-card" key={product} aria-labelledby={`dev-ref-${product}`}>
            <h2 id={`dev-ref-${product}`}>{t(productKey(product))}</h2>
            {routes.length === 0 && streams.length === 0 ? <p>{t('fundingNone')}</p> : null}
            {routes.length ? (
              <div className="table-scroll">
                <table className="pub-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('colRoute')}</th>
                      <th scope="col">{t('colName')}</th>
                      <th scope="col">{t('colPermission')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routes.map((route) => (
                      <tr key={routeLine(route)}>
                        <th scope="row">
                          <code>{routeLine(route)}</code>
                        </th>
                        <td>
                          <code>{route.name}</code>
                          {route.onlyWithFuturesMatching ? <> · {t('onlyWithMatching')}</> : null}
                        </td>
                        <td>
                          {route.access === 'public'
                            ? t('publicRoute', { scope: scopeText(route) })
                            : route.access === 'internal'
                              ? t('internalRoute')
                              : scopeText(route)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {streams.length ? (
              <div className="table-scroll">
                <table className="pub-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('colStream')}</th>
                      <th scope="col">{t('colDoor')}</th>
                      <th scope="col">{t('colPermission')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {streams.map((stream) => (
                      <tr key={`${stream.door} ${stream.channel}`} data-stream-door={stream.door} data-stream-channel={stream.channel}>
                        <th scope="row">
                          <code>{streamName(stream)}</code>
                        </th>
                        <td>
                          {t(`door_${stream.door}`)} <code>{STREAM_DOOR_PATH[stream.door]}</code>
                        </td>
                        <td>{stream.private ? t('privateStream', { scope: 'trade:read' }) : t('publicStream')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        );
      })}
      <p className="muted">{t('referenceMore')}</p>
      <p className="muted">{t('streamsLive')}</p>
    </Page>
  );
}

export function PermissionsPage({ title }: { title: string }) {
  const { t } = docsCopy.useCopy();
  return (
    <Page id="permissions" title={title} lead={t('permissionsLead')}>
      <section className="pub-card">
        <div className="table-scroll">
          <table className="pub-table" aria-label={t('permissionsTable')}>
            <thead>
              <tr>
                <th scope="col">{t('colScope')}</th>
                <th scope="col">{t('colEndpoints')}</th>
              </tr>
            </thead>
            <tbody>
              {permissionTable().map((row) => (
                <tr key={row.scope} data-scope={row.scope}>
                  <th scope="row">
                    <code>{row.scope}</code>
                  </th>
                  <td>
                    <ul>
                      {row.routes.map((route) => (
                        <li key={routeLine(route)}>
                          <code>{routeLine(route)}</code>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
              {NEVER_ON_A_KEY.map((scope) => (
                <tr key={scope} data-scope={scope}>
                  <th scope="row">
                    <code>{scope}</code>
                  </th>
                  <td>{t('neverOnKey')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Page>
  );
}

export function OpenApiPage({ title }: { title: string }) {
  const { t } = docsCopy.useCopy();
  return (
    <Page id="openapi" title={title} lead={t('openapiLead')}>
      <section className="pub-card">
        <ul>
          <li>
            <a className="text-link" href="/developers/openapi.json" download="trading-api.openapi.json">
              {t('openapiDownload')}
            </a>
          </li>
          <li>
            <a className="text-link" href="/developers/collection.json" download="trading-api.collection.json">
              {t('collectionDownload')}
            </a>
          </li>
          <li>
            <a className="text-link" href="/developers/llms.txt">
              {t('llmsOpen')}
            </a>
          </li>
        </ul>
        <p className="muted">{t('openapiCost', { cost: CALL_COST })}</p>
        <p className="muted">{t('openapiHosts')}</p>
      </section>
    </Page>
  );
}

type ClockState = { status: 'idle' } | { status: 'checking' } | { status: 'failed' } | { status: 'ready'; reading: ServerClockReading };

/** The clock check: a button, then the offset and round trip, and whether this clock is inside the signing window. */
export function ClockCheck({ testId }: { testId: string }) {
  const { t } = docsCopy.useCopy();
  const { api } = useSession();
  const [state, setState] = useState<ClockState>({ status: 'idle' });
  const check = async () => {
    setState({ status: 'checking' });
    const result = await readServerClock(api);
    setState(result.ok ? { status: 'ready', reading: result.data } : { status: 'failed' });
  };
  return (
    <div className="pub-form">
      <button type="button" className="button button--primary" onClick={() => void check()} disabled={state.status === 'checking'}>
        {state.status === 'checking' ? t('clockChecking') : t('clockCheck')}
      </button>
      <ClockResult state={state} testId={testId} t={t} />
      <p className="muted">{t('clockHow')}</p>
    </div>
  );
}

function ClockResult({ state, testId, t }: { state: ClockState; testId: string; t: Copy }) {
  if (state.status === 'failed')
    return (
      <p role="alert" data-testid={testId}>
        {t('clockFailed')}
      </p>
    );
  if (state.status !== 'ready') return <div data-testid={testId} aria-live="polite" />;
  const { offsetMs, roundTripMs } = state.reading;
  const within = withinWindow(offsetMs, roundTripMs);
  return (
    <div data-testid={testId} aria-live="polite" data-clock-window={within ? 'within' : 'outside'}>
      <p>{t('clockOffset', { offset: String(offsetMs) })}</p>
      <p>{t('clockRoundTrip', { rtt: String(roundTripMs) })}</p>
      <p>{within ? t('clockWithin', { seconds: SIGN_WINDOW_SECONDS }) : t('clockOutside', { seconds: SIGN_WINDOW_SECONDS })}</p>
    </div>
  );
}

export function QuickstartPage({ title }: { title: string }) {
  const { t } = docsCopy.useCopy();
  const steps = [
    { key: 'account', title: t('stepAccount'), body: t('stepAccountBody'), link: { href: '/register', label: t('stepAccountLink') } },
    { key: 'key', title: t('stepKey'), body: t('stepKeyBody'), link: { href: '/uc/safe/api-keys', label: t('stepKeyLink') } },
    { key: 'clock', title: t('stepClock'), body: t('stepClockBody') },
    { key: 'call', title: t('stepCall'), body: t('stepCallBody'), link: { href: '/developers/reference', label: t('stepCallLink') } },
  ];
  return (
    <Page id="quickstart" title={title} lead={t('quickstartLead')}>
      <ol className="pub-steps" aria-label={t('quickstartSteps')}>
        {steps.map((step, index) => (
          <li className="pub-step" key={step.key} data-step={step.key}>
            <span className="pub-step__number">{t('stepLabel', { n: index + 1 })}</span>
            <h2>{step.title}</h2>
            <p>{step.body}</p>
            {step.key === 'clock' ? <ClockCheck testId="developers-clock-check" /> : null}
            {step.link ? (
              <a className="text-link" href={step.link.href}>
                {step.link.label} →
              </a>
            ) : null}
          </li>
        ))}
      </ol>
    </Page>
  );
}

export function ConnectivityPage({ title }: { title: string }) {
  const { t } = docsCopy.useCopy();
  const { t: portal } = developersCopy.useCopy();
  const { t: live } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readDeveloperHosts(api, signal), [api]);
  const view = hostsView(read);
  // The parked options name their hardware blocker whatever the hosts read says; only the host rows wait for it.
  const options =
    view.kind === 'table'
      ? connectivityOptions(hostTable(view.read))
      : connectivityOptions().filter(({ state }) => state === 'parked_hardware');
  return (
    <Page id="connectivity" title={title} lead={t('connectivityLead')}>
      <section className="pub-card" aria-labelledby="dev-conn-options">
        <h2 id="dev-conn-options">{t('connectivityTable')}</h2>
        {view.kind === 'loading' ? (
          <StateBlock kind="loading" rows={2} rowHeight={48} label={live('loading')} />
        ) : view.kind === 'failed' ? (
          <StateBlock kind="error" title={live('loadFailed')} onRetry={reload} retryLabel={live('tryAgain')} />
        ) : view.unsetCode ? (
          <p className="pub-notice" role="status" data-testid="developers-connectivity-unset" data-code={view.unsetCode}>
            {portal('hostsUnpublished')}
          </p>
        ) : null}
        <div className="table-scroll">
          <table className="pub-table">
            <thead>
              <tr>
                <th scope="col">{t('colOption')}</th>
                <th scope="col">{t('colStatus')}</th>
                <th scope="col">{t('colEndpoints2')}</th>
              </tr>
            </thead>
            <tbody>
              {options.map(({ option, state, hosts }) => (
                <tr key={option} data-option={option} data-option-state={state}>
                  <th scope="row">{t(`option_${option}`)}</th>
                  <td>{connectivityStateLabel(t, state)}</td>
                  <td>
                    {connectivityEndpointsLabel(t, option)}
                    {hosts.length ? (
                      <ul aria-label={t(`option_${option}`)}>
                        {hosts.map(({ protocol, cell }) => (
                          <li key={protocol} data-protocol={protocol} data-host-state={cell.state}>
                            {portal(`protocol_${protocol}` as const)}:{' '}
                            {cell.state === 'set' ? <code>{cell.host}</code> : portal('hostUnset')}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <a className="text-link" href="/developers/hosts">
          {t('hostsLink')} →
        </a>
      </section>
      <section className="pub-card" aria-labelledby="dev-conn-time">
        <h2 id="dev-conn-time">{t('timeTitle')}</h2>
        <p>{t('timeLead')}</p>
        <ClockCheck testId="developers-time-probe" />
      </section>
    </Page>
  );
}

export function DataTermsPage({ title }: { title: string }) {
  const { t } = docsCopy.useCopy();
  const { t: live } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readDataTerms(api, signal), [api]);
  const view = termsView(read);
  return (
    <Page id="data-terms" title={title} lead={t('dataTermsLead')}>
      <section className="pub-card" aria-labelledby="dev-data-terms">
        <h2 id="dev-data-terms">{t('dataTermsTable')}</h2>
        {view.kind === 'loading' ? (
          <StateBlock kind="loading" rows={6} rowHeight={32} label={live('loading')} />
        ) : view.kind === 'failed' ? (
          <StateBlock kind="error" title={live('loadFailed')} onRetry={reload} retryLabel={live('tryAgain')} />
        ) : (
          <>
            {view.unsetCode ? (
              <p className="pub-notice" role="status" data-testid="developers-data-terms-unset" data-code={view.unsetCode}>
                {t('dataTermsWaits')}
              </p>
            ) : null}
            <div className="table-scroll">
              <table className="pub-table">
                <thead>
                  <tr>
                    <th scope="col">{t('colProduct')}</th>
                    {DATA_TERMS.map((term) => (
                      <th scope="col" key={term}>
                        {dataTermLabel(t, term)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DATA_PRODUCTS.map((product) => {
                    const terms = view.termsOf(product);
                    return (
                      <tr key={product} data-product={product} data-terms-state={terms ? 'set' : 'unset'}>
                        <th scope="row">{t(`product_${product}`)}</th>
                        {DATA_TERMS.map((term) => (
                          <td key={term}>{terms ? terms[term] : t('termUnset')}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </Page>
  );
}
