import './more.css';
import type { ScreenProps } from '../../app/screen-types';
import { moreCopy } from './copy';
import { visibleSections } from './tiles';

/** More (UI-SPEC 5.11): the pages that don't have a tab of their own, as tiles. Only live ones are drawn. */
export default function MoreScreen(_props: ScreenProps) {
  const { t } = moreCopy.useCopy();
  return (
    <div className="if-more">
      <h1 className="more-title">{t('More')}</h1>
      {visibleSections().map(({ section, tiles }) => (
        <section key={section} className="more-section" aria-labelledby={`more-${section}`}>
          <h2 className="more-h2" id={`more-${section}`}>
            {t(section)}
          </h2>
          <ul className="more-grid">
            {tiles.map(({ id, href, icon: Icon, title, line }) => (
              <li key={id}>
                <a className="more-tile" href={href} data-tile={id}>
                  <span className="more-tile__icon" aria-hidden="true">
                    <Icon size={24} strokeWidth={1.75} />
                  </span>
                  <span className="more-tile__text">
                    <span className="more-tile__title">{t(title)}</span>
                    <span className="more-tile__line">{t(line)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
