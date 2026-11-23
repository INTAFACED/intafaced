import { useEffect, useState, type FormEvent } from 'react';
import { BANK_CARDS_CONTROLS_GET, BANK_CARDS_CONTROLS_BLOCK, BANK_CARDS_CONTROLS_LIFT } from '@intafaced/contracts/bank-cards-procedures';
import type { z } from 'zod';
import type { ApiResult } from '../../../shared/api';
import { Button, Field } from '@intafaced/ui/lit';
import { useSession } from '../../session';
import { useBankRecord } from '../components';
import { type CardControls, type cardSchema } from '../contracts';
import { ChannelSwitch, Panel, ResourceView } from '../bank-settings/parts';
import { Refusal } from './CardJourney';
import { cardBlocksCopy, declineKey } from '../card-blocks-copy';
import { withPlainRefusal } from '../money-refusal-copy';

/**
 * A card's controls (J-bank-14 #1, BK-cctl-01): the categories, merchants and countries the person blocked, and the
 * history of the card's temporary lock (its freeze). Every state shown is svc-bank's own answer; blocking only protects
 * the card, and a block is lifted by the person's own press. Nothing here moves money.
 */

type CardRecord = z.infer<typeof cardSchema>;
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

export function CardBlocksPanel({ card }: { card: CardRecord }) {
  const { t } = cardBlocksCopy.useCopy();
  const read = useBankRecord(BANK_CARDS_CONTROLS_GET, { cardId: card.id });
  return (
    <Panel level={3} title={t('blocksTitle')} lead={t('blocksLead')} id={`card-blocks-${card.id}`}>
      <ResourceView resource={read.resource} reload={read.reload}>
        {(stored) => <Blocks key={card.id} card={card} stored={stored} />}
      </ResourceView>
    </Panel>
  );
}

function Blocks({ card, stored }: { card: CardRecord; stored: CardControls }) {
  const { api } = useSession();
  const { t } = cardBlocksCopy.useCopy();
  const [controls, setControls] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [merchant, setMerchant] = useState('');
  const [country, setCountry] = useState('');
  useEffect(() => setControls(stored), [stored]);
  const closed = card.status === 'closed';

  async function send(call: () => Promise<ApiResult<CardControls>>) {
    setBusy(true);
    setFailure(null);
    try {
      const done = await call();
      if (!done.ok) {
        setFailure(withPlainRefusal(done));
        return false;
      }
      setControls(done.data);
      return true;
    } finally {
      setBusy(false);
    }
  }
  const addBlock = (kind: 'category' | 'merchant' | 'country', value: string) =>
    send(() => api.call(BANK_CARDS_CONTROLS_BLOCK, { cardId: card.id, kind, value }));
  const liftBlock = (controlId: string) => send(() => api.call(BANK_CARDS_CONTROLS_LIFT, { cardId: card.id, controlId }));
  const live = (kind: 'category' | 'merchant' | 'country') => controls.controls.filter((c) => c.kind === kind);
  const blockedCategory = (category: string) => live('category').find((c) => c.value === category);
  const submit = (kind: 'merchant' | 'country', value: string, clear: () => void) => async (event: FormEvent) => {
    event.preventDefault();
    if (await addBlock(kind, value)) clear();
  };
  const blockedList = (kind: 'merchant' | 'country', label: string) => {
    const rows = live(kind);
    return rows.length ? (
      <ul aria-label={label}>
        {rows.map((c) => (
          <li key={c.id}>
            <span lang="und" dir="auto">
              {c.value}
            </span>{' '}
            <Button tone="quiet" disabled={busy || closed} onClick={() => void liftBlock(c.id)}>
              {t('allowAgain')}
            </Button>
          </li>
        ))}
      </ul>
    ) : (
      <p className="lt-hint">{t('noneBlocked')}</p>
    );
  };

  return (
    <div>
      <section role="group" aria-label={t('categoriesTitle')}>
        <h4>{t('categoriesTitle')}</h4>
        {controls.categories.map((category) => {
          const block = blockedCategory(category);
          return (
            <ChannelSwitch
              key={category}
              label={t(`category_${category}` as 'category_gambling')}
              on={!!block}
              state={block ? t('stateBlocked') : t('stateAllowed')}
              disabled={busy || closed}
              onToggle={() => void (block ? liftBlock(block.id) : addBlock('category', category))}
            />
          );
        })}
      </section>
      <form aria-label={t('merchantsTitle')} onSubmit={submit('merchant', merchant, () => setMerchant(''))}>
        <h4>{t('merchantsTitle')}</h4>
        <Field label={t('merchantField')} value={merchant} maxLength={64} onChange={(e) => setMerchant(e.target.value)} />
        <Button tone="primary" type="submit" disabled={busy || closed || !merchant.trim()}>
          {t('blockMerchant')}
        </Button>
        {blockedList('merchant', `${t('merchantsTitle')}: ${t('blockedList')}`)}
      </form>
      <form aria-label={t('countriesTitle')} onSubmit={submit('country', country, () => setCountry(''))}>
        <h4>{t('countriesTitle')}</h4>
        <Field label={t('countryField')} value={country} maxLength={2} onChange={(e) => setCountry(e.target.value)} />
        <Button tone="primary" type="submit" disabled={busy || closed || !country.trim()}>
          {t('blockCountry')}
        </Button>
        {blockedList('country', `${t('countriesTitle')}: ${t('blockedList')}`)}
      </form>
      {failure && <Refusal failure={failure} />}
      {closed && <p className="lt-hint">{t('closedNote')}</p>}
      <section role="region" aria-label={t('lockTitle')}>
        <h4>{t('lockTitle')}</h4>
        <p role="status">{t(`lockNow_${card.status}` as 'lockNow_active')}</p>
        {controls.history.length ? (
          <div role="region" aria-label={t('lockHistory')} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('colChange')}</th>
                  <th scope="col">{t('colBy')}</th>
                  <th scope="col">{t('colWhen')}</th>
                </tr>
              </thead>
              <tbody>
                {controls.history.map((row) => (
                  <tr key={row.id}>
                    <td>{t(`history_${row.status}` as 'history_frozen')}</td>
                    <td>{t(`by_${row.actor}` as 'by_owner')}</td>
                    <td>
                      <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="lt-hint">{t('noHistory')}</p>
        )}
      </section>
    </div>
  );
}

/** A declined purchase's reason in plain words, with what to do next; an unknown code says so and keeps the code. */
export function DeclineReason({ code }: { code: string }) {
  const { t } = cardBlocksCopy.useCopy();
  const key = declineKey(code);
  return (
    <p className="lt-hint" data-testid="decline-reason" data-code={code}>
      {key ? t(key) : t('declineUnknown')}
    </p>
  );
}

/** Where the issuer said the purchase was: its merchant and country, when it named them. */
export function DecisionMerchant({ merchant, country }: { merchant: string | null; country: string | null }) {
  const { t } = cardBlocksCopy.useCopy();
  if (merchant === null && country === null) return null;
  return (
    <dl>
      {merchant !== null && (
        <div>
          <dt>{t('merchantLabel')}</dt>
          <dd lang="und" dir="auto">
            {merchant}
          </dd>
        </div>
      )}
      {country !== null && (
        <div>
          <dt>{t('countryLabel')}</dt>
          <dd lang="zxx" dir="ltr">
            {country}
          </dd>
        </div>
      )}
    </dl>
  );
}
