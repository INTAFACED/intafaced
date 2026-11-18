import { useState, type FormEvent } from 'react';
import { Button } from '@intafaced/ui';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { SupportScamContact, SupportScamReportInput, SupportScamWhen } from '@intafaced/contracts/support-safety';
import { useSession } from '../../session/session';
import { safetyCopy, type SafetyCopyKey } from '../safety-copy';
import { Acknowledgement, EarlierAcknowledgements, safetyState, useMyAcknowledgements, useSafetySend } from '../safety-ack';

/**
 * Report a scam (BK-safe-02, J-bank-18 #3), on the flow template. `support.safety.reportScam` checks with the bank that
 * the person sent the transfer named (after sending money; before, there is none to name), then makes one request in the scam category with a case note for the desk, and
 * acknowledges it once. The transfer is the report's key: the same transfer reported again shows the same
 * acknowledgement. A transfer link can open the form on that transfer (`?transfer=<id>`).
 */

const WHEN: readonly [SupportScamWhen, Extract<SafetyCopyKey, `scamWhen${string}`>][] = [
  ['after_sending', 'scamWhenAfter'],
  ['before_sending', 'scamWhenBefore'],
];
const CONTACT: readonly [SupportScamContact, Extract<SafetyCopyKey, `contact${string}`>][] = [
  ['phone_call', 'contactPhone'],
  ['text_message', 'contactText'],
  ['email', 'contactEmail'],
  ['social_media', 'contactSocial'],
  ['messaging_app', 'contactMessaging'],
  ['in_person', 'contactInPerson'],
  ['other', 'contactOther'],
];
const AMOUNT = /^\d{1,18}(\.\d{1,18})?$/;
const TRANSFER = /^[A-Za-z0-9._:-]{8,64}$/;

const transferFromUrl = () => {
  const id = new URLSearchParams(window.location.search).get('transfer')?.trim() ?? '';
  return TRANSFER.test(id) ? id : '';
};

export function ScamReportRoom() {
  const { t } = safetyCopy.useCopy();
  const { userId } = useSession();
  const [when, setWhen] = useState<SupportScamWhen>('after_sending');
  const [amount, setAmount] = useState('');
  const [assetId, setAssetId] = useState('USDT');
  const [transferId, setTransferId] = useState(transferFromUrl);
  const [contactedBy, setContactedBy] = useState<SupportScamContact>('phone_call');
  const [details, setDetails] = useState('');
  const { send, busy, sent, refusal } = useSafetySend<SupportScamReportInput>('scam', 'safety.reportScam');
  const earlier = useMyAcknowledgements('scam', sent?.id ?? null);
  const asset = assetId.trim().toUpperCase();
  const sentMoney = when === 'after_sending';
  const ready =
    AMOUNT.test(amount.trim()) &&
    /[1-9]/.test(amount) &&
    /^[A-Z0-9]{2,16}$/.test(asset) &&
    (!sentMoney || TRANSFER.test(transferId.trim()));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const ok = await send({
      when,
      amount: amount.trim(),
      assetId: asset,
      ...(sentMoney ? { transferId: transferId.trim() } : {}),
      contactedBy,
      ...(details.trim() ? { details: details.trim() } : {}),
    });
    if (ok) setDetails('');
  }

  return (
    <FlowTemplate
      title={t('scamTitle')}
      description={t('scamDescription')}
      state={safetyState(Boolean(userId), refusal, t, '/bank/safety/scam')}
      step={
        <div>
          {sent ? <Acknowledgement ack={sent} title={t('scamReceived')} live /> : null}
          <form aria-label={t('scamTitle')} onSubmit={(e) => void submit(e)}>
            <label className="field">
              <span>{t('scamWhenLabel')}</span>
              <select name="when" value={when} onChange={(e) => setWhen(e.target.value as SupportScamWhen)}>
                {WHEN.map(([value, key]) => (
                  <option key={value} value={value}>
                    {t(key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('scamAmountLabel')}</span>
              <input name="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('scamAssetLabel')}</span>
              <input name="asset" autoComplete="off" maxLength={16} value={assetId} onChange={(e) => setAssetId(e.target.value)} />
            </label>
            {sentMoney ? (
              <label className="field">
                <span>{t('scamTransferLabel')}</span>
                <input
                  name="transfer"
                  autoComplete="off"
                  maxLength={64}
                  value={transferId}
                  onChange={(e) => setTransferId(e.target.value)}
                  aria-describedby="scam-transfer-hint"
                />
                <small id="scam-transfer-hint">{t('scamTransferHint')}</small>
              </label>
            ) : null}
            <label className="field">
              <span>{t('scamContactLabel')}</span>
              <select name="contactedBy" value={contactedBy} onChange={(e) => setContactedBy(e.target.value as SupportScamContact)}>
                {CONTACT.map(([value, key]) => (
                  <option key={value} value={value}>
                    {t(key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('scamDetailsLabel')}</span>
              <textarea name="details" value={details} maxLength={5000} rows={5} onChange={(e) => setDetails(e.target.value)} />
            </label>
            <Button type="submit" variant="primary" loading={busy} disabled={busy || !ready}>
              {t('sendScamReport')}
            </Button>
          </form>
        </div>
      }
      summary={
        <div>
          <h2>{t('scamSummaryTitle')}</h2>
          <p>{t('scamSummaryStop')}</p>
          <p>{t('scamSummaryNever')}</p>
          <p>{t('scamSummaryOnce')}</p>
          <p>
            <a className="text-link" href="/help/mule-policy">
              {t('mulePolicyLink')}
            </a>
          </p>
          {userId ? (
            <EarlierAcknowledgements kind="scam" heading={t('yourScamReports')} none={t('noScamReports')} resource={earlier.resource} />
          ) : null}
        </div>
      }
    />
  );
}
