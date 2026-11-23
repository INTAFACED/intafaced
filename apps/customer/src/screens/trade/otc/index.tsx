// volt-room: /otc
// volt-room: /otc/:quoteId
// volt-room: /otc/tradeInfo
import { useEffect, useState } from 'react';
import type { ScreenProps } from '../../../app/screen-types';
import { useRoomApi, useNow, asOfOf } from '../rooms/read';
import { useRoomWriter } from '../rooms/write';
import { useSession } from '../rooms/ui';
import { Button } from '@intafaced/ui/lit';
import { DeskTemplate, RefusalBox, Skeleton, TabPanel, Tabs } from '@intafaced/ui/lit/templates';
import { Freshness, Refusal, WriteNotice } from '../options/notices';
import { TradeSubNav } from '../TradeSubNav';
import { otcCopy } from './copy';
import { useDeskStatus, useOtcMakers, usePairs, useQuoteBook, useRfqBoard } from './data';
import { DeskStatusStrip } from './DeskStatusStrip';
import { AllocationTab, ExportTab, RulesTab } from './InfoTabs';
import { lifecycleOf, operationOf, verdictOf } from './model';
import { QuoteCard } from './QuoteCard';
import { QuotesTable } from './QuotesTable';
import { RequestForm } from './RequestForm';
import { RfqBoard } from './RfqBoard';

type Tab = 'quotes' | 'export' | 'allocation' | 'rules';

/** `/otc/:quoteId` or `?quoteId=` opens that quote; either way it is re-read before anything is shown. */
function linkedQuoteId({ params, search }: ScreenProps): string | null {
  const id = params.quoteId ?? new URLSearchParams(search).get('quoteId');
  return id?.trim() ? id.trim() : null;
}

