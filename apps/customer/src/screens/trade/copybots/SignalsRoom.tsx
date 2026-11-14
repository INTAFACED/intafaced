import { useState } from 'react';
import { Badge, Button, EmptyState, Field, Input, KeyValue, Page, PageHeader, PageSection, Table, type TableColumn } from '@intafaced/ui';
import { useApi, useSession } from '../../../features/session/session';
import { createRoomApi, type ProviderSignal, type SignalEarnings, type SignalPublishRequest, type SignalVetting } from './api';
import { roomCopy } from './copy';
import { useLive } from './live';
import { Freshness, InfoNote, RefusalNote } from './parts';
import { roomRefusal } from './refusals';

/**
 * Signals (CB-bots-api-signal-05, -06, -07; J-copy-bots-otc-22). A provider publishes a signal with a fee model, free
 * or a monthly fee; the platform vets the provider once against its criteria (verification level and a record of
 * their own trades) before the first publish. A profit share is refused as forbidden and an automatic recurring
 * subscription as not built, by the service, never hidden here. Archiving withdraws a signal from the list; buyers keep
 * the period they paid for. Earnings are per asset: gross is the sum of sales, net is gross less the house commission,
 * settled at each sale.
 */
const PUBLISH = '/trade/bots/signals/publish';
const SIGNALS = '/trade/bots/signals';
const DAY = 86_400;
/** The earnings window: every sale from the platform's first day to now. Data, not words. */
const EARNINGS_FROM = '2000-01-01T00:00:00.000Z';

type FeeChoice = SignalPublishRequest['feeModel'];
type T = ReturnType<typeof roomCopy.useCopy>['t'];
const FEE_CHOICES: FeeChoice[] = ['free', 'monthly', 'profit_share', 'recurring'];
/** Each fee model's name and what it means; the service refuses the last two, the screen never hides them. */
function feeChoiceWords(id: FeeChoice, t: T): { label: string; hint: string } {
  if (id === 'free') return { label: t('Free'), hint: t('Anyone can subscribe at no charge.') };
  if (id === 'monthly') return { label: t('Monthly fee'), hint: t('A buyer pays one period at a time, in one asset.') };
  if (id === 'profit_share') return { label: t('Profit share'), hint: t('A share of subscribers’ profit. Not allowed on this platform.') };
  return { label: t('Recurring subscription'), hint: t('Charged again automatically each period. Not built.') };
}

const TIER_WORDS: Record<string, string> = { none: 'Not verified', basic: 'Basic', full: 'Full', institutional: 'Institutional' };
const tierWords = (tier: string | null) => (tier ? (TIER_WORDS[tier] ?? tier) : '—');
const day = (iso: string) => iso.slice(0, 10);
const newKey = () => `signal-publish:${crypto.randomUUID()}`;

export function SignalsRoom({ path }: { path: string }) {
  const url = new URL(path, 'http://x');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === PUBLISH) return <PublishSignal />;
  const view = url.searchParams.get('view');
  return <SignalsHub view={view === 'mine' || view === 'earnings' ? view : 'list'} />;
}

