import './more.css';
import type { ScreenProps } from '../../app/screen-types';
import { moreCopy } from './copy';
import { doorLabel, roomTitle } from '../../app/navigation';
import { usePreferences } from '../../shared/preferences';
import { allServices, visibleSections, type ServiceGroupId } from './tiles';

/** More (UI-SPEC 5.11): the pages that don't have a tab of their own, as tiles. Only live ones are drawn. */
export default function MoreScreen(_props: ScreenProps) {
  const { t } = moreCopy.useCopy();
  const { language } = usePreferences();
  const groupLabel = (id: ServiceGroupId) => (id === 'Account' || id === 'Web3' || id === 'Information' ? t(id) : doorLabel(id, language));
  return (
    <div className="if-more">
      <h1 data-testid="more-title" className="more-title">
        {t('More')}
      </h1>
      {visibleSections().map(({ section, tiles }) => (
        <section key={section} className="more-section" aria-labelledby={`more-${section}`}>
          <h2 data-testid="more-h2" className="more-h2" id={`more-${section}`}>
            {t(section)}
          </h2>
          <ul className="more-hub-grid">
            {tiles.map(({ id, href, icon: Icon, title, line }) => (
              <li key={id}>
                <a data-testid="more-tile" className="more-tile" href={href} data-tile={id}>
                  <span data-testid="more-tile__icon" className="more-tile__icon" aria-hidden="true">
                    <Icon size={24} strokeWidth={1.75} />
                  </span>
                  <span className="more-tile__text">
                    <span data-testid="more-tile__title" className="more-tile__title">
                      {t(title)}
                    </span>
                    <span data-testid="more-tile__line" className="more-tile__line">
                      {t(line)}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section className="more-section" aria-labelledby="more-all-services">
        <h2 data-testid="more-h2" className="more-h2" id="more-all-services">
          {t('All services')}
        </h2>
        <p className="more-note">{t('Every page in the app, by area')}</p>
        <div className="more-index">
          {allServices().map(({ id, rooms }) => (
            <section key={id} aria-labelledby={`more-index-${id}`}>
              <h3 className="more-h3" id={`more-index-${id}`}>
                {groupLabel(id)}
              </h3>
              <ul>
                {rooms.map((room) => (
                  <li key={room.path}>
                    <a href={room.path} data-service={room.path}>
                      {roomTitle(room, language)}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
