import { Empty } from '../../volt/parts';
import { accountCopy } from '../account/copy';

/** Platform accounts only. Anyone else who opens the address is told what this page is, not shown a refusal. */
export function NotPlatform() {
  const { t } = accountCopy.useCopy();
  return (
    <Empty
      title={t('netNotPlatformTitle')}
      action={
        <a className="lt-link" href="/pay/merchant">
          {t('backOverview')}
        </a>
      }
    >
      {t('netNotPlatformBody')}
    </Empty>
  );
}
