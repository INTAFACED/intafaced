import { CircleCheck, CircleSlash } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DeskStatus } from '../rooms/api';
import { roomWords } from '../rooms/refusals';
import { Refusal } from '../rooms/RoomNotices';
import { Badge, Button, Skeleton, type Loadable } from '../rooms/ui';
import { otcCopy } from './copy';

function Item({ label, on, onWord, offWord, why }: { label: string; on: boolean; onWord: string; offWord: string; why: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-center gap-2 text-sm text-fg-2">
        {label}
        <Badge
          tone={on ? 'lime' : 'warn'}
          variant="outline"
          density="dense"
          icon={on ? <CircleCheck size={12} /> : <CircleSlash size={12} />}
        >
          {on ? onWord : offWord}
        </Badge>
      </div>
      <p className="m-0 max-w-[48ch] text-xs text-fg-2">{why}</p>
    </div>
  );
}

/** Before anything is typed: is the desk open to me, who prices, and is the mid price feed wired. */
export function DeskStatusStrip({ desk }: { desk: Loadable<DeskStatus> }) {
  const { t } = otcCopy.useCopy();
  if (desk.status === 'loading') return <Skeleton className="h-12 w-full" />;
  if (desk.status === 'refused') return <Refusal words={roomWords({ code: desk.code })} size="inline" />;
  if (desk.status === 'error')
    return (
      <div className="flex items-center gap-3 text-sm text-fg-2">
        {t('Desk status unreadable')}
        <Button variant="secondary" size={28} onClick={desk.retry}>
          {t('Try again')}
        </Button>
      </div>
    );
  if (desk.status === 'empty') return <p className="m-0 text-sm text-fg-2">{t('Desk status empty')}</p>;
  const { published, makerRouting, midFeed, assets } = desk.data;
  return (
    <section aria-label={t('Desk status')} className="flex flex-wrap gap-x-8 gap-y-3 rounded-md border border-line bg-panel p-3">
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
      <section aria-label={t('Assets on the desk')} className="flex min-w-0 flex-col gap-0.5">
        <div className="text-sm text-fg-2">{t('Assets on the desk')}</div>
        {assets?.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {assets.map((asset) => (
              <li key={asset}>
                <Badge tone="neutral" variant="outline" density="dense">
                  {asset}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Badge tone="warn" variant="outline" density="dense" icon={<CircleSlash size={12} />}>
            {t('Not set')}
          </Badge>
        )}
        <p className="m-0 max-w-[48ch] text-xs text-fg-2">{assets?.length ? t('Assets on reason') : t('Assets off reason')}</p>
      </section>
    </section>
  );
}
