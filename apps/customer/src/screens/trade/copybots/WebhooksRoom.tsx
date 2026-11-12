import { useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Page,
  PageHeader,
  PageSection,
  Table,
  type TableColumn,
} from '@intafaced/ui';
import { useApi, useSession } from '../../../features/session/session';
import { venueApi } from '../../../features/trade/venue-api';
import { createVenueWalletApi } from '../../../features/protocol/venue-wallet/venue-wallet-api';
import { createRoomApi, type SignalWebhook } from './api';
import { roomCopy } from './copy';
import { useLive } from './live';
import { Freshness, InfoNote, RefusalNote } from './parts';
import { roomRefusal } from './refusals';

/**
 * Chart alert webhooks (CB-bots-api-signal-01, J-copy-bots-otc-20): a webhook per venue market and venue account that
 * turns a chart alert into an order prepared on the venue, for the person's own wallet to sign and send (svc-trade's
 * user-venue door; INTAFACED holds no key that can sign). The token is shown once, when the webhook is made; afterwards
 * only its first six characters. The account is prefilled with the person's live connected wallet, when there is one.
 *
 * Each order webhook can be paused, resumed and ended (CB-bots-api-signal-02); after the platform's count of failed
 * alerts in a row it ends by itself, and says so. A notification URL (CB-bots-api-signal-03) has its own token and turns
 * each alert into one notice, never an order.
 */
/** The address a chart alert posts to: this site's origin and the webhook's path. Data, not words. */
const webhookAddress = (origin: string, path: string) => origin + path;
/** The first characters of a token, shown so a person can tell their webhooks apart. Data, not words. */
const tokenShown = (prefix: string) => prefix + '…';

