// volt-room: /trade/bots/signals/publish
import { useState } from 'react';
import { Button, Field, Radio, Tag } from '@intafaced/ui/lit';
import { FlowTemplate, FreshnessChip, KeyValue, Tabs, type RoomState } from '@intafaced/ui/lit/templates';
import { useApi, useSession } from '../../../features/session/session';
import { typedDecimal } from '../kit-parts';
import { createRoomApi, type ProviderSignal, type SignalPublishRequest, type SignalVetting } from './api';
import { roomCopy } from './copy';
import { useLive, type Live } from './live';
import { InfoNote, RefusalNote } from './notes';
import { roomRefusal } from './refusals';

/**
 * Publish a signal (CB-bots-api-signal-05, -06, -07; J-copy-bots-otc-22). A provider publishes a signal with a fee
 * model, free or a monthly fee; the platform vets the provider once against its criteria (verification level and a
 * record of their own trades) before the first publish. A profit share is refused as forbidden and an automatic
 * recurring subscription as not built, by the service, never hidden here.
 */
const PUBLISH = '/trade/bots/signals/publish';
const SIGNALS = '/trade/bots/signals';
const DAY = 86_400;

type FeeChoice = SignalPublishRequest['feeModel'];
type T = ReturnType<typeof roomCopy.useCopy>['t'];
const FEE_CHOICES: FeeChoice[] = ['free', 'monthly', 'profit_share', 'recurring'];

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

function SignalFreshness({ live, staleAfterMs }: { live: Pick<Live<unknown>, 'asOf' | 'failure' | 'status'>; staleAfterMs: number }) {
  const { t } = roomCopy.useCopy();
  if (live.status === 'loading')
    return <FreshnessChip asOf={null} staleAfterMs={staleAfterMs} kind="unknown" reason={t('Waiting for the first read')} />;
  if (live.asOf === null) return <FreshnessChip asOf={null} staleAfterMs={staleAfterMs} kind="unknown" reason={t('Could not be read')} />;
  return (
    <FreshnessChip
      asOf={live.asOf}
      staleAfterMs={staleAfterMs}
      showAsOf
      reason={live.failure ? t('The last refresh failed; showing the previous read') : undefined}
    />
  );
}

function PublishVettingNote({ vetting }: { vetting: SignalVetting }) {
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

export function PublishSignalRoom() {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  // The session itself, not the context (always present): null until the boot refresh brings a token.
  const { session } = useSession();
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
  const state: RoomState = !session
    ? {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: t('You are signed out'),
          body: t('Sign in to publish a signal.'),
        },
      }
    : { kind: 'ready' };

  return (
    <FlowTemplate
      title={t('Publish a signal')}
      description={t('Share your trade signals with subscribers, free or for a monthly fee.')}
      section={
        <Tabs
          label={t('Signal sections')}
          current={PUBLISH}
          items={[
            { label: t('Signals'), href: SIGNALS },
            { label: t('My signals'), href: `${SIGNALS}?view=mine` },
            { label: t('Earnings'), href: `${SIGNALS}?view=earnings` },
            { label: t('Publish a signal'), href: PUBLISH },
          ]}
        />
      }
      state={state}
      step={
        <section className="lt-stack" aria-labelledby="publish-signal-title">
          <h2 id="publish-signal-title">{t('Your signal')}</h2>
          <form
            className="lt-stack"
            aria-label={t('Publish a signal')}
            onSubmit={(e) => {
              e.preventDefault();
              void publish();
            }}
          >
            <Field
              label={t('Title')}
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              autoComplete="off"
            />
            <Field
              label={t('Description')}
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={4000}
              autoComplete="off"
            />
            <Field
              label={t('Asset')}
              hint={t('The asset you trade and are paid in, such as USDT.')}
              required
              value={assetId}
              onChange={(e) => setAssetId(e.target.value.toUpperCase())}
              maxLength={32}
              autoComplete="off"
            />
            <Field
              label={t('Recommended amount')}
              hint={t('Optional. What you suggest a subscriber trades with.')}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={recommended}
              onChange={(e) => {
                const next = typedDecimal(e.target.value, 18);
                if (next !== null) setRecommended(next);
              }}
            />
            <fieldset className="lt-stack">
              <legend>{t('Fee model')}</legend>
              {FEE_CHOICES.map((id) => {
                const words = feeChoiceWords(id, t);
                return (
                  <Radio key={id} name="fee-model" value={id} checked={fee === id} onSelect={() => setFee(id)}>
                    <span>{words.label}</span> <span className="lt-hint">{words.hint}</span>
                  </Radio>
                );
              })}
            </fieldset>
            {fee === 'monthly' ? (
              <>
                <Field
                  label={t('Price')}
                  hint={t('Paid once per period, in the asset above.')}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={price}
                  onChange={(e) => {
                    const next = typedDecimal(e.target.value, 18);
                    if (next !== null) setPrice(next);
                  }}
                />
                <Field
                  label={t('Period, days')}
                  hint={t('How long one payment gives access.')}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={periodDays}
                  onChange={(e) => {
                    const next = typedDecimal(e.target.value, 0);
                    if (next !== null) setPeriodDays(next);
                  }}
                />
              </>
            ) : null}
            {refused ? (
              <div className="lt-refusal" data-refusal="refused" role="alert">
                <p className="lt-refusal-title">{refused.title}</p>
                <p className="lt-refusal-body">{refused.body}</p>
              </div>
            ) : null}
            <div className="lt-actions">
              <Button type="submit" tone="primary" disabled={busy} aria-busy={busy || undefined}>
                {t('Publish')}
              </Button>
            </div>
          </form>
          {published ? (
            <section className="lt-stack" aria-label={t('Published signal')}>
              <p role="status">
                <Tag tone="accent">{t('Published')}</Tag> {published.signal.title}
              </p>
              <PublishVettingNote vetting={published.vetting} />
              <a className="lt-link" href={`${SIGNALS}?view=mine`}>
                {t('Open My signals')}
              </a>
            </section>
          ) : null}
        </section>
      }
      summary={
        <section className="lt-stack" aria-labelledby="provider-criteria-title">
          <div className="lt-toolbar">
            <h2 id="provider-criteria-title">{t('Provider criteria')}</h2>
            <SignalFreshness live={criteria} staleAfterMs={600_000} />
          </div>
          {criteria.failure ? (
            <RefusalNote failure={criteria.failure} retry={criteria.reload} />
          ) : c && !c.set ? (
            <InfoNote tone="warn">{t('Not set by the platform. Publishing is refused until it is set.')}</InfoNote>
          ) : c ? (
            <KeyValue
              label={t('Provider criteria')}
              rows={[
                { label: t('Verification level'), value: tierWords(c.minTier) },
                {
                  label: t('Trades of your own, at least'),
                  value: c.minFills === null ? '—' : String(c.minFills),
                  unset: c.minFills === null,
                },
              ]}
            />
          ) : null}
        </section>
      }
    />
  );
}
