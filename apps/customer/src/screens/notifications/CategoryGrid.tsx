import { useId, useState } from 'react';
import { StateBlock, Switch } from './deps';
import { centreCopy } from './centre-copy';
import { CATEGORY_CHANNELS, CATEGORY_IDS, type CategoryChannel, type CategoryId, type CategoryPrefRow } from './notify-api';
import { useCategoryPrefs, type CategoryWrite } from './use-category-prefs';

const CATEGORY = {
  security: ['catSecurity', 'coverSecurity'],
  orders: ['catOrders', 'coverOrders'],
  price_alerts: ['catPriceAlerts', 'coverPriceAlerts'],
  promotions: ['catPromotions', 'coverPromotions'],
  news: ['catNews', 'coverNews'],
  status: ['catStatus', 'coverStatus'],
} as const satisfies Record<CategoryId, readonly [string, string]>;
const CHANNEL = { in_app: 'channelInbox', email: 'channelEmail', push: 'channelPush', sms: 'channelSms' } as const satisfies Record<
  CategoryChannel,
  string
>;

type CellKind = 'locked' | 'notConnected' | 'platformOff' | 'free';

/** Why a cell cannot be changed, in the order the person should read it: the platform first, then the rule that fixes it on. */
export function cellKind(row: CategoryPrefRow): CellKind {
  if (row.notConnected) return 'notConnected';
  if (!row.configured) return 'platformOff';
  if (row.locked) return 'locked';
  return 'free';
}

/**
 * Notification preferences by category and channel (`/notifications?view=settings`). Every cell is a real switch the service
 * stores; a cell that cannot be changed says why beside the switch (fixed on, channel not connected, not set up).
 */
export function CategoryGrid() {
  const copy = centreCopy.useCopy();
  const base = useId();
  const { load, reload, set } = useCategoryPrefs();
  const [notice, setNotice] = useState<CategoryWrite | null>(null);
  if (load.status === 'loading') return <StateBlock kind="loading" rows={4} rowHeight={48} label={copy.t('catTitle')} />;
  if (load.status === 'failed')
    return <StateBlock kind="error" title={copy.t('catLoadFailed')} onRetry={reload} retryLabel={copy.t('tryAgain')} />;
  return (
    <section aria-labelledby={`${base}-title`}>
      <h2 className="nf-h2" id={`${base}-title`}>
        {copy.t('catTitle')}
      </h2>
      <p className="nf-intro">{copy.t('catIntro')}</p>
      <CategoryTable rows={load.rows} onSet={(category, channel, enabled) => void set(category, channel, enabled).then(setNotice)} />
      <p className="nf-note" role="status">
        {notice === 'saved'
          ? copy.t('saved')
          : notice === 'locked'
            ? copy.t('catLockedWrite')
            : notice === 'failed'
              ? copy.t('saveFailed')
              : ''}
      </p>
    </section>
  );
}

/** The grid itself: one switch per category and channel, each with its reason when it cannot be changed. */
export function CategoryTable({
  rows,
  onSet,
}: {
  rows: readonly CategoryPrefRow[];
  onSet: (category: CategoryId, channel: CategoryChannel, enabled: boolean) => void;
}) {
  const copy = centreCopy.useCopy();
  const cell = (category: CategoryId, channel: CategoryChannel) => rows.find((row) => row.category === category && row.channel === channel);
  return (
    <div data-testid="nf-card" className="nf-card nf-tablewrap" role="region" aria-label={copy.t('catTitle')} tabIndex={0}>
      <table className="nf-table">
        <thead>
          <tr>
            <th scope="col">{copy.t('tableTopic')}</th>
            {CATEGORY_CHANNELS.map((channel) => (
              <th scope="col" key={channel}>
                {copy.t(CHANNEL[channel])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CATEGORY_IDS.map((category) => (
            <tr key={category}>
              <th scope="row">
                <span data-testid="nf-title" className="nf-title">
                  {copy.t(CATEGORY[category][0])}
                </span>
                <span data-testid="nf-body" className="nf-body nf-body--wrap">
                  {copy.t(CATEGORY[category][1])}
                </span>
              </th>
              {CATEGORY_CHANNELS.map((channel) => {
                const row = cell(category, channel);
                if (!row)
                  return (
                    <td key={channel}>
                      <span className="nf-pill">{copy.t('cellUnavailable')}</span>
                    </td>
                  );
                const kind = cellKind(row);
                const label = `${copy.t(CATEGORY[category][0])}, ${copy.t(CHANNEL[channel])}`;
                return (
                  <td key={channel}>
                    <Switch
                      aria-label={label}
                      checked={row.enabled}
                      disabled={kind !== 'free'}
                      onCheckedChange={(enabled: boolean) => onSet(category, channel, enabled)}
                    />
                    {kind === 'free' ? null : (
                      <span data-testid="nf-body" className="nf-body nf-body--wrap">
                        {copy.t(CELL_REASON[kind])}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CELL_REASON = {
  locked: 'cellFixedOn',
  notConnected: 'cellNotConnected',
  platformOff: 'cellPlatformOff',
} as const satisfies Record<Exclude<CellKind, 'free'>, string>;
