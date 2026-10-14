'use client';
/**
 * The founder CRM, front to back: Inbox (who is waiting on us), Raise, People, and the quiet Tools. One person can be open
 * beside any of the three lists. This component owns the lists and the address bar; `usePerson` owns the open person.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StateBlock, cn } from '@intafaced/ui';
import { DEFAULT_CRM_SORT, type CrmSort } from '@/lib/crm-list';
import { signInHref } from '@/lib/crm-return';
import { useFounderOwners } from '../founder-names';
import { BottomTabs, CrmHeader } from './chrome';
import { InboxView } from './inbox';
import { PeopleView, type PeopleFilters } from './people-view';
import { PersonView } from './person-view';
import { DEFAULT_INBOX_TAB, tabRows, entriesOf, type InboxTab, type QueueEntry } from './queue';
import { openEnquiries } from './raise';
import { RaiseView } from './raise-view';
import { failureOf, fetchList, fetchMetrics, fetchWaiting, type Metrics } from './request';
import { ToolPanel } from './tools';
import { UiScope } from './ui-scope';
import { Notice } from './ui';
import { crmUrl, isMainView, isToolView, type CrmUrlState, type CrmViewId } from './url-state';
import { usePerson } from './use-person';
import { useRowInfo } from './use-row-info';

const NO_FILTERS: PeopleFilters = { audience: '', stage: '', owner: '', query: '' };
const MAIN_LABEL = { inbox: 'Inbox', raise: 'Raise', people: 'People' } as const;

export function CrmApp({ csrf, userId, initial }: { csrf: string; userId: string; initial: CrmUrlState }) {
  const owners = useFounderOwners();
  const [view, setView] = useState<CrmViewId>(initial.view);
  const [selectedId, setSelectedId] = useState<string | null>(initial.enquiry);
  const [now, setNow] = useState(() => Date.now());
  const [dataVersion, setDataVersion] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [ownersWaited, setOwnersWaited] = useState(false);
  const [tab, setTab] = useState<InboxTab>(DEFAULT_INBOX_TAB);

  /* ---- the waiting queue ---- */
  const [waiting, setWaiting] = useState<{ entries: QueueEntry[]; truncated: boolean } | null>(null);
  const [waitingError, setWaitingError] = useState('');
  const [waitingLoading, setWaitingLoading] = useState(true);
  const waitingCall = useRef(0);
  const loadWaiting = useCallback(async (silent = false) => {
    const call = ++waitingCall.current;
    if (!silent) setWaitingLoading(true);
    try {
      const result = await fetchWaiting();
      if (call !== waitingCall.current) return;
      setWaiting(result);
      setWaitingError('');
      setUpdatedAt(new Date().toISOString());
    } catch (failure) {
      if (!silent && call === waitingCall.current) setWaitingError(failureOf(failure, 'The waiting list is unavailable.').message);
    } finally {
      if (call === waitingCall.current) setWaitingLoading(false);
    }
  }, []);

  /* ---- totals and the raise ---- */
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsError, setMetricsError] = useState('');
  const metricsCall = useRef(0);
  const loadMetrics = useCallback(async (silent = false) => {
    const call = ++metricsCall.current;
    try {
      const result = await fetchMetrics();
      if (call !== metricsCall.current) return;
      setMetrics(result);
      setMetricsError('');
    } catch (failure) {
      if (!silent && call === metricsCall.current) setMetricsError(failureOf(failure, 'The totals are unavailable.').message);
    }
  }, []);

  /* ---- the investors under the Raise bar ---- */
  const [raiseStage, setRaiseStage] = useState('');
  const [raiseRows, setRaiseRows] = useState<QueueEntry[] | null>(null);
  const [raiseLoading, setRaiseLoading] = useState(false);
  const raiseCall = useRef(0);
  const loadRaiseRows = useCallback(
    async (silent = false) => {
      const call = ++raiseCall.current;
      if (!silent) setRaiseLoading(true);
      try {
        const page = await fetchList({ audience: 'investor', ...(raiseStage ? { stage: raiseStage } : {}), limit: 200 });
        if (call === raiseCall.current) setRaiseRows(entriesOf(page));
      } catch {
        // The bar and the counts still show; the list under them keeps what it had.
      } finally {
        if (call === raiseCall.current) setRaiseLoading(false);
      }
    },
    [raiseStage],
  );

  /* ---- everyone ---- */
  const [filters, setFilters] = useState<PeopleFilters>(NO_FILTERS);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CrmSort>(DEFAULT_CRM_SORT);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [people, setPeople] = useState<{ entries: QueueEntry[]; nextCursor: string | null } | null>(null);
  const [peopleError, setPeopleError] = useState('');
  const [peopleLoading, setPeopleLoading] = useState(false);
  const peopleCall = useRef(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(filters.query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [filters.query]);
  const loadPeople = useCallback(
    async (silent = false) => {
      const call = ++peopleCall.current;
      if (!silent) setPeopleLoading(true);
      try {
        const page = await fetchList({
          ...(filters.audience ? { audience: filters.audience } : {}),
          ...(filters.stage ? { stage: filters.stage } : {}),
          ...(filters.owner ? { ownerUserId: filters.owner } : {}),
          ...(query ? { query } : {}),
          cursor,
        });
        if (call !== peopleCall.current) return;
        setPeople({ entries: entriesOf(page), nextCursor: page.nextCursor });
        setPeopleError('');
      } catch (failure) {
        if (!silent && call === peopleCall.current) setPeopleError(failureOf(failure, 'The people list is unavailable.').message);
      } finally {
        if (call === peopleCall.current) setPeopleLoading(false);
      }
    },
    [filters.audience, filters.stage, filters.owner, query, cursor],
  );

  /* ---- the open person ---- */
  const reloadAll = useCallback(async () => {
    await Promise.all([loadWaiting(true), loadMetrics(true)]);
    setDataVersion((value) => value + 1);
  }, [loadWaiting, loadMetrics]);
  const reloadRef = useRef(reloadAll);
  reloadRef.current = reloadAll;
  const person = usePerson({
    csrf,
    userId,
    owners,
    onWritten: () => reloadRef.current(),
    onSelected: setSelectedId,
    viewIsPerson: isMainView(view),
  });
  const listScroll = useRef(0);

  async function openPerson(id: string) {
    if (selectedId !== id) listScroll.current = window.scrollY;
    const opened = await person.open(id);
    if (opened && window.matchMedia('(max-width: 899px)').matches) window.scrollTo(0, 0);
    return opened;
  }
  async function closePerson() {
    if (!(await person.close())) return;
    requestAnimationFrame(() => {
      window.scrollTo(0, listScroll.current);
      const row = selectedId ? document.querySelector<HTMLElement>(`[data-enquiry-id="${selectedId}"]`) : null;
      row?.focus({ preventScroll: true });
    });
  }
  async function navigate(next: CrmViewId) {
    if (next === view) return;
    if (isToolView(next) && person.detail && !(await person.close('Discard unsaved edits before leaving this CRM view?'))) return;
    setView(next);
  }

  /* ---- loading and refreshing ---- */
  useEffect(() => {
    void loadWaiting();
    void loadMetrics();
  }, [loadWaiting, loadMetrics]);
  useEffect(() => {
    if (view === 'people') void loadPeople();
  }, [view, loadPeople]);
  useEffect(() => {
    if (view === 'raise') void loadRaiseRows();
  }, [view, loadRaiseRows]);
  useEffect(() => {
    if (initial.enquiry) void person.open(initial.enquiry).then((opened) => !opened && setSelectedId(null));
    // Opens once, from the address this page was loaded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshAll(auto = false) {
    const jobs: Array<Promise<unknown>> = [loadWaiting(auto), loadMetrics(auto)];
    if (view === 'people') jobs.push(loadPeople(auto));
    if (view === 'raise') jobs.push(loadRaiseRows(auto));
    jobs.push(person.refresh(auto));
    await Promise.all(jobs);
    setDataVersion((value) => value + 1);
    setNow(Date.now());
  }
  const refreshRef = useRef(refreshAll);
  refreshRef.current = refreshAll;
  useEffect(() => {
    const run = () => void refreshRef.current(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    const timer = window.setInterval(run, 60_000);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(clock);
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setOwnersWaited(true), 5000);
    return () => window.clearTimeout(timer);
  }, []);

  /* ---- the address bar and the skip link ---- */
  useEffect(() => {
    try {
      window.history.replaceState(window.history.state, '', crmUrl({ view, enquiry: selectedId }));
    } catch {
      // The address bar is a convenience only.
    }
  }, [view, selectedId]);
  const personOpen = isMainView(view) && (person.detail !== null || person.loading);
  useEffect(() => {
    document.body.dataset.crmView = isMainView(view) ? 'enquiries' : view;
    if (personOpen && window.matchMedia('(max-width: 899px)').matches) document.body.dataset.crmDetail = 'open';
    else delete document.body.dataset.crmDetail;
    return () => {
      delete document.body.dataset.crmView;
      delete document.body.dataset.crmDetail;
    };
  }, [view, personOpen]);

  /* ---- what each view needs ---- */
  const waitingEntries = waiting?.entries ?? null;
  const inboxRows = useMemo(() => (waitingEntries ? tabRows(tab, waitingEntries, userId) : []), [waitingEntries, tab, userId]);
  const info = useRowInfo(
    inboxRows.map((entry) => ({ id: entry.row.id, revision: entry.row.revision, audience: entry.row.audience })),
    view === 'inbox',
  );
  const open = metrics ? openEnquiries(metrics.byStage) : null;
  const toolView = isToolView(view);
  const sessionLost = person.error?.kind === 'session';

  const list = (
    <div id="crm-enquiries" tabIndex={-1} className={cn('min-w-0 outline-none', personOpen && 'max-[899px]:hidden')}>
      {view === 'inbox' ? (
        <InboxView
          entries={waitingEntries}
          loading={waitingLoading}
          error={waitingError}
          truncated={waiting?.truncated ?? false}
          tab={tab}
          onTab={setTab}
          userId={userId}
          owners={owners}
          selectedId={selectedId}
          busy={person.busy}
          onOpen={(id) => void openPerson(id)}
          onRetry={() => void loadWaiting()}
          info={info}
          openEnquiries={open}
          now={now}
        />
      ) : null}
      {view === 'raise' ? (
        <RaiseView
          metrics={metrics}
          metricsError={metricsError}
          onRetry={() => void loadMetrics()}
          stage={raiseStage}
          onStage={setRaiseStage}
          entries={raiseRows}
          entriesLoading={raiseLoading}
          owners={owners}
          selectedId={selectedId}
          busy={person.busy}
          onOpen={(id) => void openPerson(id)}
        />
      ) : null}
      {view === 'people' ? (
        <PeopleView
          entries={people?.entries ?? null}
          loading={peopleLoading}
          error={peopleError}
          filters={filters}
          onFilters={(next) => {
            setFilters((current) => ({ ...current, ...next }));
            setCursor(null);
            setHistory([]);
          }}
          sort={sort}
          onSort={setSort}
          owners={owners}
          selectedId={selectedId}
          busy={person.busy}
          onOpen={(id) => void openPerson(id)}
          onRetry={() => void loadPeople()}
          hasNext={Boolean(people?.nextCursor)}
          hasPrevious={history.length > 0}
          onNext={() => {
            setHistory((values) => [...values, cursor]);
            setCursor(people?.nextCursor ?? null);
          }}
          onPrevious={() => {
            setCursor(history.at(-1) ?? null);
            setHistory((values) => values.slice(0, -1));
          }}
          now={now}
        />
      ) : null}
    </div>
  );

  return (
    <UiScope className="w-full">
      <div className={cn('mx-auto flex w-full max-w-[1600px] flex-col gap-4', !personOpen && 'max-[899px]:pb-20')}>
        <div className={cn(personOpen && 'max-[899px]:hidden')}>
          <CrmHeader
            view={view}
            waiting={waitingEntries ? waitingEntries.length : null}
            updatedAt={updatedAt}
            loading={waitingLoading}
            onNavigate={(next) => void navigate(next)}
            onRefresh={() => void refreshAll()}
          />
        </div>
        {ownersWaited && owners.length === 0 ? (
          <p className="text-sm text-fg-2" role="status">
            Founder names did not load, so owners cannot be shown or changed. Reload the page to try again.
          </p>
        ) : null}
        {!person.detail && person.error ? (
          <Notice
            tone="danger"
            role="alert"
            actions={
              sessionLost ? (
                <a
                  className="inline-flex min-h-8 items-center text-sm font-medium text-fg underline underline-offset-4"
                  href={signInHref(selectedId)}
                >
                  Sign in
                </a>
              ) : undefined
            }
          >
            {person.error.message}
          </Notice>
        ) : null}
        {toolView ? (
          <ToolPanel
            tool={view}
            csrf={csrf}
            owners={owners}
            version={dataVersion}
            onOpenEnquiry={(id) => {
              setView('people');
              void openPerson(id);
            }}
            onChanged={async () => {
              await reloadAll();
            }}
          />
        ) : (
          <div className={cn('grid gap-6', personOpen && 'min-[900px]:grid-cols-[minmax(0,1fr)_minmax(440px,540px)]')}>
            {list}
            {personOpen ? (
              <aside aria-label="Enquiry details" className="min-w-0 min-[900px]:border-l min-[900px]:border-line min-[900px]:pl-6">
                {person.detail ? (
                  <PersonView
                    person={person}
                    csrf={csrf}
                    userId={userId}
                    owners={owners}
                    origin={MAIN_LABEL[view as keyof typeof MAIN_LABEL]}
                    now={now}
                    onBack={() => void closePerson()}
                    onExport={() => void navigate('exports')}
                    onWritten={reloadAll}
                  />
                ) : (
                  <StateBlock kind="loading" rows={5} rowHeight={40} label="Opening the enquiry" />
                )}
              </aside>
            ) : null}
          </div>
        )}
      </div>
      {isMainView(view) && !personOpen ? (
        <BottomTabs view={view} waiting={waitingEntries ? waitingEntries.length : null} onNavigate={(next) => void navigate(next)} />
      ) : null}
    </UiScope>
  );
}
