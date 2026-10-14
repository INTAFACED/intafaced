import { ArrowUpRight } from 'lucide-react';
import { homeCopy } from './copy';
import { PreviewChip } from './Chip';
import { HOME_LINKS, isPreviewLink } from './links';

const TOPICS = [
  { title: 'Learn basics', body: 'Learn basics body' },
  { title: 'Learn safety', body: 'Learn safety body' },
  { title: 'Learn charts', body: 'Learn charts body' },
] as const;

/** A strip of three starting points that all open the Academy (its Preview while the Academy is not live). */
export function LearnStrip() {
  const { t } = homeCopy.useCopy();
  return (
    <section className="home-section" aria-labelledby="home-learn-title">
      <div className="home-section__head">
        <h2 className="home-h2" id="home-learn-title">
          {t('Learn')}
          {isPreviewLink(HOME_LINKS.academy) ? <PreviewChip /> : null}
        </h2>
        <a className="home-link" href={HOME_LINKS.academy}>
          {t('Open Academy')}
        </a>
      </div>
      <ul className="home-learn">
        {TOPICS.map((topic) => (
          <li key={topic.title}>
            <a className="home-learn__card" href={HOME_LINKS.academy}>
              <span className="home-learn__title">
                {t(topic.title)}
                <ArrowUpRight size={16} aria-hidden="true" />
              </span>
              <span className="home-learn__body">{t(topic.body)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
