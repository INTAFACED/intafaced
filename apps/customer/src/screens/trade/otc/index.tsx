import { useState } from 'react';
import type { ScreenProps } from '../../../app/screen-types';
import { useRoomApi, useNow, asOfOf } from '../rooms/read';
import { RoomFrame } from '../rooms/RoomFrame';
import { Freshness, Refusal, WriteNotice } from '../rooms/RoomNotices';
import { useRoomWriter } from '../rooms/write';
import { EmptyState, Skeleton, Tabs, TabsList, TabsPanel, TabsTab, useSession } from '../rooms/ui';
import { otcCopy } from './copy';
import { useDeskStatus, usePairs, useQuoteBook } from './data';
import { DeskStatusStrip } from './DeskStatusStrip';
import { AllocationTab, ExportTab, RulesTab } from './InfoTabs';
import { lifecycleOf, operationOf, verdictOf } from './model';
import { QuoteCard } from './QuoteCard';
import { QuotesTable } from './QuotesTable';
import { RequestForm } from './RequestForm';

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
    <RoomFrame
      mode="Quote desk"
      title={t('Quote desk')}
      description={t('Quote desk description')}
      meta={<Freshness asOf={asOfOf(desk)} refused={desk.status === 'refused'} now={now} />}
    >
      <div className="flex flex-col gap-4">
        <DeskStatusStrip desk={desk} />
        <WriteNotice writer={writer} onCheck={(id) => void check(id)} />
        {checkNote ? (
          <p role="status" className="m-0 text-sm text-fg">
            {checkNote}
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <RequestForm
            api={api}
            writer={writer}
            desk={desk}
            pairs={pairs}
            onQuote={(quote) => {
              setKept(book.adopt(quote));
              setSelected(quote.quoteId);
              setTab('quotes');
            }}
          />
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList divider className="overflow-x-auto">
              <TabsTab value="quotes">{t('Tab quotes')}</TabsTab>
              <TabsTab value="export">{t('Tab export')}</TabsTab>
              <TabsTab value="allocation">{t('Tab allocation')}</TabsTab>
              <TabsTab value="rules">{t('Tab rules')}</TabsTab>
            </TabsList>
            <TabsPanel value="quotes" className="flex flex-col gap-4 pt-3">
              {kept ? null : (
                <p role="alert" className="m-0 text-sm text-warn">
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
              {entry?.status === 'loading' ? <Skeleton className="h-48 w-full" /> : null}
              {entry?.status === 'refused' ? <Refusal words={entry.words} /> : null}
              {entry?.status === 'error' ? (
                <EmptyState
                  variant="unavailable"
                  size="panel"
                  title={t('Quote unreadable title')}
                  reason={t('Quote unreadable reason')}
                  action={selected ? { label: t('Try again'), onClick: () => void book.load(selected), variant: 'secondary' } : undefined}
                />
              ) : null}
              {entry?.status === 'ready' ? (
                <QuoteCard
                  api={api}
                  writer={writer}
                  quote={entry.quote}
                  readAt={entry.readAt}
                  now={now}
                  onCheck={check}
                  onQuote={(quote, options) => {
                    const kept = book.adopt(quote);
                    if (options?.select) {
                      setKept(kept);
                      setSelected(quote.quoteId);
                    }
                  }}
                />
              ) : null}
            </TabsPanel>
            <TabsPanel value="export" className="pt-3">
              <ExportTab read={book.read} now={now} />
            </TabsPanel>
            <TabsPanel value="allocation" className="pt-3">
              <AllocationTab />
            </TabsPanel>
            <TabsPanel value="rules" className="pt-3">
              <RulesTab routed={routed} />
            </TabsPanel>
          </Tabs>
        </div>
      </div>
    </RoomFrame>
  );
}

export default function Screen(props: ScreenProps) {
  const { t } = otcCopy.useCopy();
  const { userId } = useSession();
  if (!userId)
    return (
      <RoomFrame mode="Quote desk" title={t('Quote desk')} description={t('Quote desk description')}>
        <EmptyState
          variant="refused"
          size="panel"
          title={t('Sign in title')}
          reason={t('Sign in reason')}
          action={{ label: t('Log in'), href: `/login?redirect=${encodeURIComponent(`${props.path}${props.search}`)}` }}
        />
      </RoomFrame>
    );
  return <Room linkedId={linkedQuoteId(props)} />;
}