function Room({ linkedId }: { linkedId: string | null }) {
  const { t } = otcCopy.useCopy();
  const { userId } = useSession();
  const api = useRoomApi();
  const writer = useRoomWriter();
  const now = useNow(1000);
  const desk = useDeskStatus(api);
  const pairs = usePairs(api);
  const makers = useOtcMakers(api);
  const board = useRfqBoard(api);
  const [providers, setProviders] = useState<string[]>([]);
  // The providers each quote asked, so a re-price asks the same ones whatever the form shows now.
  const [askedBy, setAskedBy] = useState<Readonly<Record<string, string[]>>>({});
  const listed = makers.status === 'ready' ? makers.data.makers.map((m) => m.id).join('\n') : null;
  // A provider the owner took off the list leaves the pick: it has no box left to untick.
  useEffect(() => {
    if (listed === null) return;
    const ids = listed.split('\n');
    setProviders((pick) => (pick.every((id) => ids.includes(id)) ? pick : pick.filter((id) => ids.includes(id))));
  }, [listed]);
  const [selected, setSelected] = useState<string | null>(linkedId);
  const [tab, setTab] = useState<Tab>('quotes');
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [kept, setKept] = useState(true);
  const book = useQuoteBook(api, userId, linkedId, selected);

  /**
   * Re-read one quote from the service. If a device note names this quote, the note is released only when the
   * reading proves what happened to the original request; otherwise the request stays locked.
   */
  async function check(id: string) {
    setCheckNote(null);
    const note = writer.note.state === 'pending' ? writer.note.pending : null;
    const mine = note?.id === id ? note : null;
    // A price request has no quote id until the desk answers, so it cannot be looked up. It holds nothing.
    if (mine && operationOf(mine.symbol) === 'request') {
      writer.resolve(id);
      setCheckNote(t('Check request released'));
      return;
    }
    const result = await book.load(id);
    if (!mine) return;
    if (!result.ok) {
      setCheckNote(t('Check could not read', { id }));
      return;
    }
    const operation = operationOf(mine.symbol);
    const verdict = operation ? verdictOf(operation, lifecycleOf(result.data)) : 'unresolved';
    if (verdict === 'unresolved') {
      setCheckNote(t('Check unresolved', { id }));
      return;
    }
    writer.resolve(id);
    setCheckNote(verdict === 'done' ? t('Check done', { id }) : t('Check not done', { id }));
  }

  const entry = selected ? book.entries[selected] : undefined;
  const routed = desk.status === 'ready' && desk.data.makerRouting?.published === true;

  return (
    <DeskTemplate
      title={t('Quote desk')}
      description={t('Quote desk description')}
      mode="pro"
      section={<TradeSubNav />}
      state={{ kind: 'ready' }}
      instrument={
        <div className="lt-stack">
          <div className="lt-toolbar">
            <Freshness asOf={asOfOf(desk)} refused={desk.status === 'refused'} now={now} />
          </div>
          <DeskStatusStrip desk={desk} />
          <WriteNotice writer={writer} onCheck={(id) => void check(id)} />
          {checkNote ? (
            <p role="status" className="lt-text">
              {checkNote}
            </p>
          ) : null}
        </div>
      }
      ticket={
        <RequestForm
          api={api}
          writer={writer}
          desk={desk}
          pairs={pairs}
          makers={makers}
          picked={providers}
          onPick={setProviders}
          onQuote={(quote, asked) => {
            setAskedBy((all) => ({ ...all, [quote.quoteId]: asked }));
            setKept(book.adopt(quote));
            setSelected(quote.quoteId);
            setTab('quotes');
          }}
        />
      }
      chart={
        <div className="lt-stack">
          <Tabs
            id="otc"
            label={t('Quote desk')}
            value={tab}
            onChange={(next) => setTab(next as Tab)}
            items={[
              { value: 'quotes', label: t('Tab quotes') },
              { value: 'export', label: t('Tab export') },
              { value: 'allocation', label: t('Tab allocation') },
              { value: 'rules', label: t('Tab rules') },
            ]}
          />
          <TabPanel id="otc" value="quotes" current={tab}>
            <div className="lt-stack">
              {kept ? null : (
                <p role="alert" className="lt-alert">
                  {t('Not remembered')}
                </p>
              )}
              <QuotesTable
                ids={book.ids}
                entries={book.entries}
                selected={selected}
                now={now}
                pendingId={writer.note.state === 'pending' ? writer.note.pending.id : null}
                onSelect={setSelected}
                onOpenById={book.open}
                onForget={(id) => {
                  book.forget(id);
                  if (selected === id) setSelected(null);
                }}
                onRetry={(id) => void book.load(id)}
              />
              {entry?.status === 'loading' ? <Skeleton shape="form" /> : null}
              {entry?.status === 'refused' ? <Refusal words={entry.words} /> : null}
              {entry?.status === 'error' ? (
                <div className="lt-stack">
                  <RefusalBox
                    refusal={{ variant: 'unreachable', title: t('Quote unreadable title'), body: t('Quote unreadable reason') }}
                  />
                  {selected ? (
                    <div className="lt-actions">
                      <Button onClick={() => void book.load(selected)}>{t('Try again')}</Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {entry?.status === 'ready' ? (
                <QuoteCard
                  api={api}
                  writer={writer}
                  quote={entry.quote}
                  readAt={entry.readAt}
                  now={now}
                  providers={askedBy[entry.quote.quoteId] ?? providers}
                  onCheck={check}
                  onQuote={(quote, options) => {
                    const asked = options?.asked;
                    if (asked) setAskedBy((all) => ({ ...all, [quote.quoteId]: asked }));
                    const kept = book.adopt(quote);
                    if (options?.select) {
                      setKept(kept);
                      setSelected(quote.quoteId);
                    }
                  }}
                />
              ) : null}
            </div>
          </TabPanel>
          <TabPanel id="otc" value="export" current={tab}>
            <ExportTab read={book.read} now={now} />
          </TabPanel>
          <TabPanel id="otc" value="allocation" current={tab}>
            <AllocationTab />
          </TabPanel>
          <TabPanel id="otc" value="rules" current={tab}>
            <RulesTab routed={routed} />
          </TabPanel>
        </div>
      }
      orders={<RfqBoard board={board} makers={makers} />}
    />
  );
}

export default function Screen(props: ScreenProps) {
  const { t } = otcCopy.useCopy();
  const { userId } = useSession();
  if (!userId)
    return (
      <DeskTemplate
        title={t('Quote desk')}
        description={t('Quote desk description')}
        mode="pro"
        section={<TradeSubNav />}
        state={{
          kind: 'gated',
          gate: 'signed-out',
          refusal: {
            variant: 'refused',
            title: t('Sign in title'),
            body: t('Sign in reason'),
            action: { label: t('Log in'), href: `/login?redirect=${encodeURIComponent(`${props.path}${props.search}`)}` },
          },
        }}
        instrument={null}
        chart={null}
        ticket={null}
        orders={null}
      />
    );
  return <Room linkedId={linkedQuoteId(props)} />;
}
