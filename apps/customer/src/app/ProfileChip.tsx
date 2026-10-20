import { useSession } from '../features/session/session';
import { accountMenuCopy } from './account-menu-copy';

/** Shown beside the account button while a business is in view, so the person always sees which profile they are using. */
export function ProfileChip() {
  const { profiles } = useSession();
  const copy = accountMenuCopy.useCopy();
  if (!profiles.business) return null;
  return (
    <a className="tb-profile-chip" href="/pay/merchant" aria-label={copy.t('chipLabel')} data-testid="profile-chip">
      {copy.t('chip', { name: profiles.business.name })}
    </a>
  );
}
