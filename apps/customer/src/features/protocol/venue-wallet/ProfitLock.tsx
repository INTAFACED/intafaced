import { useState } from 'react';
import type { z } from 'zod';
import { Button, Field } from '@intafaced/ui/lit';
import {
  PROFIT_LOCK_DECLINE,
  PROFIT_LOCK_GET,
  PROFIT_LOCK_SET,
  type profitLockViewSchema,
} from '@intafaced/contracts/trade-profit-lock-procedures';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { plainDecimal } from './venue-account-api';
import { profitLockCopy, type ProfitLockCopyKey } from './profit-lock-copy';

type View = z.infer<typeof profitLockViewSchema>;
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** What the room signs for an offer: the offer's own withdrawal key, the amount filled in and the cold wallet. */
export interface ProfitLockSign {
  readonly key: string;
  readonly amount: string;
  readonly destination: string;
}

/** Which field a refusal names, and its words here (no service sentence is shown). */
type RefusalKey = Extract<ProfitLockCopyKey, `refused${string}`>;

function refusalOf(failure: Failed): { field: 'target' | 'share' | 'coldWallet' | null; key: RefusalKey } {
  const code = failure.code ?? '';
  if (code === 'trade.profit_lock_address_ours') return { field: 'coldWallet', key: 'refusedOurs' };
  if (code === 'trade.profit_lock_address_mistyped') return { field: 'coldWallet', key: 'refusedMistyped' };
  if (code === 'trade.profit_lock_field_invalid') {
    const said = failure.message ?? '';
    if (said.startsWith('Weekly target')) return { field: 'target', key: 'refusedTarget' };
    if (said.startsWith('Share to lock')) return { field: 'share', key: 'refusedShare' };
    return { field: 'coldWallet', key: said.startsWith('This is the wallet') ? 'refusedOwnWallet' : 'refusedMistyped' };
  }
  return { field: null, key: 'refusedOther' };
}

/**
 * Profit lock (J-wallet-26), in the venue account room: the person's weekly target, the share to lock and their cold
 * wallet (svc-trade `trade.profitLock.*`); this week's realised profit as the venue reports it, with its as-of time, or
 * "Can't read the venue" with the last time it was read; and once the target is reached, this week's offer: a venue
 * withdrawal filled in with the share and the cold wallet, the venue's fee and withdrawable figure, cut to that figure
 * when the share is above it. Signing hands the withdrawal to the room, which confirms it and asks the wallet; closing it
 * moves nothing. `version` changes when the room's withdrawal moves on, so the offer is read again.
 */
