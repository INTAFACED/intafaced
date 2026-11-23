import { newsCopy } from './news-copy';
import './news.css';

/** The feed.news notice in the chart's news widget (the old look; the News and Calendar rooms draw theirs from the kit). */
export function NewsNotice({ text }: { text: string }) {
  const { t } = newsCopy.useCopy();
  return (
    <div className="news-notice" role="status">
      <strong>{t('noticeTitle')}</strong>
      <p>{text}</p>
      <p className="lt-muted">
        {t('code')}: <code>{t('feedCode')}</code>
      </p>
    </div>
  );
}
