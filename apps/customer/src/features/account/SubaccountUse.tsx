import { useState } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { defineCopy } from '../../shared/i18n';
import { Button } from '../../shared/ui';

const copy = defineCopy('account.subaccounts.use', {
  use: 'Use this sub-account',
  useTarget: 'Use sub-account {id}',
  using: 'In use in this tab',
  refused: 'This sub-account can’t be used now.',
  reference: 'Reference {code}',
});

/**
 * Act as one live sub-account in this tab (I-account-lifecycle-04). Identity issues a token on this session that names
 * the sub-account; every service then answers as that sub-account. A refusal changes nothing and says so.
 */
export function SubaccountUse({ subAccountId }: { subAccountId: string }) {
  const { t } = copy.useCopy();
  const { session, enterSubAccount } = useSession();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  if (session?.subAccountId === subAccountId) return <span className="subaccounts__status">{t('using')}</span>;
  async function use() {
    setBusy(true);
    setRefused(null);
    const result = await enterSubAccount(subAccountId);
    setBusy(false);
    if (!result.ok) setRefused(result);
  }
  return (
    <>
      <Button
        variant="secondary"
        aria-label={t('useTarget', { id: subAccountId })}
        disabled={busy || !session || Boolean(session.subAccountId)}
        onClick={() => void use()}
      >
        {t('use')}
      </Button>
      {refused && (
        <p role="alert" className="notice">
          {t('refused')} <span lang="und">{refused.message}</span>{' '}
          {refused.code && <span lang="zxx">{t('reference', { code: refused.code })}</span>}
        </p>
      )}
    </>
  );
}
