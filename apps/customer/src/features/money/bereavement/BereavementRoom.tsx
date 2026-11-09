import { useState, type FormEvent } from 'react';
import { Button } from '@intafaced/ui';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { SupportBereavementInput, SupportBereavementRelation } from '@intafaced/contracts/support-safety';
import { useSession } from '../../session/session';
import { safetyCopy, type SafetyCopyKey } from '../safety-copy';
import { Acknowledgement, EarlierAcknowledgements, safetyState, useMyAcknowledgements, useSafetySend } from '../safety-ack';

/**
 * Report a death (BK-safe-03, J-bank-18 #6), on the flow template. A family member, an executor or a law firm reports that
 * a customer has died; `support.safety.reportBereavement` opens one bereavement request on the support desk and
 * acknowledges it once with a reference. The acknowledgement is the same whether or not the named person had an account.
 */

const RELATIONS: readonly [SupportBereavementRelation, Extract<SafetyCopyKey, `relation${string}`>][] = [
  ['spouse_or_partner', 'relationSpouse'],
  ['child', 'relationChild'],
  ['parent', 'relationParent'],
  ['sibling', 'relationSibling'],
  ['executor', 'relationExecutor'],
  ['law_firm', 'relationLawFirm'],
  ['other', 'relationOther'],
];

const EMPTY = { deceasedName: '', deceasedContact: '', dateOfDeath: '', reporterName: '', reporterContact: '', details: '' };

export function BereavementRoom() {
  const { t } = safetyCopy.useCopy();
  const { userId } = useSession();
  const [form, setForm] = useState(EMPTY);
  const [relation, setRelation] = useState<SupportBereavementRelation>('spouse_or_partner');
  const { send, busy, sent, refusal } = useSafetySend<Omit<SupportBereavementInput, 'requestKey'>>(
    'bereavement',
    'safety.reportBereavement',
  );
  const earlier = useMyAcknowledgements('bereavement', sent?.id ?? null);
  const set = (name: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const ready =
    form.deceasedName.trim().length >= 2 &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.dateOfDeath) &&
    form.reporterName.trim().length >= 2 &&
    form.reporterContact.trim().length >= 3;
  const today = new Date().toISOString().slice(0, 10);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const optional = (v: string) => (v.trim() ? v.trim() : undefined);
    const ok = await send({
      deceasedName: form.deceasedName.trim(),
      dateOfDeath: form.dateOfDeath,
      relation,
      reporterName: form.reporterName.trim(),
      reporterContact: form.reporterContact.trim(),
      ...(optional(form.deceasedContact) ? { deceasedContact: optional(form.deceasedContact) } : {}),
      ...(optional(form.details) ? { details: optional(form.details) } : {}),
    });
    if (ok) setForm(EMPTY);
  }

  return (
    <FlowTemplate
      title={t('bereavementTitle')}
      description={t('bereavementDescription')}
      state={safetyState(Boolean(userId), refusal, t, '/bank/safety/bereavement')}
      step={
        <div>
          {sent ? <Acknowledgement ack={sent} title={t('reportReceived')} live /> : null}
          <form aria-label={t('bereavementTitle')} onSubmit={(e) => void submit(e)}>
            <label className="field">
              <span>{t('deceasedNameLabel')}</span>
              <input name="deceasedName" value={form.deceasedName} maxLength={200} autoComplete="off" onChange={set('deceasedName')} />
            </label>
            <label className="field">
              <span>{t('deceasedContactLabel')}</span>
              <input
                name="deceasedContact"
                value={form.deceasedContact}
                maxLength={200}
                autoComplete="off"
                onChange={set('deceasedContact')}
              />
            </label>
            <label className="field">
              <span>{t('dateOfDeathLabel')}</span>
              <input name="dateOfDeath" type="date" max={today} value={form.dateOfDeath} onChange={set('dateOfDeath')} />
            </label>
            <label className="field">
              <span>{t('relationLabel')}</span>
              <select name="relation" value={relation} onChange={(e) => setRelation(e.target.value as SupportBereavementRelation)}>
                {RELATIONS.map(([value, key]) => (
                  <option key={value} value={value}>
                    {t(key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('reporterNameLabel')}</span>
              <input name="reporterName" value={form.reporterName} maxLength={200} autoComplete="name" onChange={set('reporterName')} />
            </label>
            <label className="field">
              <span>{t('reporterContactLabel')}</span>
              <input
                name="reporterContact"
                value={form.reporterContact}
                maxLength={200}
                autoComplete="email"
                aria-describedby="bereavement-contact-hint"
                onChange={set('reporterContact')}
              />
              <small id="bereavement-contact-hint">{t('reporterContactHint')}</small>
            </label>
            <label className="field">
              <span>{t('bereavementDetailsLabel')}</span>
              <textarea name="details" value={form.details} maxLength={5000} rows={4} onChange={set('details')} />
            </label>
            <Button type="submit" variant="primary" loading={busy} disabled={busy || !ready}>
              {t('sendReport')}
            </Button>
          </form>
        </div>
      }
      summary={
        <div>
          <h2>{t('bereavementSummaryTitle')}</h2>
          <p>{t('bereavementSummaryCase')}</p>
          <p>{t('bereavementSummaryPrivacy')}</p>
          <p>{t('bereavementSummaryMoney')}</p>
          {userId ? (
            <EarlierAcknowledgements kind="bereavement" heading={t('yourReports')} none={t('noReports')} resource={earlier.resource} />
          ) : null}
        </div>
      }
    />
  );
}