export function ProfitLock({
  owner,
  busy,
  version,
  onSign,
}: {
  owner: string;
  busy: boolean;
  version: string;
  onSign: (ask: ProfitLockSign) => void;
}) {
  const { t } = profitLockCopy.useCopy();
  const { api } = useSession();
  const lock = useResource((signal) => api.call(PROFIT_LOCK_GET, { owner }, { signal }), `profit-lock:${owner}:${version}`);
  const [form, setForm] = useState<{ target: string; share: string; coldWallet: string } | null>(null);
  const [refused, setRefused] = useState<ReturnType<typeof refusalOf> | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const view: View | null = lock.resource.status === 'ready' ? lock.resource.data : null;
  const values = form ?? {
    target: view?.setting ? plainDecimal(view.setting.target) : '',
    share: view?.setting ? plainDecimal(view.setting.share) : '',
    coldWallet: view?.setting?.coldWallet ?? '',
  };
  const time = (iso: string) => new Date(iso).toLocaleString();

  async function save() {
    if (working) return;
    setWorking(true);
    setRefused(null);
    setSaved(null);
    try {
      const answer = await api.call(PROFIT_LOCK_SET, { owner, ...values });
      if (!answer.ok) return setRefused(refusalOf(answer));
      setForm(null);
      setSaved(answer.data.setting?.coldWallet ?? '');
      lock.reload();
    } finally {
      setWorking(false);
    }
  }

  async function decline(offerKey: string) {
    if (working) return;
    setWorking(true);
    setRefused(null);
    try {
      const answer = await api.call(PROFIT_LOCK_DECLINE, { owner, offerKey });
      if (!answer.ok) return setRefused({ field: null, key: 'refusedOther' });
      lock.reload();
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;
  const edit = (field: 'target' | 'share' | 'coldWallet') => (event: { target: { value: string } }) =>
    setForm({ ...values, [field]: event.target.value });
  const errorFor = (field: 'target' | 'share' | 'coldWallet') => (refused?.field === field ? t(refused.key) : undefined);
  const offer = view?.offer ?? null;
  const withdrawal = view?.withdrawal ?? null;

  return (
    <section aria-label={t('title')} data-panel="profit-lock">
      <h2>{t('title')}</h2>
      <p>{t('intro')}</p>
      <Field
        label={t('target')}
        hint={t('targetHint')}
        name="profit-lock-target"
        inputMode="decimal"
        autoComplete="off"
        value={values.target}
        disabled={disabled}
        error={errorFor('target')}
        onChange={edit('target')}
      />
      <Field
        label={t('share')}
        hint={t('shareHint')}
        name="profit-lock-share"
        inputMode="decimal"
        autoComplete="off"
        value={values.share}
        disabled={disabled}
        error={errorFor('share')}
        onChange={edit('share')}
      />
      <Field
        label={t('coldWallet')}
        hint={t('coldWalletHint')}
        name="profit-lock-cold-wallet"
        autoComplete="off"
        spellCheck={false}
        value={values.coldWallet}
        disabled={disabled}
        error={errorFor('coldWallet')}
        onChange={edit('coldWallet')}
      />
      <Button tone="primary" disabled={disabled} onClick={() => void save()}>
        {t('save')}
      </Button>
      {refused && refused.field === null ? <p role="alert">{t(refused.key)}</p> : null}
      {saved !== null ? (
        <p role="status" data-testid="profit-lock-saved">
          {t('saved', { address: saved })}
        </p>
      ) : null}
      {view?.setting ? (
        <section aria-label={t('weekTitle')} data-testid="profit-lock-week">
          <h3>{t('weekTitle')}</h3>
          <p data-testid="profit-lock-setting">
            {t('setting', {
              target: plainDecimal(view.setting.target),
              share: plainDecimal(view.setting.share),
              address: view.setting.coldWallet,
            })}
          </p>
          {view.week.readable && view.week.profit !== null ? (
            <dl>
              <div>
                <dt>{t('weekFrom')}</dt>
                <dd>
                  <time dateTime={view.week.from}>{time(view.week.from)}</time>
                </dd>
              </div>
              <div>
                <dt>{t('weekTitle')}</dt>
                <dd data-testid="profit-lock-profit">
                  {t('weekProfit', { profit: plainDecimal(view.week.profit), target: plainDecimal(view.setting.target) })}
                </dd>
              </div>
              <div>
                <dt>{t('asOf')}</dt>
                <dd>
                  <time dateTime={view.week.asOf ?? ''} data-testid="profit-lock-as-of">
                    {view.week.asOf ? time(view.week.asOf) : ''}
                  </time>
                </dd>
              </div>
            </dl>
          ) : (
            <div role="alert" data-testid="profit-lock-unread">
              <h4>{t('unreadTitle')}</h4>
              <p>{t('unreadBody')}</p>
              <p>
                {t('lastRead')}:{' '}
                {view.week.lastReadAt ? (
                  <time dateTime={view.week.lastReadAt} data-testid="profit-lock-last-read">
                    {time(view.week.lastReadAt)}
                  </time>
                ) : (
                  t('neverRead')
                )}
              </p>
            </div>
          )}
          {view.week.readable && !offer ? <p>{t('noOffer')}</p> : null}
        </section>
      ) : null}
      {offer && offer.state === 'ready' && withdrawal ? (
        <section aria-label={t('readyTitle')} data-testid="profit-lock-offer">
          <h3>{t('readyTitle')}</h3>
          <p>
            {t('readyBody', { profit: plainDecimal(offer.profit), share: plainDecimal(offer.share), amount: plainDecimal(offer.amount) })}
          </p>
          <h4>{t('withdrawalTitle')}</h4>
          <dl>
            <div>
              <dt>{t('amount')}</dt>
              <dd data-testid="profit-lock-amount">{plainDecimal(withdrawal.amount)} TEST USDC</dd>
            </div>
            <div>
              <dt>{t('to')}</dt>
              <dd data-testid="profit-lock-to">{offer.coldWallet}</dd>
            </div>
            <div>
              <dt>{t('fee')}</dt>
              <dd data-testid="profit-lock-fee">
                {withdrawal.fee.known ? `${plainDecimal(withdrawal.fee.value)} TEST USDC` : t('notKnown')}
              </dd>
            </div>
            <div>
              <dt>{t('withdrawable')}</dt>
              <dd data-testid="profit-lock-withdrawable">{plainDecimal(withdrawal.withdrawable)} TEST USDC</dd>
            </div>
          </dl>
          <p>{t('withdrawableNote', { free: plainDecimal(withdrawal.free) })}</p>
          {withdrawal.cut ? (
            <p role="status" data-testid="profit-lock-cut">
              {t('cut', { share: plainDecimal(offer.amount), amount: plainDecimal(withdrawal.amount) })}
            </p>
          ) : null}
          <p>{t('signNote')}</p>
          <Button
            tone="primary"
            disabled={disabled}
            onClick={() => onSign({ key: offer.withdrawalKey, amount: withdrawal.amount, destination: offer.coldWallet })}
          >
            {t('sign')}
          </Button>{' '}
          <Button tone="secondary" disabled={disabled} onClick={() => void decline(offer.offerKey)}>
            {t('close')}
          </Button>
        </section>
      ) : null}
      {offer && offer.state === 'signed' ? (
        <section aria-label={t('signedTitle')} data-testid="profit-lock-signed">
          <h3>{t('signedTitle')}</h3>
          <p>{t('signedBody', { address: offer.coldWallet })}</p>
        </section>
      ) : null}
      {offer && offer.state === 'declined' ? (
        <section aria-label={t('declinedTitle')} data-testid="profit-lock-declined">
          <h3>{t('declinedTitle')}</h3>
          <p>{t('declinedBody')}</p>
        </section>
      ) : null}
    </section>
  );
}
