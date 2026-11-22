import { useId, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { newsCopy } from './news-copy';

/**
 * A symbol's news widget on the chart. No vendor feed is connected and the store holds no items, so it shows the same
 * feed.news notice as the News room (the same words and code, drawn from the kit) and an honest empty list for the
 * symbol; it never shows a sample.
 */
export function NewsWidget({ symbol }: { symbol: string }) {
  const { t } = newsCopy.useCopy();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <>
      <Button aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((now) => !now)}>
        {open ? t('widgetClose') : t('widgetOpen')}
      </Button>
      {open ? (
        <section id={panelId} className="lt-region" aria-label={t('widgetTitle', { symbol })} data-testid="cw-news" data-symbol={symbol}>
          <h2 className="lt-refusal-title">{t('widgetTitle', { symbol })}</h2>
          <div className="lt-refusal" data-refusal="parked" role="status">
            <strong className="lt-refusal-title">{t('noticeTitle')}</strong>
            <p className="lt-refusal-body">{t('newsNotice')}</p>
            <p className="lt-ref">
              {t('code')}: <code>{t('feedCode')}</code>
            </p>
          </div>
          <p className="lt-description">{t('widgetEmpty', { symbol })}</p>
          <a className="lt-link" href="/trade/news">
            {t('widgetAll')}
          </a>
        </section>
      ) : null}
    </>
  );
}
