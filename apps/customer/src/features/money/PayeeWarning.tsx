import { useState } from 'react';
import { Button } from '../../shared/ui';
import { supportPayeeWarningSchema, type SupportPayeeWarning } from '@intafaced/contracts/support-safety';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';
import { safetyCopy } from './safety-copy';

/**
 * The scam warning on a first-time payee (BK-safe-02, J-bank-18 #2), under the payee in a transfer. It shows with the link
 * to the scam guide until the person reads it for that payee ("I understand", `support.safety.payeeWarningSeen`); after
 * that, reviewing the same payee shows it no more, on any device. It never blocks the transfer. If the warning cannot be
 * read, the page says so rather than showing nothing.
 */
export function PayeeWarning({ payeeId }: { payeeId: string }) {
  const { t } = safetyCopy.useCopy();
  const { api, userId } = useSession();
  const [seen, setSeen] = useState<SupportPayeeWarning | null>(null);
  const [busy, setBusy] = useState(false);
  const warning = useResource(
    (signal) => api.query('support', 'safety.payeeWarning', { payeeId }, supportPayeeWarningSchema, { signal }),
    `payee-warning:${userId ?? 'out'}:${payeeId}`,
  );
  if (seen?.payeeId === payeeId) return null;
  if (warning.resource.status === 'loading') return null;
  if (warning.resource.status === 'failed')
    return (
      <p role="alert" data-testid="payee-warning-failed">
        {t('payeeWarningFailed')}
      </p>
    );
  const current = warning.resource.data;
  if (!current.show) return null;
  async function read() {
    setBusy(true);
    const out = await api.mutate('support', 'safety.payeeWarningSeen', { payeeId }, supportPayeeWarningSchema);
    setBusy(false);
    if (out.ok) setSeen(out.data);
  }
  return (
    <section role="alert" aria-label={t('payeeWarningTitle')} data-testid="payee-warning">
      <h3>{t('payeeWarningTitle')}</h3>
      <p>{t('payeeWarningBody')}</p>
      <a href={current.guideHref}>{t('payeeWarningGuide')}</a>{' '}
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void read()}>
        {t('payeeWarningSeen')}
      </Button>
    </section>
  );
}
