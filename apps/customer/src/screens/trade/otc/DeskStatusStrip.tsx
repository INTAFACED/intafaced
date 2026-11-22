import { CircleCheck, CircleSlash } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Tag } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { DeskStatus } from '../rooms/api';
import { roomWords } from '../rooms/refusals';
import type { Loadable } from '../rooms/ui';
import { Refusal } from '../options/notices';
import { otcCopy } from './copy';

function Item({ label, on, onWord, offWord, why }: { label: string; on: boolean; onWord: string; offWord: string; why: ReactNode }) {
  return (
    <div className="lt-stack">
      <div className="lt-toolbar">
        {label}
        <Tag tone={on ? 'accent' : 'neutral'}>
          {on ? <CircleCheck size={12} aria-hidden="true" /> : <CircleSlash size={12} aria-hidden="true" />}
          {on ? onWord : offWord}
        </Tag>
      </div>
      <p className="lt-hint">{why}</p>
    </div>
  );
}

/** Before anything is typed: is the desk open to me, who prices, and is the mid price feed wired. */
export function DeskStatusStrip({ desk }: { desk: Loadable<DeskStatus> }) {
  const { t } = otcCopy.useCopy();
  if (desk.status === 'loading') return <Skeleton shape="figure" />;
  if (desk.status === 'refused') return <Refusal words={roomWords({ code: desk.code })} />;
  if (desk.status === 'error')
    return (
      <div className="lt-toolbar">
        <span className="lt-hint">{t('Desk status unreadable')}</span>
        <Button onClick={desk.retry}>{t('Try again')}</Button>
      </div>
    );
  if (desk.status === 'empty') return <p className="lt-hint">{t('Desk status empty')}</p>;
  const { published, makerRouting, midFeed, assets, minTier } = desk.data;
  const level = minTier === 'basic' || minTier === 'full' || minTier === 'institutional' ? minTier : null;
  return (
    <section aria-label={t('Desk status')} className="lt-figures">
      <Item
        label={t('Desk')}
        on={published}
        onWord={t('Open')}
        offWord={t('Closed')}
        why={published ? t('Desk open reason') : t('Desk closed reason')}
      />
      <Item
        label={t('Maker routing')}
        on={makerRouting?.published === true}
        onWord={t('Routed')}
        offWord={t('Platform only')}
        why={makerRouting?.published ? t('Routing on') : t('Routing off')}
      />
      <Item
        label={t('Mid feed')}
        on={midFeed?.published === true}
        onWord={t('Wired')}
        offWord={t('Not wired')}
        why={midFeed?.published ? t('Mid feed on') : t('Mid feed off')}
      />
      <Item
        label={t('Verification level')}
        on={level != null}
        onWord={level ? t(`Level ${level}`) : ''}
        offWord={t('Not set')}
        why={level ? t('Level on reason') : t('Level off reason')}
      />
      <section aria-label={t('Assets on the desk')} className="lt-stack">
        <div>{t('Assets on the desk')}</div>
        {assets?.length ? (
          <ul className="lt-list">
            {assets.map((asset) => (
              <li key={asset}>
                <Tag tone="neutral">{asset}</Tag>
              </li>
            ))}
          </ul>
        ) : (
          <span>
            <Tag tone="neutral">
              <CircleSlash size={12} aria-hidden="true" />
              {t('Not set')}
            </Tag>
          </span>
        )}
        <p className="lt-hint">{assets?.length ? t('Assets on reason') : t('Assets off reason')}</p>
      </section>
    </section>
  );
}
