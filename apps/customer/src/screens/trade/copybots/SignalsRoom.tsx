import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Page,
  PageHeader,
  PageSection,
  Table,
  type TableColumn,
} from '@intafaced/ui';
import { useApi, useSession } from '../../../features/session/session';
import { createRoomApi, type SignalBot, type SignalListing } from './api';
import { roomCopy } from './copy';
import { useLive, type Live } from './live';
import { Freshness, InfoNote, RefusalNote } from './parts';
import { roomRefusal } from './refusals';

/**
 * Signals (CB-bots-api-signal-04, J-copy-bots-otc-21): the signal listings providers publish. A person buys access to
 * a listing once, by card through the card partner (svc-market; INTAFACED keeps no balance for them and our ledger
 * records only our revenue), and runs a signal bot from a listing they bought (svc-trade). A bot made without access
 * is refused by the service, by its own code. One bot key per listing per visit: a second press of Create a bot, or
 * a retry after a lost answer, names the same bot.
 */
/** A price as the listing gives it, with its asset. Data, not words. */
const priced = (amount: string, asset: string) => `${amount} ${asset}`;

export function SignalsRoom() {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const session = useSession();
  const api = createRoomApi(transport);
  const listings = useLive((signal) => api.signalListings(signal), `signal-listings:${session ? 'in' : 'out'}`, 30_000);
  const bots = useLive((signal) => api.signalBots(signal), `signal-bots:${session ? 'in' : 'out'}`, 30_000);
  const [buying, setBuying] = useState<SignalListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [buyRefused, setBuyRefused] = useState<string | null>(null);
  // Per listing: what the last Create a bot answered, shown on that listing.
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});
  // One bot key per listing for this visit, so a double press or a retry makes one bot.
  const botKeys = useRef<Record<string, string>>({});

  async function buy() {
    if (!buying) return;
    setBusy(true);
    setBuyRefused(null);
    const out = await api.buySignal(buying.id);
    setBusy(false);
    if (!out.ok || out.data.status !== 'paid') {
      setBuyRefused(out.ok ? t('The card partner did not take the payment. Nothing was charged.') : roomRefusal(out).title);
      listings.reload();
      return;
    }
    setBuying(null);
    listings.reload();
  }

  async function createBot(listing: SignalListing) {
    const clientBotId = (botKeys.current[listing.id] ??= `sb-${crypto.randomUUID()}`);
    const out = await api.createSignalBot({ listingId: listing.id, clientBotId });
    setNotes((n) => ({
      ...n,
      [listing.id]: out.ok ? { ok: true, text: t('The bot was created. It is in My bots.') } : { ok: false, text: roomRefusal(out).title },
    }));
    if (out.ok) bots.reload();
  }

  return (
    <Page>
      <PageHeader title={t('Signals')} description={t('Buy access to a provider’s signal, then run a signal bot from it.')} />
      <PageSection title={t('Signal listings')} headingLevel={2} actions={<Freshness live={listings} staleAfterMs={90_000} />}>
        {!session ? (
          <EmptyState variant="refused" title={t('You are signed out')} reason={t('Sign in to see signals.')} />
        ) : listings.status === 'loading' ? (
          <p role="status">{t('Loading signals')}</p>
        ) : listings.status === 'error' && listings.failure ? (
          <RefusalNote failure={listings.failure} retry={listings.reload} />
        ) : (listings.data ?? []).length === 0 ? (
          <EmptyState size="inline" title={t('No signals are listed yet')} reason={t('A signal appears here when a provider lists one.')} />
        ) : (
          <div className="cb-stack">
            {(listings.data ?? []).map((listing) => (
              <article key={listing.id} className="cb-card" aria-label={listing.title}>
                <h3>{listing.title}</h3>
                <p>{listing.description}</p>
                <p>
                  {t('Price')}: {listing.price === null ? t('Not set by the provider') : priced(listing.price, listing.assetId)}
                </p>
                {listing.access ? (
                  <p>
                    <Badge tone="lime">{t('Access bought')}</Badge>{' '}
                    {listing.payment?.test ? <Badge tone="warn">{t('TEST partner card')}</Badge> : null}
                  </p>
                ) : listing.payment?.status === 'declined' ? (
                  <p>{t('The card partner did not take the payment. Nothing was charged.')}</p>
                ) : listing.payment ? (
                  <p>{t('Payment not finished yet. Buy access again to finish it; you are never charged twice.')}</p>
                ) : null}
                <div className="cb-action-row">
                  {!listing.access ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setBuyRefused(null);
                        setBuying(listing);
                      }}
                    >
                      {t('Buy access')}
                    </Button>
                  ) : null}
                  <Button onClick={() => void createBot(listing)}>{t('Create a bot')}</Button>
                </div>
                {notes[listing.id] ? (
                  <p role={notes[listing.id]!.ok ? 'status' : 'alert'}>
                    {notes[listing.id]!.text}
                    {notes[listing.id]!.ok ? (
                      <>
                        {' '}
                        <a href="/trade/bots?tab=mine">{t('Open My bots')}</a>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
        <InfoNote>
          {t('You pay by card through the card partner. INTAFACED keeps no balance for you and holds none of your money.')}
        </InfoNote>
      </PageSection>
      {session ? (
        <PageSection title={t('Your signal bots')} headingLevel={2} actions={<Freshness live={bots} staleAfterMs={90_000} />}>
          <SignalBotsTable bots={bots} />
        </PageSection>
      ) : null}
      <Dialog open={buying !== null} onOpenChange={(open) => (open ? undefined : setBuying(null))}>
        <DialogContent className="cb-dialog">
          <DialogHeader>
            <DialogTitle>{t('Buy access')}</DialogTitle>
            <DialogDescription>
              {t('Pay once by card. The card partner takes the payment; you are charged once, however often you press Buy.')}
            </DialogDescription>
          </DialogHeader>
          {buying ? (
            <p>
              {buying.title}: {buying.price === null ? t('Not set by the provider') : priced(buying.price, buying.assetId)}
            </p>
          ) : null}
          {buyRefused ? <p role="alert">{buyRefused}</p> : null}
          <div className="cb-action-row">
            <Button disabled={busy} onClick={() => void buy()}>
              {t('Buy')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/** A signal bot's state, in words. */
function useStateWord() {
  const { t } = roomCopy.useCopy();
  return (state: SignalBot['state']) =>
    state === 'awaiting_signal' ? t('Awaiting signal') : state === 'active' ? t('Active') : t('Stopped');
}

/** The person's signal bots, as svc-trade lists them. Shown in this room and in My bots. */
export function SignalBotsTable({ bots }: { bots: Live<SignalBot[]> }) {
  const { t } = roomCopy.useCopy();
  const word = useStateWord();
  const columns: TableColumn<SignalBot>[] = [
    { id: 'name', header: t('Name'), value: (b) => b.title, width: 260 },
    {
      id: 'state',
      header: t('State'),
      cell: (b) => <Badge tone={b.state === 'awaiting_signal' ? 'warn' : b.state === 'active' ? 'lime' : 'neutral'}>{word(b.state)}</Badge>,
      width: 160,
    },
    { id: 'cap', header: t('Limit'), value: (b) => priced(b.cap.amount, b.cap.asset), width: 140 },
  ];
  return (
    <Table
      label={t('Signal bots')}
      columns={columns}
      rows={bots.data ?? []}
      getRowId={(b) => b.botId}
      status={bots.status === 'loading' ? 'loading' : bots.status === 'error' ? 'error' : 'ready'}
      onRetry={bots.reload}
      errorState={bots.failure ? <RefusalNote failure={bots.failure} retry={bots.reload} /> : undefined}
      emptyState={
        <EmptyState size="inline" title={t('You have no signal bots')} reason={t('Buy access to a signal, then create a bot from it.')} />
      }
      minWidth={560}
    />
  );
}
