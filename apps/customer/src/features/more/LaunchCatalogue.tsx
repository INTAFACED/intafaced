// hand-declared-ok: svc-token's launch outputs are declared in its launch router; packages/contracts has no token schemas yet
import { useState, type ReactNode } from 'react';
import { useApi, useSession } from '../session';
import { useResource, type Resource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { Button, Select, Tag } from '@intafaced/ui/lit';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { Details, Limit } from './catalogue-parts';
import { launchCatalogueCopy } from './launch-catalogue-copy';
import { launchCopy } from './launch-copy';
import { moreRoomRoutesCopy } from './more-room-routes-copy';
import { SessionRetryNote, SignInNote } from './sign-in-note';
import { EmptyNote, KitRead, Section } from './volt-parts';
import {
  TOKEN_LAUNCH_EVENTS_LIST,
  TOKEN_LAUNCH_EVENTS_GET,
  TOKEN_LAUNCH_ELIGIBILITY,
  TOKEN_LAUNCH_BASIS,
} from '@intafaced/contracts/token-launch-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type T = ReturnType<typeof launchCatalogueCopy.forLocale>['t'];
/** A key built from a service enum (`s_open`, `req_region`); every such key is in the copy and takes no parameters. */
const word = (t: T, key: string) => (t as unknown as (k: string) => string)(key);

const TYPES = ['token_sale', 'whitelist_drop', 'primary_subscription'] as const;
const STATES = ['upcoming', 'open', 'past'] as const;
/** The first page of launches, and the most a reader may widen it to. The service refuses a blank page size. */
const PAGE = 50;
const PAGE_CAP = 200;

type LaunchEvent = ProcedureOutput<typeof TOKEN_LAUNCH_EVENTS_GET>;
type Eligibility = ProcedureOutput<typeof TOKEN_LAUNCH_ELIGIBILITY>;

function useT(): T {
  const { language } = usePreferences();
  return launchCatalogueCopy.forLocale(language).t;
}

/** A UTC minute for a service timestamp; the `datetime` attribute keeps the exact value. */
function When({ at }: { at: string }) {
  return <time dateTime={at}>{`${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`}</time>;
}

/** Plain words for a refused read. The service's typed code picks the sentence; prose is a fallback. */
function refusalWords(failure: Refusal, t: T): string {
  if (failure.reason === 'uncertain') return t('uncertain');
  switch (failure.code) {
    case 'launch.event_not_found':
      return t('refusedNotFound');
    case 'launch.min_kyc_tier_unset':
      return t('refusedTierUnset');
    case 'launch.restricted_regions_unset':
      return t('refusedRegionsUnset');
    case 'launch.eligibility_unavailable':
      return t('refusedUnavailable');
    default:
      return t('refusedOther', { message: failure.message });
  }
}

/** Upcoming, open or past for the card badge; a past launch reads "Ended". */
const stateWord = (e: LaunchEvent, t: T) => (e.state === 'past' ? t('ended') : e.state ? t(e.state) : word(t, `s_${e.status}`));

/** The published launches (J-more-catalogue-11 #1, #2): type and state filters, one card per event with its issuer state. */
export function LaunchCatalogue() {
  const api = useApi();
  const t = useT();
  const [type, setType] = useState('');
  const [state, setState] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const list = useResource(
    (signal) =>
      api.call(
        TOKEN_LAUNCH_EVENTS_LIST,
        { limit, ...(type ? { type } : {}), ...(state ? { state } : {}) },
        {
          signal,
        },
      ),
    `launch-list:${type}:${state}:${limit}`,
  );
  const filtered = type !== '' || state !== '';
  return (
    <Section title={t('events')}>
      <div>
        <div className="lt-toolbar">
          <Select
            label={t('type')}
            value={type}
            onChange={setType}
            options={[{ value: '', label: t('all') }, ...TYPES.map((v) => ({ value: v, label: t(v) }))]}
          />
          <Select
            label={t('state')}
            value={state}
            onChange={setState}
            options={[{ value: '', label: t('all') }, ...STATES.map((v) => ({ value: v, label: t(v) }))]}
          />
        </div>
        <KitRead resource={list.resource} retry={list.reload}>
          {(events) =>
            events.length === 0 ? (
              <EmptyNote title={filtered ? t('emptyFiltered') : t('emptyAll')}>{filtered ? null : t('emptyAllBody')}</EmptyNote>
            ) : (
              <>
                <small className="lt-hint">{t('count', { count: String(events.length), limit: String(limit) })}</small>
                <ul className="lt-grid" aria-label={t('events')}>
                  {events.map((e) => (
                    <li key={e.id}>
                      <a className="lt-link" href={`/launch/${encodeURIComponent(e.id)}`}>
                        {`${e.projectName} (${e.symbol})`}
                      </a>
                      <Tag tone="neutral" data-testid="launch-state">
                        {stateWord(e, t)}
                      </Tag>
                      <Details
                        items={[
                          [t('type'), t(e.type)],
                          [t('issuer'), e.issuer.name],
                          [t('issuerState'), <span data-testid="launch-issuer-state">{t(e.issuer.state)}</span>],
                          [t('opens'), <When at={e.periods.openAt} />],
                          [t('closes'), <When at={e.periods.closeAt} />],
                        ]}
                      />
                    </li>
                  ))}
                </ul>
                <Limit count={events.length} limit={limit} cap={PAGE_CAP} onChange={setLimit} />
              </>
            )
          }
        </KitRead>
      </div>
    </Section>
  );
}

/** One launch at /launch/<id> (J-more-catalogue-11 #3 to #5): periods, issuer state, allocation, terms, eligibility, basis. */
export function LaunchDetail({ eventId }: { eventId: string }) {
  const api = useApi();
  const t = useT();
  const read = useResource((signal) => api.call(TOKEN_LAUNCH_EVENTS_GET, { id: eventId }, { signal }), `launch:${eventId}`);
  const scope = launchCopy.useCopy().t('scope');
  const notFound = read.resource.status === 'failed' && read.resource.failure.code === 'launch.event_not_found';
  return (
    <CatalogueTemplate
      title={moreRoomRoutesCopy.t('launchProject')}
      description={scope}
      state={{ kind: 'ready' }}
      items={null}
      item={
        notFound ? (
          <Section title={t('refusedNotFound')}>
            <EmptyNote title={t('refusedNotFound')} />
            <a className="lt-link" href="/launch">
              {t('back')}
            </a>
          </Section>
        ) : (
          <LaunchBody resource={read.resource} retry={read.reload} />
        )
      }
    />
  );
}

function LaunchBody({ resource, retry }: { resource: Resource<LaunchEvent>; retry: () => void }) {
  const t = useT();
  return (
    <KitRead resource={resource} retry={retry}>
      {(e) => (
        <div>
          <a className="lt-link" href="/launch">
            {t('back')}
          </a>
          <Section title={`${e.projectName} (${e.symbol})`}>
            <Details
              items={[
                [t('type'), t(e.type)],
                [t('status'), word(t, `s_${e.status}`)],
                [t('issuer'), e.issuer.name],
                [t('issuerState'), <span data-testid="launch-issuer-state">{t(e.issuer.state)}</span>],
                [t('announceAt'), <When at={e.periods.announceAt} />],
                [t('snapshotAt'), <When at={e.periods.snapshotAt} />],
                [t('openAt'), <When at={e.periods.openAt} />],
                [t('closeAt'), <When at={e.periods.closeAt} />],
                [t('distributionAt'), <When at={e.periods.distributionAt} />],
                [
                  t('snapshot'),
                  e.snapshot ? t('snapshotSealed', { count: String(e.snapshot.count), total: e.snapshot.total }) : t('snapshotNone'),
                ],
              ]}
            />
          </Section>
          <div className="lt-grid">
            <Region id="allocation" title={t('allocation')}>
              <Details
                items={[
                  [t('method'), e.allocation.method ? t(e.allocation.method) : t('notSet')],
                  [t('cap'), e.allocation.perUserCap ? `${e.allocation.perUserCap} ${e.symbol}` : t('notSet')],
                  [t('ticketSize'), e.allocation.ticketSize ? `${e.allocation.ticketSize} IFC` : t('notSet')],
                  [t('weights'), <Weights weights={e.allocation.tierWeights} t={t} />],
                ]}
              />
            </Region>
            <Region id="terms" title={t('terms')}>
              <Details
                items={[
                  [t('price'), e.terms.price && e.terms.paymentAsset ? `${e.terms.price} ${e.terms.paymentAsset}` : t('priceNotSet')],
                  [t('currency'), e.terms.paymentAsset ?? t('notSet')],
                  [t('rate'), e.terms.rateSource ?? t('rateNotSet')],
                ]}
              />
            </Region>
          </div>
          <EligibilityCheck event={e} />
          <YourBasis event={e} />
        </div>
      )}
    </KitRead>
  );
}

/** A titled section, so a reader (and assistive tech) finds it as a named region. */
function Region({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const heading = `launch-${id}-title`;
  return (
    <section aria-labelledby={heading}>
      <h3 id={heading}>{title}</h3>
      {children}
    </section>
  );
}

function Weights({ weights, t }: { weights: LaunchEvent['allocation']['tierWeights']; t: T }) {
  if (!weights || weights.length === 0) return <>{t('notSet')}</>;
  return (
    <ul>
      {weights.map((w) => (
        <li key={w.minBasis}>{t('weight', { minBasis: w.minBasis, weight: String(w.weight) })}</li>
      ))}
    </ul>
  );
}

/** The requirements list for this account, each item met or not; a blank rule or an unread account refuses. */
function EligibilityCheck({ event }: { event: LaunchEvent }) {
  const api = useApi();
  const t = useT();
  const { userId } = useSession();
  const [result, setResult] = useState<ApiResult<Eligibility> | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      setResult(await api.call(TOKEN_LAUNCH_ELIGIBILITY, { id: event.id }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Region id="eligibility" title={t('eligibility')}>
      {userId ? (
        <Button tone="primary" onClick={() => void check()} disabled={busy}>
          {t('check')}
        </Button>
      ) : (
        <SignedOut event={event} />
      )}
      {result && !result.ok ? (
        <p role="alert">{refusalWords(result, t)}</p>
      ) : result?.ok ? (
        <>
          <p role="status">{result.data.eligible ? t('eligible') : t('notEligible')}</p>
          <ul aria-label={t('requirements')}>
            {result.data.requirements.map((r) => (
              <li key={r.id} data-met={r.met}>
                <strong>{word(t, `req_${r.id}`)}</strong>
                {/* The hook J-more-catalogue-11 #4 and its end find the badge by; the kit's Tag draws it. */}
                <Tag tone={r.met ? 'up' : 'down'} data-testid="launch-requirement-badge">
                  {r.met ? t('met') : t('unmet')}
                </Tag>
                <small className="lt-hint">{t('needs', { required: r.required, actual: r.actual })}</small>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Region>
  );
}

/**
 * A part of a public launch that needs an account, seen signed out: the sign-in panel the other More rooms use, returning
 * to this launch (J-more-catalogue-01 #6). If the boot refresh could not answer, Retry.
 */
function SignedOut({ event }: { event: LaunchEvent }) {
  const t = useT();
  const { restoreFailed, retryRestore } = useSession();
  if (restoreFailed) return <SessionRetryNote retry={retryRestore} />;
  return <SignInNote returnTo={`/launch/${event.id}`}>{t('signIn')}</SignInNote>;
}

/** This account's stored snapshot row and what the rule makes of it. Nothing here is computed in the browser. */
function YourBasis({ event }: { event: LaunchEvent }) {
  const t = useT();
  const { userId } = useSession();
  return (
    <Region id="basis" title={t('basis')}>
      {userId ? <BasisRead event={event} userId={userId} /> : <SignedOut event={event} />}
    </Region>
  );
}

function BasisRead({ event, userId }: { event: LaunchEvent; userId: string }) {
  const api = useApi();
  const t = useT();
  const read = useResource((signal) => api.call(TOKEN_LAUNCH_BASIS, { id: event.id }, { signal }), `launch-basis:${event.id}:${userId}`);
  if (read.resource.status === 'failed') return <p role="alert">{refusalWords(read.resource.failure, t)}</p>;
  return (
    <KitRead resource={read.resource} retry={read.reload}>
      {(b) => (
        <>
          {b.reason === 'snapshot_not_taken' ? <p className="lt-hint">{t('basisNoSnapshot')}</p> : null}
          {b.reason === 'no_holdings_at_snapshot' ? <p className="lt-hint">{t('basisNoHoldings')}</p> : null}
          <Details
            items={[
              [t('basisAmount'), b.basis ? <span data-testid="launch-basis">{t('basisValue', { amount: b.basis })}</span> : t('notSet')],
              [t('takenAt'), b.takenAt ? <When at={b.takenAt} /> : t('snapshotNone')],
              [t('method'), b.method ? t(b.method) : t('notSet')],
              [t('cap'), b.perUserCap ? <span data-testid="launch-cap">{`${b.perUserCap} ${event.symbol}`}</span> : t('notSet')],
              ...(b.method === 'tickets' ? [[t('ticketCount'), b.tickets ?? t('notSet')] as [string, string]] : []),
              ...(b.method === 'tiered'
                ? [[t('tierWeight'), b.tierWeight === null ? t('notSet') : String(b.tierWeight)] as [string, string]]
                : []),
            ]}
          />
        </>
      )}
    </KitRead>
  );
}
