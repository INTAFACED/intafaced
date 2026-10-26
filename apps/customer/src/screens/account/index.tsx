import './account.css';
import type { ScreenProps } from '../../app/screen-types';
import { AccountRoutes } from '../../features/account/AccountRoutes';
import { accountScreenCopy } from './copy';
import { sectionFor, sections } from './sections';

/**
 * Account, Security, Verification and Display (UI-SPEC 5.13): a 220 px sub-nav and a 760 px column of panel cards.
 * The old views keep their data calls, guards and passkey logic; they render inside `.legacy-room` here, and
 * `account.css` lays them out as cards.
 */
export default function AccountScreen({ path, search }: ScreenProps) {
  const { t } = accountScreenCopy.useCopy();
  const here = sectionFor(path);
  return (
    <div data-testid="acct" className="acct" data-section={here}>
      <nav data-testid="acct-nav" className="acct-nav" aria-label={t('Settings sections')}>
        <p className="acct-nav__title">{t('Settings')}</p>
        <ul>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={section.href} aria-current={section.id === here ? 'page' : undefined}>
                {t(section.title)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div data-testid="acct-body" className="acct-body legacy-room">
        <AccountRoutes path={`${path}${search}`} />
      </div>
    </div>
  );
}
