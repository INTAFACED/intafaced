import { useId } from 'react';
import { Switch } from './deps';
import { centreCopy } from './centre-copy';
import { CATEGORIES, OUT_OF_APP, channelState, type Category, type ChannelState } from './prefs';
import type { ChannelView } from './use-centre';
import type { OutOfApp } from './prefs';

const TOPIC = {
  trading: 'topicTrading',
  p2p: 'topicP2p',
  account: 'topicAccount',
  money: 'topicMoney',
  token: 'topicToken',
  agents: 'topicAgents',
} as const satisfies Record<Category, string>;
const COVER = {
  trading: 'coverTrading',
  p2p: 'coverP2p',
  account: 'coverAccount',
  money: 'coverMoney',
  token: 'coverToken',
  agents: 'coverAgents',
} as const satisfies Record<Category, string>;
const CELL = {
  always: 'cellAlways',
  on: 'cellOn',
  muted: 'cellMuted',
  platformOff: 'cellPlatformOff',
  noTarget: 'cellNoTarget',
  unverified: 'cellUnverified',
} as const satisfies Record<ChannelState, string>;
const CHANNEL = { email: 'channelEmail', push: 'channelPush', sms: 'channelSms' } as const;

/**
 * Topics by channel. Each cell shows what an ordinary update of that topic will do on that channel today. The service holds one
 * setting per channel, not per topic, so the cells are a read-out and the per-topic switch is shown off with the reason.
 */
export function TopicTable({ channels }: { channels: Record<OutOfApp, ChannelView> }) {
  const copy = centreCopy.useCopy();
  const base = useId();
  return (
    <section aria-labelledby={`${base}-title`}>
      <h2 className="nf-h2" id={`${base}-title`}>
        {copy.t('tableTitle')}
      </h2>
      <p className="nf-intro">{copy.t('tableIntro')}</p>
      <div className="nf-card nf-tablewrap" role="region" aria-label={copy.t('tableTitle')} tabIndex={0}>
        <table className="nf-table">
          <thead>
            <tr>
              <th scope="col">{copy.t('tableTopic')}</th>
              <th scope="col">{copy.t('channelInbox')}</th>
              {OUT_OF_APP.map((channel) => (
                <th scope="col" key={channel}>
                  {copy.t(CHANNEL[channel])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((category) => (
              <tr key={category}>
                <th scope="row">
                  <span className="nf-title">{copy.t(TOPIC[category])}</span>
                  <span className="nf-body nf-body--wrap">{copy.t(COVER[category])}</span>
                </th>
                <td>
                  <span className="nf-pill nf-pill--ok">{copy.t(CELL.always)}</span>
                </td>
                {OUT_OF_APP.map((channel) => {
                  const state = channelState(channel, channels[channel].facts);
                  return (
                    <td key={channel}>
                      <span className={`nf-pill${state === 'on' ? ' nf-pill--ok' : ''}`}>{copy.t(CELL[state])}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="nf-offrow">
        <span className="nf-text">
          <span className="nf-title" id={`${base}-pertopic`}>
            {copy.t('perTopicTitle')}
          </span>
          <span className="nf-body nf-body--wrap" id={`${base}-pertopic-why`}>
            {copy.t('perTopicReason')}
          </span>
        </span>
        <Switch aria-labelledby={`${base}-pertopic`} aria-describedby={`${base}-pertopic-why`} checked={false} disabled />
      </div>
      <p className="nf-note">{copy.t('urgentNote')}</p>
    </section>
  );
}