function SignalsNav({ active }: { active: 'list' | 'mine' | 'earnings' | 'publish' }) {
  const { t } = roomCopy.useCopy();
  const links: Array<{ id: typeof active; label: string; href: string }> = [
    { id: 'list', label: t('Signals'), href: SIGNALS },
    { id: 'mine', label: t('My signals'), href: `${SIGNALS}?view=mine` },
    { id: 'earnings', label: t('Earnings'), href: `${SIGNALS}?view=earnings` },
    { id: 'publish', label: t('Publish a signal'), href: PUBLISH },
  ];
  return (
    <nav className="cb-action-row" aria-label={t('Signal sections')}>
      {links.map((l) => (
        <a key={l.id} href={l.href} aria-current={l.id === active ? 'page' : undefined}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}

function VettingNote({ vetting }: { vetting: SignalVetting }) {
  const { t } = roomCopy.useCopy();
  return (
    <InfoNote>
      {t('Vetting passed on {date}: verification {tier}, {fills} trades of your own (needed {minTier} and {minFills}).', {
        date: day(vetting.passedAt),
        tier: tierWords(vetting.tierSeen),
        fills: String(vetting.fillsSeen),
        minTier: tierWords(vetting.minTier),
        minFills: String(vetting.minFills),
      })}
    </InfoNote>
  );
}

function PublishSignal() {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const session = useSession();
  const api = createRoomApi(transport);
  const criteria = useLive((signal) => api.signalCriteria(signal), 'signal-criteria', 300_000);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assetId, setAssetId] = useState('');
  const [recommended, setRecommended] = useState('');
  const [fee, setFee] = useState<FeeChoice>('free');
  const [price, setPrice] = useState('');
  const [periodDays, setPeriodDays] = useState('');
  // One publish key per form: a retried Publish after a lost answer names the same signal, never a second.
  const [publishKey, setPublishKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ title: string; body: string } | null>(null);
  const [published, setPublished] = useState<{ signal: ProviderSignal; vetting: SignalVetting } | null>(null);

  async function publish() {
    setBusy(true);
    setRefused(null);
    const days = periodDays.trim() === '' ? null : Number(periodDays);
    const out = await api.publishSignal({
      publishKey,
      title,
      description,
      assetId,
      recommendedAmount: recommended.trim() === '' ? null : recommended.trim(),
      feeModel: fee,
      price: fee === 'monthly' ? price : null,
      periodSeconds: fee === 'monthly' && days !== null && Number.isInteger(days) && days > 0 ? days * DAY : null,
    });
    setBusy(false);
    if (!out.ok) {
      const words = roomRefusal(out);
      setRefused({ title: words.title, body: words.body });
      return;
    }
    setPublished(out.data);
    setPublishKey(newKey());
  }

  const c = criteria.data;
  return (
    <Page landmark={false}>
      <PageHeader title={t('Publish a signal')} description={t('Share your trade signals with subscribers, free or for a monthly fee.')} />
      <SignalsNav active="publish" />
      <PageSection title={t('Provider criteria')} headingLevel={2} actions={<Freshness live={criteria} staleAfterMs={600_000} />}>
        {criteria.failure ? (
          <RefusalNote failure={criteria.failure} retry={criteria.reload} />
        ) : c && !c.set ? (
          <InfoNote tone="warn">{t('Not set by the platform. Publishing is refused until it is set.')}</InfoNote>
        ) : c ? (
          <KeyValue
            items={[
              { label: t('Verification level'), value: tierWords(c.minTier) },
              { label: t('Trades of your own, at least'), value: c.minFills === null ? null : String(c.minFills) },
            ]}
          />
        ) : null}
      </PageSection>
      <PageSection title={t('Your signal')} headingLevel={2}>
        {!session ? (
          <EmptyState variant="refused" title={t('You are signed out')} reason={t('Sign in to publish a signal.')} />
        ) : (
          <form
            className="cb-form"
            aria-label={t('Publish a signal')}
            onSubmit={(e) => {
              e.preventDefault();
              void publish();
            }}
          >
            <Field label={t('Title')} required>
              <Input kind="text" value={title} onValueChange={setTitle} maxLength={120} autoComplete="off" />
            </Field>
            <Field label={t('Description')} required>
              <Input kind="text" value={description} onValueChange={setDescription} maxLength={4000} autoComplete="off" />
            </Field>
            <Field label={t('Asset')} hint={t('The asset you trade and are paid in, such as USDT.')} required>
              <Input kind="text" value={assetId} onValueChange={(v) => setAssetId(v.toUpperCase())} maxLength={32} autoComplete="off" />
            </Field>
            <Field label={t('Recommended amount')} hint={t('Optional. What you suggest a subscriber trades with.')}>
              <Input kind="decimal" value={recommended} onValueChange={setRecommended} precision={18} />
            </Field>
            <fieldset className="cb-fieldset">
              <legend className="cb-label">{t('Fee model')}</legend>
              {FEE_CHOICES.map((id) => {
                const words = feeChoiceWords(id, t);
                return (
                  <label key={id} className="cb-choice">
                    <input type="radio" name="fee-model" value={id} checked={fee === id} onChange={() => setFee(id)} />
                    <span>{words.label}</span>
                    <span className="cb-hint">{words.hint}</span>
                  </label>
                );
              })}
            </fieldset>
            {fee === 'monthly' ? (
              <>
                <Field label={t('Price')} hint={t('Paid once per period, in the asset above.')}>
                  <Input kind="decimal" value={price} onValueChange={setPrice} precision={18} />
                </Field>
                <Field label={t('Period, days')} hint={t('How long one payment gives access.')}>
                  <Input kind="decimal" value={periodDays} onValueChange={setPeriodDays} precision={0} />
                </Field>
              </>
            ) : null}
            {refused ? (
              <div role="alert">
                <strong>{refused.title}</strong> {refused.body}
              </div>
            ) : null}
            <div className="cb-action-row">
              <Button type="submit" disabled={busy}>
                {t('Publish')}
              </Button>
            </div>
          </form>
        )}
        {published ? (
          <section aria-label={t('Published signal')}>
            <p role="status">
              <Badge tone="lime">{t('Published')}</Badge> {published.signal.title}
            </p>
            <VettingNote vetting={published.vetting} />
            <a href={`${SIGNALS}?view=mine`}>{t('Open My signals')}</a>
          </section>
        ) : null}
      </PageSection>
    </Page>
  );
}

function SignalsHub({ view }: { view: 'list' | 'mine' | 'earnings' }) {
  const { t } = roomCopy.useCopy();
  const title = view === 'mine' ? t('My signals') : view === 'earnings' ? t('Signal earnings') : t('Signals');
  return (
    <Page landmark={false}>
      <PageHeader
        title={title}
        description={t('Trade signals from vetted providers. Free or a monthly fee; never a share of your profit.')}
      />
      <SignalsNav active={view} />
      {view === 'mine' ? <MySignals /> : view === 'earnings' ? <Earnings /> : <SignalList />}
    </Page>
  );
}

function feeWords(s: ProviderSignal, t: T) {
  if (s.feeModel === 'free') return t('Free');
  return t('{price} {asset} every {days} days', {
    price: s.price ?? '—',
    asset: s.assetId,
    days: s.periodSeconds === null ? '—' : String(Math.round(s.periodSeconds / DAY)),
  });
}

function SignalList() {
  const { t } = roomCopy.useCopy();
  const api = createRoomApi(useApi());
  const list = useLive((signal) => api.signalList(signal), 'signal-list', 60_000);
  const columns: TableColumn<ProviderSignal>[] = [
    { id: 'title', header: t('Signal'), value: (s) => s.title, width: 260 },
    { id: 'asset', header: t('Asset'), value: (s) => s.assetId, width: 100 },
    { id: 'fee', header: t('Fee'), value: (s) => feeWords(s, t), width: 220 },
    { id: 'since', header: t('Published'), value: (s) => day(s.createdAt), width: 120 },
    {
      id: 'take',
      header: t('Subscribe'),
      cell: (s) =>
        s.listingId ? <a href={`/market/${s.listingId}`}>{t('Buy a period in the Market')}</a> : <span>{t('No payment needed')}</span>,
      width: 220,
    },
  ];
  return (
    <PageSection title={t('Published signals')} headingLevel={2} actions={<Freshness live={list} staleAfterMs={180_000} />}>
      <Table
        label={t('Published signals')}
        columns={columns}
        rows={list.data ?? []}
        getRowId={(s) => s.id}
        status={list.status === 'loading' ? 'loading' : list.status === 'error' ? 'error' : 'ready'}
        onRetry={list.reload}
        errorState={list.failure ? <RefusalNote failure={list.failure} retry={list.reload} /> : undefined}
        emptyState={<EmptyState size="inline" title={t('No signals are published')} reason={t('Published signals are listed here.')} />}
        minWidth={920}
      />
      <InfoNote>{t('Listed in the order they were published, never ranked by return.')}</InfoNote>
    </PageSection>
  );
}

function MySignals() {
  const { t } = roomCopy.useCopy();
  const session = useSession();
  const api = createRoomApi(useApi());
  const mine = useLive((signal) => api.mySignals(signal), `my-signals:${session ? 'in' : 'out'}`, 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ title: string; body: string } | null>(null);

  async function archive(id: string) {
    setBusy(id);
    setRefused(null);
    const out = await api.archiveSignal(id);
    setBusy(null);
    if (!out.ok) {
      const words = roomRefusal(out);
      setRefused({ title: words.title, body: words.body });
      return;
    }
    mine.reload();
  }

  const columns: TableColumn<ProviderSignal>[] = [
    { id: 'title', header: t('Signal'), value: (s) => s.title, width: 240 },
    { id: 'fee', header: t('Fee'), value: (s) => feeWords(s, t), width: 200 },
    {
      id: 'state',
      header: t('State'),
      cell: (s) => (
        <Badge tone={s.state === 'published' ? 'lime' : 'warn'}>{s.state === 'published' ? t('Published') : t('Archived')}</Badge>
      ),
      width: 120,
    },
    {
      id: 'action',
      header: t('Action'),
      cell: (s) =>
        s.state === 'published' ? (
          <Button
            size={28}
            variant="secondary"
            disabled={busy === s.id}
            onClick={() => void archive(s.id)}
            aria-label={t('Archive {title}', { title: s.title })}
          >
            {t('Archive')}
          </Button>
        ) : (
          <span>
            {t('Withdrawn on {date}. Subscribers keep the period they paid for.', { date: s.archivedAt ? day(s.archivedAt) : '—' })}
          </span>
        ),
      width: 320,
    },
  ];
  if (!session) return <EmptyState variant="refused" title={t('You are signed out')} reason={t('Sign in to see your signals.')} />;
  return (
    <PageSection title={t('Your signals')} headingLevel={2} actions={<Freshness live={mine} staleAfterMs={180_000} />}>
      {mine.data?.vetting ? <VettingNote vetting={mine.data.vetting} /> : null}
      {refused ? (
        <div role="alert">
          <strong>{refused.title}</strong> {refused.body}
        </div>
      ) : null}
      <Table
        label={t('Your signals')}
        columns={columns}
        rows={mine.data?.signals ?? []}
        getRowId={(s) => s.id}
        status={mine.status === 'loading' ? 'loading' : mine.status === 'error' ? 'error' : 'ready'}
        onRetry={mine.reload}
        errorState={mine.failure ? <RefusalNote failure={mine.failure} retry={mine.reload} /> : undefined}
        emptyState={
          <EmptyState
            size="inline"
            title={t('You have no signals')}
            reason={t('Publish one to list it.')}
            action={{ label: t('Publish a signal'), href: PUBLISH }}
          />
        }
        minWidth={880}
      />
    </PageSection>
  );
}

function Earnings() {
  const { t } = roomCopy.useCopy();
  const session = useSession();
  const api = createRoomApi(useApi());
  const earnings = useLive(
    (signal) => api.signalEarnings({ from: EARNINGS_FROM, to: new Date().toISOString() }, signal),
    `signal-earnings:${session ? 'in' : 'out'}`,
    60_000,
  );
  type Row = SignalEarnings['assets'][number];
  const columns: TableColumn<Row>[] = [
    { id: 'asset', header: t('Asset'), value: (r) => r.assetId, width: 100 },
    { id: 'sales', header: t('Sales'), value: (r) => String(r.sales), width: 80 },
    { id: 'gross', header: t('Gross'), value: (r) => r.gross, width: 140 },
    { id: 'commission', header: t('Commission'), value: (r) => r.commission, width: 140 },
    { id: 'net', header: t('Net'), value: (r) => r.net, width: 140 },
  ];
  if (!session) return <EmptyState variant="refused" title={t('You are signed out')} reason={t('Sign in to see your earnings.')} />;
  return (
    <PageSection title={t('Earnings by asset')} headingLevel={2} actions={<Freshness live={earnings} staleAfterMs={180_000} />}>
      <Table
        label={t('Earnings by asset')}
        columns={columns}
        rows={earnings.data?.assets ?? []}
        getRowId={(r) => r.assetId}
        status={earnings.status === 'loading' ? 'loading' : earnings.status === 'error' ? 'error' : 'ready'}
        onRetry={earnings.reload}
        errorState={earnings.failure ? <RefusalNote failure={earnings.failure} retry={earnings.reload} /> : undefined}
        emptyState={<EmptyState size="inline" title={t('No sales')} reason={t('Sales of your monthly fee signals show here.')} />}
        minWidth={600}
      />
      <KeyValue
        aria-label={t('How earnings are paid')}
        items={[
          { label: t('Settlement'), value: t('Settled at sale') },
          { label: t('Profit share'), value: t('Not set by the platform') },
        ]}
      />
      <InfoNote>{t('Gross is the sum of your sales. Net is gross less the platform’s commission on each sale.')}</InfoNote>
    </PageSection>
  );
}
