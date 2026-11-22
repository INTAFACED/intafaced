import { useState } from 'react';
import { Button, DecimalField, Field, Freshness, RefusalBox, Tag } from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue, Tabs } from '@intafaced/ui/lit/templates';
import { useApi, useSession } from '../../../features/session/session';
import { createRoomApi, type ProviderSignal, type SignalPublishRequest, type SignalVetting } from './api';
import { roomCopy } from './copy';
import { useLive, type Live } from './live';
import { roomRefusal } from './refusals';

/**
 * Publish a signal (CB-bots-api-signal-05; J-copy-bots-otc-22), on the flow template. A provider publishes a signal
 * with a fee model, free or a monthly fee; the platform vets the provider once against its criteria (verification
 * level and a record of their own trades) before the first publish. A profit share is refused as forbidden and an
 * automatic recurring subscription as not built, by the service, never hidden here.
 */
const PUBLISH = '/trade/bots/signals/publish';
const SIGNALS = '/trade/bots/signals';
const DAY = 86_400;

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

/** The signal rooms' own row: the list, the provider's signals, earnings and publishing. */
function SignalsTabs({ active }: { active: 'list' | 'mine' | 'earnings' | 'publish' }) {
  const { t } = roomCopy.useCopy();
  const items = [
    { id: 'list', label: t('Signals'), href: SIGNALS },
    { id: 'mine', label: t('My signals'), href: `${SIGNALS}?view=mine` },
    { id: 'earnings', label: t('Earnings'), href: `${SIGNALS}?view=earnings` },
    { id: 'publish', label: t('Publish a signal'), href: PUBLISH },
  ];
  return <Tabs label={t('Signal sections')} items={items} current={items.find((i) => i.id === active)!.href} />;
}

/** How fresh a read is: waiting for the first read, not read, or live and stale with its time. */
function ReadFreshness({ live, staleAfterMs }: { live: Pick<Live<unknown>, 'asOf' | 'failure' | 'status'>; staleAfterMs: number }) {
  const { t } = roomCopy.useCopy();
  const words = { live: t('Live'), stale: t('Stale'), unknown: t('Unknown'), asOf: t('as of') };
  if (live.status === 'loading')
    return <Freshness asOf={null} staleAfterMs={staleAfterMs} words={words} reason={t('Waiting for the first read')} />;
  if (live.asOf === null) return <Freshness asOf={null} staleAfterMs={staleAfterMs} words={words} reason={t('Could not be read')} />;
  return (
    <Freshness
      asOf={live.asOf}
      staleAfterMs={staleAfterMs}
      words={words}
      reason={live.failure ? t('The last refresh failed; showing the previous read') : undefined}
    />
  );
}

function VettingNote({ vetting }: { vetting: SignalVetting }) {
  const { t } = roomCopy.useCopy();
  return (
    <p role="note">
      {t('Vetting passed on {date}: verification {tier}, {fills} trades of your own (needed {minTier} and {minFills}).', {
        date: day(vetting.passedAt),
        tier: tierWords(vetting.tierSeen),
        fills: String(vetting.fillsSeen),
        minTier: tierWords(vetting.minTier),
        minFills: String(vetting.minFills),
      })}
    </p>
  );
}

export function PublishSignal() {
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
  const criteriaFailure = criteria.failure ? roomRefusal(criteria.failure) : null;
  return (
    <FlowTemplate
      title={t('Publish a signal')}
      description={t('Share your trade signals with subscribers, free or for a monthly fee.')}
      state={{ kind: 'ready' }}
      step={
        <>
          <SignalsTabs active="publish" />
          <section aria-label={t('Your signal')}>
            <h2>{t('Your signal')}</h2>
            {!session ? (
              <RefusalBox refusal={{ variant: 'refused', title: t('You are signed out'), body: t('Sign in to publish a signal.') }} />
            ) : (
              <form
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
                <DecimalField
                  label={t('Recommended amount')}
                  hint={t('Optional. What you suggest a subscriber trades with.')}
                  value={recommended}
                  onValueChange={setRecommended}
                  precision={18}
                />
                <fieldset>
                  <legend>{t('Fee model')}</legend>
                  {FEE_CHOICES.map((id) => {
                    const words = feeChoiceWords(id, t);
                    return (
                      <label key={id} className="lt-field">
                        <input type="radio" name="fee-model" value={id} checked={fee === id} onChange={() => setFee(id)} />
                        <span>{words.label}</span>
                        <span className="lt-hint">{words.hint}</span>
                      </label>
                    );
                  })}
                </fieldset>
                {fee === 'monthly' ? (
                  <>
                    <DecimalField
                      label={t('Price')}
                      hint={t('Paid once per period, in the asset above.')}
                      value={price}
                      onValueChange={setPrice}
                      precision={18}
                    />
                    <DecimalField
                      label={t('Period, days')}
                      hint={t('How long one payment gives access.')}
                      value={periodDays}
                      onValueChange={setPeriodDays}
                      precision={0}
                    />
                  </>
                ) : null}
                {refused ? (
                  <div role="alert">
                    <strong>{refused.title}</strong> {refused.body}
                  </div>
                ) : null}
                <div className="lt-actions">
                  <Button type="submit" disabled={busy}>
                    {t('Publish')}
                  </Button>
                </div>
              </form>
            )}
            {published ? (
              <section aria-label={t('Published signal')}>
                <p role="status">
                  <Tag tone="accent">{t('Published')}</Tag> {published.signal.title}
                </p>
                <VettingNote vetting={published.vetting} />
                <a className="lt-link" href={`${SIGNALS}?view=mine`}>
                  {t('Open My signals')}
                </a>
              </section>
            ) : null}
          </section>
        </>
      }
      summary={
        <section aria-label={t('Provider criteria')}>
          <h2>{t('Provider criteria')}</h2>
          <ReadFreshness live={criteria} staleAfterMs={600_000} />
          {criteriaFailure ? (
            <>
              <RefusalBox
                refusal={{
                  variant: 'unreachable',
                  title: criteriaFailure.title,
                  body: criteriaFailure.body,
                  reference: criteriaFailure.code ? t('Reference {code}', { code: criteriaFailure.code }) : undefined,
                }}
              />
              <Button onClick={criteria.reload}>{t('Try again')}</Button>
            </>
          ) : c && !c.set ? (
            <p role="note">{t('Not set by the platform. Publishing is refused until it is set.')}</p>
          ) : c ? (
            <KeyValue
              label={t('Provider criteria')}
              rows={[
                { label: t('Verification level'), value: tierWords(c.minTier) },
                c.minFills === null
                  ? { label: t('Trades of your own, at least'), value: '—', unset: true }
                  : { label: t('Trades of your own, at least'), value: String(c.minFills) },
              ]}
            />
          ) : null}
        </section>
      }
    />
  );
}
