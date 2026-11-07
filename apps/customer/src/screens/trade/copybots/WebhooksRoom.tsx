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
  Page,
  PageHeader,
  PageSection,
  Table,
  type TableColumn,
} from '@intafaced/ui';
import { useApi, useSession } from '../../../features/session/session';
import { createTradeApi } from '../../../features/trade/trade-api';
import { createRoomApi, type SignalWebhook } from './api';
import { roomCopy } from './copy';
import { useLive } from './live';
import { Freshness, InfoNote, RefusalNote } from './parts';
import { roomRefusal } from './refusals';

/**
 * Chart alert webhooks (CB-bots-api-signal-01, J-copy-bots-otc-20): a webhook per market that turns a chart alert into
 * an order. The token is shown once, when the webhook is made; afterwards only its first six characters.
 */
export function WebhooksRoom() {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const session = useSession();
  const api = createRoomApi(transport);
  const tradeApi = createTradeApi(transport);
  const hooks = useLive((signal) => api.webhooks(signal), `signal-webhooks:${session ? 'in' : 'out'}`, 30_000);
  const markets = useLive((signal) => tradeApi.markets(signal), 'signal-markets', 300_000);
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<SignalWebhook | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const spot = (markets.data ?? []).filter((m) => m.spot && m.active && !m.paper && m.orderable);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  async function create() {
    setBusy(true);
    setRefused(null);
    const out = await api.createWebhook({ symbol, clientRequestId: `wh-${symbol.replace('/', '')}-${crypto.randomUUID()}` });
    setBusy(false);
    if (!out.ok) {
      setRefused(roomRefusal(out).title);
      return;
    }
    setMade(out.data);
    setOpen(false);
    hooks.reload();
  }

  const columns: TableColumn<SignalWebhook>[] = [
    { id: 'market', header: t('Market'), value: (w) => w.symbol, width: 140 },
    { id: 'url', header: t('Address'), cell: (w) => <code className="cb-wrap">{`${origin}${w.path}`}</code>, width: 420 },
    { id: 'token', header: t('Token'), cell: (w) => <code>{`${w.tokenPrefix}…`}</code>, width: 120 },
    {
      id: 'state',
      header: t('State'),
      cell: (w) => (
        <Badge tone={w.state === 'active' ? 'lime' : 'warn'}>
          {w.state === 'active' ? t('Active') : w.state === 'paused' ? t('Paused') : t('Ended')}
        </Badge>
      ),
      width: 120,
    },
  ];

  return (
    <Page>
      <PageHeader title={t('Chart alert webhooks')} description={t('Turn a chart alert into an order on one market.')} />
      <PageSection title={t('Your webhooks')} headingLevel={2} actions={<Freshness live={hooks} staleAfterMs={90_000} />}>
        {!session ? (
          <EmptyState variant="refused" title={t('You are signed out')} reason={t('Sign in to make a webhook.')} />
        ) : (
          <>
            <div className="cb-action-row">
              <Button onClick={() => setOpen(true)}>{t('New webhook')}</Button>
            </div>
            {made?.token ? (
              <InfoNote>
                <span style={{ display: 'block' }}>{t('Copy these now. The token is shown only this once.')}</span>
                <span style={{ display: 'block' }}>
                  {t('Address')}: <code data-testid="webhook-url">{`${origin}${made.path}`}</code>
                </span>
                <span style={{ display: 'block' }}>
                  {t('Token')}: <code data-testid="webhook-token">{made.token}</code>
                </span>
              </InfoNote>
            ) : null}
            <Table
              label={t('Webhooks')}
              columns={columns}
              rows={hooks.data ?? []}
              getRowId={(w) => w.webhookId}
              status={hooks.status === 'loading' ? 'loading' : hooks.status === 'error' ? 'error' : 'ready'}
              onRetry={hooks.reload}
              errorState={hooks.failure ? <RefusalNote failure={hooks.failure} retry={hooks.reload} /> : undefined}
              emptyState={
                <EmptyState size="inline" title={t('No webhooks yet')} reason={t('Make one for the market your alert watches.')} />
              }
              minWidth={800}
            />
            <InfoNote>
              {t('An alert sends JSON with your token, an alert id, the time it fired, a side (buy or sell) and an amount.')}
            </InfoNote>
          </>
        )}
      </PageSection>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="cb-dialog">
          <DialogHeader>
            <DialogTitle>{t('New webhook')}</DialogTitle>
            <DialogDescription>{t('Each webhook places orders on one market, as you.')}</DialogDescription>
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
          {refused ? <p role="alert">{refused}</p> : null}
          <div className="cb-action-row">
            <Button disabled={!symbol || busy} onClick={() => void create()}>
              {t('Create webhook')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