export function WebhooksRoom() {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const session = useSession();
  const api = createRoomApi(transport);
  const venue = venueApi(transport);
  const wallets = createVenueWalletApi(transport);
  const hooks = useLive((signal) => api.webhooks(signal), `signal-webhooks:${session ? 'in' : 'out'}`, 30_000);
  const markets = useLive((signal) => venue.markets(signal), 'signal-venue-markets', 300_000);
  const connected = useLive((signal) => wallets.status(signal), `signal-venue-wallets:${session ? 'in' : 'out'}`, 300_000);
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [owner, setOwner] = useState('');
  // One request key per opened form: a retried Create after a lost answer names the same webhook, never a second.
  const [requestKey, setRequestKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<SignalWebhook | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [rowRefused, setRowRefused] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [note, setNote] = useState<SignalWebhook | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteRefused, setNoteRefused] = useState<string | null>(null);
  const orderHooks = (hooks.data ?? []).filter((w) => w.kind === 'order');
  const noteHooks = (hooks.data ?? []).filter((w) => w.kind === 'notify');
  const spot = (markets.data?.value ?? []).filter((m) => m.kind === 'spot');
  const liveWallet = (connected.data?.connections ?? []).find((c) => c.status === 'live')?.address ?? '';
  const account = owner || liveWallet;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  async function create() {
    setBusy(true);
    setRefused(null);
    const out = await api.createWebhook({ symbol, venueOwner: account, clientRequestId: requestKey });
    setBusy(false);
    if (!out.ok) {
      setRefused(roomRefusal(out).title);
      return;
    }
    setMade(out.data);
    setOpen(false);
    hooks.reload();
  }

  async function change(w: SignalWebhook, to: 'pause' | 'resume' | 'end') {
    setRowBusy(w.webhookId);
    setRowRefused(null);
    const out = await api.setWebhookState(w.webhookId, to);
    setRowBusy(null);
    if (!out.ok) setRowRefused(roomRefusal(out).title);
    hooks.reload();
  }

  async function createNote() {
    setNoteBusy(true);
    setNoteRefused(null);
    // One key per click: the URL is made once however often a lost answer is retried within this click.
    const out = await api.createNotifyUrl({ clientRequestId: `nu-${crypto.randomUUID()}` });
    setNoteBusy(false);
    if (!out.ok) {
      setNoteRefused(roomRefusal(out).title);
      return;
    }
    setNote(out.data);
    hooks.reload();
  }

  const stateCell = (w: SignalWebhook) => (
    <span className="cb-wrap">
      <Badge tone={w.state === 'active' ? 'lime' : 'warn'}>
        {w.state === 'active' ? t('Active') : w.state === 'paused' ? t('Paused') : t('Ended')}
      </Badge>{' '}
      {w.state === 'ended' ? (w.endedReason === 'failures' ? t('After failed alerts in a row') : t('By you')) : null}
    </span>
  );

  const columns: TableColumn<SignalWebhook>[] = [
    { id: 'market', header: t('Market'), value: (w) => w.symbol ?? '', width: 140 },
    { id: 'account', header: t('Venue account'), cell: (w) => <code className="cb-wrap">{w.venueOwner}</code>, width: 200 },
    { id: 'url', header: t('Address'), cell: (w) => <code className="cb-wrap">{webhookAddress(origin, w.path)}</code>, width: 420 },
    { id: 'token', header: t('Token'), cell: (w) => <code>{tokenShown(w.tokenPrefix)}</code>, width: 120 },
    { id: 'state', header: t('State'), cell: stateCell, width: 200 },
    { id: 'failures', header: t('Failed in a row'), value: (w) => String(w.consecutiveFailures), width: 120 },
    {
      id: 'actions',
      header: t('Actions'),
      cell: (w) =>
        w.state === 'ended' ? null : (
          <div className="cb-action-row">
            {w.state === 'active' ? (
              <Button variant="secondary" disabled={rowBusy === w.webhookId} onClick={() => void change(w, 'pause')}>
                {t('Pause')}
              </Button>
            ) : (
              <Button variant="secondary" disabled={rowBusy === w.webhookId} onClick={() => void change(w, 'resume')}>
                {t('Resume')}
              </Button>
            )}
            <Button variant="secondary" disabled={rowBusy === w.webhookId} onClick={() => void change(w, 'end')}>
              {t('End')}
            </Button>
          </div>
        ),
      width: 200,
    },
  ];

  const noteColumns: TableColumn<SignalWebhook>[] = [
    { id: 'url', header: t('Address'), cell: (w) => <code className="cb-wrap">{webhookAddress(origin, w.path)}</code>, width: 420 },
    { id: 'token', header: t('Token'), cell: (w) => <code>{tokenShown(w.tokenPrefix)}</code>, width: 120 },
    { id: 'state', header: t('State'), cell: stateCell, width: 200 },
  ];

  return (
    <Page>
      <PageHeader
        title={t('Chart alert webhooks')}
        description={t('Turn a chart alert into an order on one venue market, ready for your wallet to sign.')}
      />
      <PageSection title={t('Your webhooks')} headingLevel={2} actions={<Freshness live={hooks} staleAfterMs={90_000} />}>
        {!session ? (
          <EmptyState variant="refused" title={t('You are signed out')} reason={t('Sign in to make a webhook.')} />
        ) : (
          <>
            <div className="cb-action-row">
              <Button
                onClick={() => {
                  setRequestKey(`wh-${crypto.randomUUID()}`);
                  setOpen(true);
                }}
              >
                {t('New webhook')}
              </Button>
            </div>
            {made?.token ? (
              <InfoNote>
                <span style={{ display: 'block' }}>{t('Copy these now. The token is shown only this once.')}</span>
                <span style={{ display: 'block' }}>
                  {t('Address')}: <code data-testid="webhook-url">{webhookAddress(origin, made.path)}</code>
                </span>
                <span style={{ display: 'block' }}>
                  {t('Token')}: <code data-testid="webhook-token">{made.token}</code>
                </span>
              </InfoNote>
            ) : null}
            <Table
              label={t('Webhooks')}
              columns={columns}
              rows={orderHooks}
              getRowId={(w) => w.webhookId}
              status={hooks.status === 'loading' ? 'loading' : hooks.status === 'error' ? 'error' : 'ready'}
              onRetry={hooks.reload}
              errorState={hooks.failure ? <RefusalNote failure={hooks.failure} retry={hooks.reload} /> : undefined}
              emptyState={
                <EmptyState size="inline" title={t('You have no webhooks')} reason={t('Make one for the market your alert watches.')} />
              }
              minWidth={1100}
            />
            {rowRefused ? <p role="alert">{rowRefused}</p> : null}
            <InfoNote>
              {t(
                'An alert sends JSON with your token, an alert id, the time it fired, a side (buy, sell or reverse), an amount and the worst price you accept.',
              )}
            </InfoNote>
            <InfoNote>
              {t(
                'The amount is a quantity, or a percent of what you hold on the market, such as 50%. A reverse closes what you hold and opens the other way; a spot market holds no short, so there it only closes.',
              )}
            </InfoNote>
            <InfoNote>
              {t('After the platform’s count of failed alerts in a row, a webhook ends by itself. You can pause, resume or end it here.')}
            </InfoNote>
            <InfoNote>
              {t(
                'Each alert prepares one order on the venue. Nothing is sent until your wallet signs it: INTAFACED holds no key that can sign for you.',
              )}
            </InfoNote>
          </>
        )}
      </PageSection>
      {session ? (
        <PageSection title={t('Notification URL')} headingLevel={2}>
          <div className="cb-action-row">
            <Button disabled={noteBusy} onClick={() => void createNote()}>
              {t('New notification URL')}
            </Button>
          </div>
          {noteRefused ? <p role="alert">{noteRefused}</p> : null}
          {note?.token ? (
            <InfoNote>
              <span style={{ display: 'block' }}>{t('Copy these now. The token is shown only this once.')}</span>
              <span style={{ display: 'block' }}>
                {t('Address')}: <code data-testid="notify-url">{webhookAddress(origin, note.path)}</code>
              </span>
              <span style={{ display: 'block' }}>
                {t('Token')}: <code data-testid="notify-token">{note.token}</code>
              </span>
            </InfoNote>
          ) : null}
          <Table
            label={t('Notification URLs')}
            columns={noteColumns}
            rows={noteHooks}
            getRowId={(w) => w.webhookId}
            status={hooks.status === 'loading' ? 'loading' : hooks.status === 'error' ? 'error' : 'ready'}
            onRetry={hooks.reload}
            emptyState={
              <EmptyState size="inline" title={t('You have no notification URL')} reason={t('Make one to get alerts as notices.')} />
            }
            minWidth={700}
          />
          <InfoNote>
            {t(
              'An alert to this address sends JSON with its token, an alert id, the time it fired and a message. It shows as one notice and never places an order.',
            )}
          </InfoNote>
        </PageSection>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="cb-dialog">
          <DialogHeader>
            <DialogTitle>{t('New webhook')}</DialogTitle>
            <DialogDescription>{t('Each webhook prepares orders on one venue market, for your venue account.')}</DialogDescription>
          </DialogHeader>
          <label className="cb-selectfield">
            <span className="cb-label">{t('Market')}</span>
            <select aria-label={t('Market')} value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              <option value="">{t('Choose a market')}</option>
              {spot.map((m) => (
                <option key={m.symbol} value={m.symbol}>
                  {m.symbol}
                </option>
              ))}
            </select>
          </label>
          <Field label={t('Venue account')} hint={t('The wallet address that signs your venue orders.')} required>
            <Input kind="text" value={account} onValueChange={setOwner} maxLength={64} autoComplete="off" />
          </Field>
          {refused ? <p role="alert">{refused}</p> : null}
          <div className="cb-action-row">
            <Button disabled={!symbol || !account || busy} onClick={() => void create()}>
              {t('Create webhook')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
