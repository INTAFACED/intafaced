import type { ReactNode } from 'react';
import { StatusTag } from '@intafaced/ui';
import { chromeCopy } from './copy';
import './chrome.css';

/**
 * The one treatment for a feature that has not launched: a calm card with a short plain line on what it will do.
 * `page` fills a whole page that has no data source yet; `section` is one part of a page. Real permission refusals
 * do not use it; they keep the refusal wording. It is never a fake list row.
 */
export function ComingSoonCard({
  title,
  variant = 'section',
  children,
}: {
  title?: string;
  variant?: 'page' | 'section';
  children?: ReactNode;
}) {
  const { t } = chromeCopy.useCopy();
  const heading = title ?? (variant === 'page' ? t('comingSoonPage') : undefined);
  return (
    <section className={`pfo-soon${variant === 'page' ? ' pfo-soon--page' : ''}`} aria-label={heading ?? t('comingSoon')}>
      <StatusTag status="working" label={t('comingSoon')} />
      {heading && <h3>{heading}</h3>}
      <p>{children ?? (variant === 'page' ? t('comingSoonPageBody') : t('comingSoonDefault'))}</p>
    </section>
  );
}
