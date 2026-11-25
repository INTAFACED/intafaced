import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { readPayees } from '../../features/money';
import { commandCopy } from './command-copy';
import { isHiddenPath } from './deps';
import { Widget } from './Pinned';

// Loaded on its own (index.tsx imports it lazily): the money feature's entry stays out of Home's first load
// (src/data/core-imports.test.ts).
/** Send to: the people this person saved on this device (the payee book), each opening Send with them filled in. */
export default function SendTo({ userId }: { userId: string | null }) {
  const { t } = commandCopy.useCopy();
  const payees = useMemo(() => (userId ? readPayees(userId).slice(0, 4) : []), [userId]);
  if (isHiddenPath('/pay/send')) return null;
  return (
    <Widget id="send-to" title={t('Send to')} testId="home-send-to">
      <ul className="hm-people">
        <li>
          <a className="hm-person" data-new="" href="/pay/send" aria-label={t('Send to new')}>
            <Plus size={16} aria-hidden="true" />
          </a>
        </li>
        {payees.map((payee) => (
          <li key={payee.userId}>
            <a
              className="hm-person"
              href={`/pay/send?to=${encodeURIComponent(payee.handle)}`}
              aria-label={t('Send to {handle}', { handle: payee.handle })}
              title={payee.handle}
            >
              {payee.handle.slice(0, 1).toUpperCase()}
            </a>
          </li>
        ))}
      </ul>
      {payees.length === 0 ? <p className="lt-hint">{t('Send to none')}</p> : null}
    </Widget>
  );
}
