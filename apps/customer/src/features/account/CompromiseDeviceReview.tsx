import { useState } from 'react';
import { compromiseReviewOutputSchema } from '@intafaced/contracts/identity-compromise';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { Button, Failure } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { defineCopy } from '../../shared/i18n';
import { useCompromiseCase } from './Compromised';

const copy = defineCopy('account.compromise-devices', {
  title: 'Your compromised-account case',
  body: 'Go through the devices above. End any you do not know, then say you reviewed them. Your case checklist ticks this item.',
  ask: 'I reviewed these devices',
  reviewed: 'Reviewed on {date}.',
  back: 'Back to your case',
});

/**
 * Beside the devices list on Security, only while a compromised-account case is open (J-identity-13 #4): the person says
 * they reviewed their devices, and identity records it on the case, whose checklist then shows the item done.
 */
export function CompromiseDeviceReview() {
  const { t, languageFor } = copy.useCopy();
  const { api } = useSession();
  const { timeZone } = usePreferences();
  const { resource, reload } = useCompromiseCase();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const open = resource.status === 'ready' ? resource.data?.case : null;
  if (!open) return null;
  const doneAt = open.checklist.find((entry) => entry.item === 'devices')?.doneAt ?? null;

  async function review() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await api.mutate('identity', 'account.compromised.markReviewed', { item: 'devices' }, compromiseReviewOutputSchema);
      if (!answer.ok) return setFailure(answer);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="devices"
      data-testid="devices__compromise-review"
      className="security__card"
      aria-labelledby="devices-compromise-review"
      lang={languageFor('title')}
    >
      <h2 id="devices-compromise-review">{t('title')}</h2>
      {failure && <Failure result={failure} />}
      {doneAt ? (
        <p role="status">{t('reviewed', { date: stamp(doneAt, timeZone) })}</p>
      ) : (
        <>
          <p>{t('body')}</p>
          <Button disabled={busy} onClick={() => void review()}>
            {t('ask')}
          </Button>
        </>
      )}
      <p>
        <a className="text-link" href="/uc/safe/compromised">
          {t('back')}
        </a>
      </p>
    </section>
  );
}
