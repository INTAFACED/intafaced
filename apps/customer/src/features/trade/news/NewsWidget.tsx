import { useId, useState } from 'react';
import { newsCopy } from './news-copy';
import { NewsNotice } from './NewsRooms';

/**
 * A symbol's news widget on the chart. No vendor feed is connected and the store holds no items, so it shows the same
 * feed.news notice as the News room and an honest empty list for the symbol; it never shows a sample.
 */
export function NewsWidget({ symbol }: { symbol: string }) {
  const { t } = newsCopy.useCopy();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((now) => !now)}>
        {open ? t('widgetClose') : t('widgetOpen')}
      </button>
      {open ? (
        <section id={panelId} className="news-widget" aria-label={t('widgetTitle', { symbol })} data-testid="cw-news" data-symbol={symbol}>
          <h2>{t('widgetTitle', { symbol })}</h2>
          <NewsNotice text={t('newsNotice')} />
          <p className="muted">{t('widgetEmpty', { symbol })}</p>
          <a className="text-link" href="/trade/news">
            {t('widgetAll')}
          </a>
        </section>
      ) : null}
    </>
  );
}
