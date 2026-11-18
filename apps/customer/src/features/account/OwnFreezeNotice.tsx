import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { selfFreezeCopy as copy } from './self-freeze-copy';
import { freezeStatus } from './self-freeze';

/**
 * The owner's own freeze, said where their money is shown (J-wallet-13 #3): while it holds, INTAFACED takes no action for
 * them, and their funds stay in their own wallet and venue account, which only their wallet controls. Read from
 * svc-identity's `auth.selfFreezeStatus`; signed out, unfrozen or unread, it shows nothing (the wallet room's own reads
 * still answer for themselves).
 */
export function OwnFreezeNotice() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const status = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'auth.selfFreezeStatus', undefined, freezeStatus, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `self-freeze:${userId}`,
  );
  if (status.resource.status !== 'ready' || !status.resource.data?.frozen) return null;
  return (
    <section
      className="notice"
      role="status"
      data-testid="own-freeze-notice"
      aria-label={t('walletTitle')}
      lang={languageFor('walletTitle')}
    >
      <h2>{t('walletTitle')}</h2>
      <p>{t('walletBody')}</p>
      <p>
        <a className="text-link" href="/uc/safe">
          {t('walletLift')}
        </a>
      </p>
    </section>
  );
}
